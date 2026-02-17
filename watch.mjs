#!/usr/bin/env node
/**
 * watch.mjs — Monitor page changes, alert on diff
 * Usage: node watch.mjs "url" [--interval 300] [--selector "css"] [--profile name] [--once]
 */
process.env.DISPLAY = process.env.DISPLAY || ':99';

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { launch } from './browser-launcher.mjs';
import { waitForSlot } from './rate-limiter.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const WATCH_DIR = join(__dir, '.watch-state');

function getArg(args, name, def) {
  const i = args.indexOf(`--${name}`);
  if (i !== -1 && args[i + 1] && !args[i + 1].startsWith('--')) return args[i + 1];
  return def;
}

function stateKey(url) { return createHash('md5').update(url).digest('hex'); }

function getState(url) {
  const path = join(WATCH_DIR, `${stateKey(url)}.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function setState(url, content, hash) {
  mkdirSync(WATCH_DIR, { recursive: true });
  writeFileSync(join(WATCH_DIR, `${stateKey(url)}.json`), JSON.stringify({ url, hash, checkedAt: new Date().toISOString(), contentPreview: content.slice(0, 500) }));
}

// Simple line-by-line diff
function simpleDiff(oldText, newText, maxLines = 10) {
  const oldLines = oldText.split('\n').slice(0, 100);
  const newLines = newText.split('\n').slice(0, 100);
  const diffs = [];
  const maxLen = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < maxLen && diffs.length < maxLines; i++) {
    const ol = oldLines[i] || '';
    const nl = newLines[i] || '';
    if (ol !== nl) {
      if (ol) diffs.push(`- ${ol.trim().slice(0, 120)}`);
      if (nl) diffs.push(`+ ${nl.trim().slice(0, 120)}`);
    }
  }
  return diffs.join('\n');
}

async function checkPage(browser, url, selector = null) {
  await waitForSlot(url);
  const page = await browser.context.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await new Promise(r => setTimeout(r, 2000));
    let content;
    if (selector) {
      content = await page.evaluate(sel => document.querySelector(sel)?.innerText || '', selector);
    } else {
      content = await page.evaluate(() => {
        const clone = document.body.cloneNode(true);
        ['script', 'style', 'nav', 'footer', 'header', 'aside', 'iframe'].forEach(t => clone.querySelectorAll(t).forEach(e => e.remove()));
        return clone.innerText.trim();
      });
    }
    const hash = createHash('md5').update(content).digest('hex');
    return { content, hash };
  } finally { await page.close(); }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const url = args.find(a => !a.startsWith('--'));
const interval = parseInt(getArg(args, 'interval', '300'));
const selector = getArg(args, 'selector', null);
const profile = getArg(args, 'profile', null);
const once = args.includes('--once');

if (!url) {
  console.log(`
watch.mjs — Monitor page for changes (with diff)

Usage: node watch.mjs "url" [--interval 300] [--selector ".price"] [--profile name] [--once]

Options:
  --interval N    Check every N seconds (default: 300 = 5 min)
  --selector sel  Only watch specific CSS selector
  --profile name  Use cookie profile
  --once          Check once and exit (for cron usage)

Examples:
  node watch.mjs "https://example.com/status" --interval 60
  node watch.mjs "https://shop.com/product" --selector ".price" --interval 120
  node watch.mjs "https://news.site.com" --once
`);
  process.exit(0);
}

console.log(`👀 Watching: ${url}`);
console.log(`   Interval: ${interval}s${selector ? `, selector: ${selector}` : ''}${profile ? `, profile: ${profile}` : ''}`);

const browser = await launch({ profile });

async function doCheck() {
  const { content, hash } = await checkPage(browser, url, selector);
  const prev = getState(url);

  if (!prev) {
    console.log(`[${new Date().toISOString()}] 📝 First check — baseline saved (${content.length} chars)`);
    setState(url, content, hash);
    return { changed: false, first: true };
  }

  if (prev.hash !== hash) {
    console.log(`[${new Date().toISOString()}] 🔔 CHANGED!`);
    const diff = simpleDiff(prev.contentPreview, content.slice(0, 500));
    if (diff) {
      console.log(`   Diff:\n${diff.split('\n').map(l => '   ' + l).join('\n')}`);
    } else {
      console.log(`   Previous: ${prev.contentPreview.slice(0, 100)}...`);
      console.log(`   Current:  ${content.slice(0, 100)}...`);
    }
    setState(url, content, hash);

    writeFileSync('/tmp/ghost-watch-alert.json', JSON.stringify({
      url, changedAt: new Date().toISOString(),
      previousHash: prev.hash, newHash: hash,
      diff: diff || undefined,
      preview: content.slice(0, 300),
    }));

    return { changed: true, content, diff };
  }

  console.log(`[${new Date().toISOString()}] ✅ No changes`);
  return { changed: false };
}

if (once) {
  const result = await doCheck();
  await browser.close();
  process.exit(result.changed ? 1 : 0);
} else {
  await doCheck();
  setInterval(async () => {
    try { await doCheck(); } catch (e) { console.error('Check failed:', e.message); }
  }, interval * 1000);
}
