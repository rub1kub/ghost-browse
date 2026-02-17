#!/usr/bin/env node
/**
 * pdf-extract.mjs — Download and extract text from PDFs and files
 * Usage:
 *   node pdf-extract.mjs "https://example.com/file.pdf"
 *   node pdf-extract.mjs "https://example.com/file.pdf" --max 5000
 *   node pdf-extract.mjs "https://example.com/file.pdf" --json
 */
import { execSync } from 'child_process';
import { writeFileSync, readFileSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';

const __dir = dirname(fileURLToPath(import.meta.url));
const DOWNLOADS_DIR = join(__dir, '.downloads');

function getArg(args, name, def) {
  const i = args.indexOf(`--${name}`);
  if (i !== -1 && args[i + 1] && !args[i + 1].startsWith('--')) return args[i + 1];
  return def;
}

async function downloadFile(url) {
  mkdirSync(DOWNLOADS_DIR, { recursive: true });
  const hash = createHash('md5').update(url).digest('hex').slice(0, 8);
  const ext = url.match(/\.([a-z0-9]{2,5})(\?|$)/i)?.[1] || 'pdf';
  const filename = `${hash}.${ext}`;
  const filepath = join(DOWNLOADS_DIR, filename);

  if (existsSync(filepath)) return filepath;

  console.log(`📥 Downloading: ${url}`);
  execSync(`curl -sL -o "${filepath}" "${url}"`, { timeout: 30000 });
  return filepath;
}

function extractPdfText(filepath) {
  // Try pdftotext first (poppler-utils)
  try {
    return execSync(`pdftotext "${filepath}" -`, { encoding: 'utf8', timeout: 15000 }).trim();
  } catch {}

  // Try python with PyPDF2/pdfplumber
  try {
    return execSync(`python3 -c "
import sys
try:
    import pdfplumber
    with pdfplumber.open('${filepath}') as pdf:
        text = '\\n'.join(page.extract_text() or '' for page in pdf.pages)
        print(text)
except ImportError:
    try:
        from PyPDF2 import PdfReader
        reader = PdfReader('${filepath}')
        text = '\\n'.join(page.extract_text() or '' for page in reader.pages)
        print(text)
    except ImportError:
        print('[ERROR: Install pdftotext (poppler-utils) or pdfplumber]')
"`, { encoding: 'utf8', timeout: 30000 }).trim();
  } catch {}

  // Fallback: strings command
  try {
    return execSync(`strings "${filepath}" | head -500`, { encoding: 'utf8', timeout: 5000 }).trim();
  } catch {}

  return '[Could not extract text from PDF]';
}

function extractDocText(filepath) {
  // Try python-docx
  try {
    return execSync(`python3 -c "
from docx import Document
doc = Document('${filepath}')
print('\\n'.join(p.text for p in doc.paragraphs))
"`, { encoding: 'utf8', timeout: 15000 }).trim();
  } catch {}

  // Fallback: antiword or catdoc
  try { return execSync(`antiword "${filepath}"`, { encoding: 'utf8', timeout: 5000 }).trim(); } catch {}
  try { return execSync(`catdoc "${filepath}"`, { encoding: 'utf8', timeout: 5000 }).trim(); } catch {}

  return '[Could not extract text from document]';
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const url = args.find(a => !a.startsWith('--'));
const maxChars = parseInt(getArg(args, 'max', '10000'));
const jsonOut = args.includes('--json');
const keepFile = args.includes('--keep');

if (!url) {
  console.log(`
pdf-extract.mjs — Download and extract text from PDFs and documents

Usage:
  node pdf-extract.mjs "https://example.com/file.pdf" [--max 10000] [--json] [--keep]

Supports: PDF, DOC, DOCX, TXT
Requires: pdftotext (poppler-utils) for PDFs

Examples:
  node pdf-extract.mjs "https://arxiv.org/pdf/2301.12345.pdf"
  node pdf-extract.mjs "https://site.com/report.pdf" --max 5000 --json
`);
  process.exit(0);
}

const filepath = await downloadFile(url);
const ext = filepath.split('.').pop().toLowerCase();

let text;
if (ext === 'pdf') text = extractPdfText(filepath);
else if (ext === 'docx' || ext === 'doc') text = extractDocText(filepath);
else text = readFileSync(filepath, 'utf8');

const truncated = text.slice(0, maxChars);

if (jsonOut) {
  console.log(JSON.stringify({ url, filepath, chars: text.length, content: truncated }));
} else {
  console.log(`\n📄 ${basename(filepath)} (${text.length} chars)`);
  console.log(`🔗 ${url}\n`);
  console.log(truncated);
  if (text.length > maxChars) console.log(`\n... [truncated at ${maxChars} chars, total ${text.length}]`);
}

if (!keepFile) {
  try { unlinkSync(filepath); } catch {}
}
