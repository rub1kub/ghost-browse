#!/usr/bin/env node
/**
 * server.mjs — Persistent browser session server (HTTP API)
 * Keeps Chrome running between calls — saves 3-5s per request
 *
 * Usage:
 *   node server.mjs [--port 3847]          # start server
 *   curl localhost:3847/search?q=query      # search
 *   curl localhost:3847/fetch?url=https://  # fetch page
 *   curl localhost:3847/status              # status
 *   curl -X POST localhost:3847/stop        # stop server
 */
process.env.DISPLAY = process.env.DISPLAY || ':99';

import http from 'http';
import { URL } from 'url';
import { chromium } from 'playwright';
import { execSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { getCached, setCache, cacheStats } from './cache.mjs';

const PORT = parseInt(process.argv.find((a, i) => process.argv[i-1] === '--port') || '3847');
const REAL_USER_DATA = '/home/openclawd/.openclaw/browser/openclaw/user-data';

let ctx = null;
let requestCount = 0;
let startTime = Date.now();

async function getContext() {
  if (ctx) return ctx;
  console.log('🚀 Launching persistent browser...');
  const tmp = mkdtempSync(`${tmpdir()}/ghost-server-`);
  execSync(`cp -r "${REAL_USER_DATA}/." "${tmp}" 2>/dev/null; rm -f "${tmp}/SingletonLock" "${tmp}/SingletonCookie" "${tmp}/SingletonSocket"`, { timeout: 15000 });
  ctx = await chromium.launchPersistentContext(tmp, {
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
  ctx._tmpDir = tmp;
  ctx.close = async () => { await origClose(); try { rmSync(tmp, { recursive: true, force: true }); } catch {} ctx = null; };
  console.log('✅ Browser ready');
  return ctx;
}

function htmlToText(html) {
  return html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

async function handleSearch(q, engine = 'ddg', limit = 10) {
  const context = await getContext();
  const page = await context.newPage();
  try {
    if (engine === 'ddg') {
      await page.goto(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await new Promise(r => setTimeout(r, 1500));
      const raw = await page.evaluate(() => {
        const items = [];
        document.querySelectorAll('.result').forEach(el => {
          const t = el.querySelector('.result__title a, .result__a');
          const s = el.querySelector('.result__snippet');
          if (t) items.push({ title: t.textContent.trim(), url: t.href, snippet: s?.textContent?.trim() || '' });
        });
        return items;
      });
      return raw.map(r => { try { const m = r.url.match(/uddg=([^&]+)/); if (m) r.url = decodeURIComponent(m[1]); } catch {} return r; }).filter(r => !r.url.includes('duckduckgo.com')).slice(0, limit);
    }
    // Google
    await page.goto(`https://www.google.com/search?q=${encodeURIComponent(q)}&hl=en`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));
    for (const sel of ['#L2AGLb', 'button[aria-label*="Reject"]']) { try { const b = await page.$(sel); if (b) { await b.click(); } } catch {} }
    await new Promise(r => setTimeout(r, 1000));
    const results = await page.evaluate(() => {
      const items = [];
      document.querySelectorAll('h3').forEach(h3 => {
        const link = h3.closest('a');
        if (!link?.href || link.href.includes('google.com')) return;
        items.push({ title: h3.textContent.trim(), url: link.href });
      });
      return items;
    });
    return results.slice(0, limit);
  } finally { await page.close(); }
}

async function handleFetch(url, maxChars = 8000, ttlMs = 600000) {
  // Check cache first
  const cached = getCached(url, ttlMs);
  if (cached) return { ...cached, fromCache: true };

  const context = await getContext();
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await new Promise(r => setTimeout(r, 1500));
    const result = await page.evaluate(() => {
      const clone = document.body.cloneNode(true);
      ['script','style','nav','footer','header','aside','iframe','noscript'].forEach(t => clone.querySelectorAll(t).forEach(e => e.remove()));
      return { title: document.title, html: clone.innerHTML, url: window.location.href };
    });
    const content = htmlToText(result.html).slice(0, maxChars);
    const data = { title: result.title, url: result.url, content };
    setCache(url, data);
    return data;
  } finally { await page.close(); }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;
  requestCount++;

  res.setHeader('Content-Type', 'application/json');

  try {
    if (path === '/search') {
      const q = url.searchParams.get('q');
      if (!q) { res.writeHead(400); res.end(JSON.stringify({ error: 'missing q param' })); return; }
      const engine = url.searchParams.get('engine') || 'ddg';
      const limit = parseInt(url.searchParams.get('limit') || '10');
      const results = await handleSearch(q, engine, limit);
      res.end(JSON.stringify({ query: q, engine, results }));
    } else if (path === '/fetch') {
      const fetchUrl = url.searchParams.get('url');
      if (!fetchUrl) { res.writeHead(400); res.end(JSON.stringify({ error: 'missing url param' })); return; }
      const max = parseInt(url.searchParams.get('max') || '8000');
      const result = await handleFetch(fetchUrl, max);
      res.end(JSON.stringify(result));
    } else if (path === '/status') {
      const cache = cacheStats();
      res.end(JSON.stringify({
        status: 'running',
        browserActive: !!ctx,
        requestCount,
        uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
        cache,
      }));
    } else if (path === '/stop' && req.method === 'POST') {
      res.end(JSON.stringify({ status: 'stopping' }));
      if (ctx) await ctx.close();
      server.close();
      process.exit(0);
    } else {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'not found', endpoints: ['/search?q=', '/fetch?url=', '/status', 'POST /stop'] }));
    }
  } catch (e) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: e.message }));
  }
});

server.listen(PORT, () => {
  console.log(`👻 ghost-browse server running on http://localhost:${PORT}`);
  console.log(`  GET /search?q=query&engine=ddg&limit=10`);
  console.log(`  GET /fetch?url=https://...&max=8000`);
  console.log(`  GET /status`);
  console.log(`  POST /stop`);
});
