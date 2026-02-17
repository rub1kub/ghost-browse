#!/usr/bin/env node
/**
 * watch.mjs — Monitor page changes, alert on diff
 * Usage: node watch.mjs "url" [--interval 300] [--selector "css"] [--webhook url]
 */
process.env.DISPLAY = process.env.DISPLAY || ':99';

import { chromium } from 'playwright';
import { execSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';

const __dir = dirname(fileURLToPath(import.meta.url));
const WATCH_DIR = join(__dir, '.watch-state');
const REAL_USER_DATA = '/home/openclawd/.openclaw/browser/openclaw/user-data';

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

async function launchCtx() {
  const tmp = mkdtempSync(`${tmpdir()}/ghost-watch-`);
  execSync(`cp -r "${REAL_USER_DATA}/." "${tmp}" 2>/dev/null; rm -f "${tmp}/SingletonLock" "${tmp}/SingletonCookie" "${tmp}/SingletonSocket"`, { timeout: 15000 });
  const ctx = await chromium.launchPersistentContext(tmp, {
    headless: false,
    executablePath: '/usr/bin/google-chrome-stable',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--no-first-run'],
    env: { ...process.env, DISPLAY: process.env.DISPLAY },
    viewport: { width: 1440, height: 900 },
  });
  const origClose = ctx.close.bind(ctx);
  ctx.close = async () => { await origClose(); try { rmSync(tmp, { recursive: true, force: true }); } catch {} };
  return ctx;
}

async function checkPage(ctx, url, selector = null) {
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await new Promise(r => setTimeout(r, 2000));
    let content;
    if (selector) {
      content = await page.evaluate(sel => document.querySelector(sel)?.innerText || '', selector);
    } else {
      content = await page.evaluate(() => {
        const clone = document.body.cloneNode(true);
        ['script','style','nav','footer','header','aside','iframe'].forEach(t => clone.querySelectorAll(t).forEach(e => e.remove()));
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
const once = args.includes('--once');

if (!url) {
  console.log(`
watch.mjs — Monitor page for changes

Usage: node watch.mjs "url" [--interval 300] [--selector ".price"] [--once]

Options:
  --interval N    Check every N seconds (default: 300 = 5 min)
  --selector sel  Only watch specific CSS selector
  --once          Check once and exit (for cron usage)

Examples:
  node watch.mjs "https://example.com/status" --interval 60
  node watch.mjs "https://shop.com/product" --selector ".price" --interval 120
  node watch.mjs "https://news.site.com" --once
`);
  process.exit(0);
}

console.log(`👀 Watching: ${url}`);
console.log(`   Interval: ${interval}s${selector ? `, selector: ${selector}` : ''}`);

const ctx = await launchCtx();

async function doCheck() {
  const { content, hash } = await checkPage(ctx, url, selector);
  const prev = getState(url);

  if (!prev) {
    console.log(`[${new Date().toISOString()}] 📝 First check — baseline saved (${content.length} chars)`);
    setState(url, content, hash);
    return { changed: false, first: true };
  }

  if (prev.hash !== hash) {
    console.log(`[${new Date().toISOString()}] 🔔 CHANGED!`);
    console.log(`   Previous: ${prev.contentPreview.slice(0, 100)}...`);
    console.log(`   Current:  ${content.slice(0, 100)}...`);
    setState(url, content, hash);

    // Write alert for pickup
    writeFileSync('/tmp/ghost-watch-alert.json', JSON.stringify({
      url, changedAt: new Date().toISOString(),
      previousHash: prev.hash, newHash: hash,
      preview: content.slice(0, 300),
    }));

    return { changed: true, content };
  }

  console.log(`[${new Date().toISOString()}] ✅ No changes`);
  return { changed: false };
}

if (once) {
  const result = await doCheck();
  await ctx.close();
  process.exit(result.changed ? 1 : 0); // exit 1 if changed (useful for cron)
} else {
  await doCheck();
  setInterval(async () => {
    try { await doCheck(); } catch (e) { console.error('Check failed:', e.message); }
  }, interval * 1000);
}
