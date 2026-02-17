#!/usr/bin/env node
/**
 * research.mjs — Search + read + summarize in one command
 * Usage: node research.mjs "topic" [--limit 5] [--engine google|ddg|bing] [--max 3000] [--json]
 */
process.env.DISPLAY = process.env.DISPLAY || ':99';

import { chromium } from 'playwright';
import { execSync } from 'child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const REAL_USER_DATA = '/home/openclawd/.openclaw/browser/openclaw/user-data';

function getArg(args, name, def) {
  const i = args.indexOf(`--${name}`);
  if (i !== -1 && args[i + 1] && !args[i + 1].startsWith('--')) return args[i + 1];
  const eq = args.find(a => a.startsWith(`--${name}=`));
  if (eq) return eq.split('=').slice(1).join('=');
  return def;
}

async function launchContext() {
  const tmp = mkdtempSync(`${tmpdir()}/ghost-research-`);
  execSync(`cp -r "${REAL_USER_DATA}/." "${tmp}" 2>/dev/null; rm -f "${tmp}/SingletonLock" "${tmp}/SingletonCookie" "${tmp}/SingletonSocket"`, { timeout: 15000 });
  const ctx = await chromium.launchPersistentContext(tmp, {
    headless: false,
    executablePath: '/usr/bin/google-chrome-stable',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--no-first-run'],
    env: { ...process.env, DISPLAY: process.env.DISPLAY },
    viewport: { width: 1440, height: 900 },
  });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
  });
  const origClose = ctx.close.bind(ctx);
  ctx.close = async () => { await origClose(); try { rmSync(tmp, { recursive: true, force: true }); } catch {} };
  return ctx;
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

async function searchDDG(page, query) {
  await page.goto(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await new Promise(r => setTimeout(r, 1500));
  const raw = await page.evaluate(() => {
    const items = [];
    document.querySelectorAll('.result').forEach(el => {
      const t = el.querySelector('.result__title a, .result__a, h2 a');
      const s = el.querySelector('.result__snippet');
      if (t) items.push({ title: t.textContent.trim(), url: t.href, snippet: s?.textContent?.trim() || '' });
    });
    return items;
  });
  return raw.map(r => { try { const m = r.url.match(/uddg=([^&]+)/); if (m) r.url = decodeURIComponent(m[1]); } catch {} return r; }).filter(r => r.url && !r.url.includes('duckduckgo.com'));
}

async function searchGoogle(page, query) {
  await page.goto(`https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await new Promise(r => setTimeout(r, 2000));
  // Dismiss cookie banner
  for (const sel of ['#L2AGLb', 'button[aria-label*="Reject"]']) { try { const b = await page.$(sel); if (b) { await b.click(); await new Promise(r => setTimeout(r, 800)); } } catch {} }
  await new Promise(r => setTimeout(r, 1000));
  return await page.evaluate(() => {
    const items = [];
    document.querySelectorAll('h3').forEach(h3 => {
      const link = h3.closest('a');
      if (!link?.href || link.href.includes('google.com')) return;
      const container = h3.closest('[data-ved], .g') || h3.parentElement?.parentElement;
      const snippet = container?.querySelector('.VwiC3b, .yDYNvb')?.textContent?.trim() || '';
      items.push({ title: h3.textContent.trim(), url: link.href, snippet });
    });
    return items;
  });
}

async function fetchPageContent(page, url, maxChars = 4000) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await new Promise(r => setTimeout(r, 1500));
    const result = await page.evaluate(() => {
      const bodyClone = document.body.cloneNode(true);
      ['script','style','nav','footer','header','aside','iframe','noscript'].forEach(tag => bodyClone.querySelectorAll(tag).forEach(el => el.remove()));
      return { title: document.title, html: bodyClone.innerHTML };
    });
    const text = htmlToText(result.html).slice(0, maxChars);
    return { title: result.title, content: text, url };
  } catch (e) {
    return { title: 'Error', content: `[Failed: ${e.message.slice(0, 100)}]`, url, error: true };
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const query = args.find(a => !a.startsWith('--'));
const limit = parseInt(getArg(args, 'limit', '5'));
const engine = getArg(args, 'engine', 'ddg');
const maxChars = parseInt(getArg(args, 'max', '3000'));
const jsonOut = args.includes('--json');
const concurrency = parseInt(getArg(args, 'concurrency', '3'));

if (!query) {
  console.log(`
research.mjs — Search + read top results in one command

Usage: node research.mjs "topic" [--limit 5] [--engine google|ddg] [--max 3000] [--concurrency 3] [--json]

Examples:
  node research.mjs "TON blockchain news 2026"
  node research.mjs "best Node.js frameworks" --engine google --limit 10
  node research.mjs "AI regulation EU" --json
`);
  process.exit(0);
}

console.log(`\n🔍 Researching: "${query}" [${engine}] — reading top ${limit} results...\n`);

const ctx = await launchContext();
const searchPage = await ctx.newPage();

// Step 1: Search
let searchResults;
if (engine === 'google') searchResults = await searchGoogle(searchPage, query);
else searchResults = await searchDDG(searchPage, query);

const urls = searchResults.slice(0, limit);
console.log(`Found ${searchResults.length} results, reading top ${urls.length}...\n`);
await searchPage.close();

// Step 2: Fetch pages in parallel (batched)
const allResults = [];
for (let i = 0; i < urls.length; i += concurrency) {
  const batch = urls.slice(i, i + concurrency);
  const fetched = await Promise.allSettled(batch.map(async (sr) => {
    const page = await ctx.newPage();
    const result = await fetchPageContent(page, sr.url, maxChars);
    await page.close();
    return { ...sr, ...result };
  }));
  fetched.forEach(r => {
    if (r.status === 'fulfilled') allResults.push(r.value);
    else allResults.push({ error: true, content: r.reason?.message });
  });
}

await ctx.close();

// Step 3: Output
if (jsonOut) {
  console.log(JSON.stringify(allResults, null, 2));
} else {
  allResults.forEach((r, i) => {
    console.log(`${'━'.repeat(60)}`);
    console.log(`[${i + 1}/${allResults.length}] ${r.title}`);
    console.log(`🔗 ${r.url}`);
    if (r.snippet) console.log(`📝 ${r.snippet}`);
    console.log();
    if (r.error) { console.log('❌ Failed to load'); }
    else { console.log(r.content.slice(0, maxChars)); }
    console.log();
  });
  console.log(`\n✅ Research complete: ${allResults.length} pages read for "${query}"`);
}
