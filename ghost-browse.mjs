#!/usr/bin/env node
// GUI mode requires Xvfb — set DISPLAY before anything else
process.env.DISPLAY = process.env.DISPLAY || ':99';

/**
 * ghost-browse v2.6.0 — Stealth browser for AI agents
 *
 * Usage:
 *   node ghost-browse.mjs search "query" [--limit 10] [--engine google|bing|ddg] [--trace]
 *   node ghost-browse.mjs fetch "https://example.com" [--trace]
 *   node ghost-browse.mjs batch "url1" "url2" "url3" ... [--trace]
 *   node ghost-browse.mjs pages "query" [--pages 3] [--trace]
 */

import { existsSync, readFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { isCaptcha, handleCaptcha } from './captcha-handler.mjs';
import { getCached, setCache } from './cache.mjs';
import { launch, loadProfile } from './browser-launcher.mjs';
import { waitForSlot } from './rate-limiter.mjs';
import { ProxyIntelligence } from './proxy-intelligence.mjs';
import { createTrace } from './trace-recorder.mjs';
import { runHealedAction } from './self-heal-store.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const SCREENSHOTS_DIR = join(__dir, 'screenshots');

// ─── Proxy support ────────────────────────────────────────────────────────────

let proxyPool = null;

function loadProxies(proxyArg) {
  if (!proxyArg) return;
  proxyPool = new ProxyIntelligence(proxyArg);
  console.log(`🔀 Loaded ${proxyPool.count()} proxy(ies) with health scoring`);
}

function nextProxy(target = null) {
  if (!proxyPool) return null;
  return proxyPool.pick(target || 'unknown');
}

function reportProxySuccess(proxyObj, latencyMs = null) {
  if (!proxyPool || !proxyObj?._proxyId) return;
  proxyPool.reportSuccess(proxyObj._proxyId, latencyMs);
}

function reportProxyFailure(proxyObj) {
  if (!proxyPool || !proxyObj?._proxyId) return;
  proxyPool.reportFailure(proxyObj._proxyId);
}

// ─── Retry logic ──────────────────────────────────────────────────────────────

async function withRetry(fn, opts = {}) {
  const maxAttempts = opts.retries || 3;
  const baseDelay = opts.retryDelay || 2000;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await fn(attempt);
      if (opts.onSuccess) {
        try { await opts.onSuccess(attempt, result); } catch {}
      }
      return result;
    } catch (err) {
      if (opts.onError) {
        try { await opts.onError(err, attempt); } catch {}
      }
      if (attempt === maxAttempts) throw err;
      const delay = baseDelay * Math.pow(2, attempt - 1);
      console.log(`  ⚠️  Attempt ${attempt}/${maxAttempts} failed: ${err.message.slice(0, 60)} → retry in ${delay}ms`);
      await sleep(delay);
    }
  }
}

// ─── Screenshot util ──────────────────────────────────────────────────────────

async function takeScreenshot(page, name = 'screenshot') {
  mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  const ts = Date.now();
  const path = join(SCREENSHOTS_DIR, `${name}-${ts}.png`);
  await page.screenshot({ path, fullPage: false });
  return path;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const SEARCH_URLS = {
  google: (q, page) => `https://www.google.com/search?q=${encodeURIComponent(q)}&start=${(page - 1) * 10}&hl=en`,
  bing:   (q, page) => `https://www.bing.com/search?q=${encodeURIComponent(q)}&first=${(page - 1) * 10 + 1}`,
  ddg:    (q, page) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}&s=${(page - 1) * 30}`,
};

// ─── Utils ────────────────────────────────────────────────────────────────────

const rand = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function randomDelay(minMs = 800, maxMs = 2500) {
  return sleep(rand(minMs, maxMs));
}

function htmlToMarkdown(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => `[${text.trim()}](${href})`)
    .replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, (_, t) => `## ${t.trim()}\n`)
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_, t) => `${t.trim()}\n\n`)
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, t) => `• ${t.trim()}\n`)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ─── Human-like interaction ───────────────────────────────────────────────────

async function humanScroll(page, amount = null) {
  const scrollAmount = amount || rand(200, 600);
  await page.evaluate((amount) => window.scrollBy(0, amount), scrollAmount);
  await randomDelay(300, 800);
}

// ─── Cookie / consent banners ─────────────────────────────────────────────────

async function dismissCookieBanner(page) {
  const selectors = [
    'button[aria-label="Reject all"]',
    'button[aria-label="Accept all"]',
    '#L2AGLb',
    'button:has-text("Reject all")',
    'button:has-text("Accept all")',
    'button:has-text("I agree")',
    '.cookie-consent button',
    '[data-testid="cookie-banner"] button',
  ];

  try {
    const result = await runHealedAction({
      page,
      key: 'cookie-banner-dismiss',
      selectors,
      action: async (sel) => {
        const btn = await page.$(sel);
        if (!btn) return false;
        await btn.click();
        await randomDelay(500, 1000);
        return true;
      },
    });
    return result.ok;
  } catch {
    return false;
  }
}

// ─── Bing URL decoder ─────────────────────────────────────────────────────────

function decodeBingUrl(url) {
  if (!url || !url.includes('bing.com/ck/')) return url;
  try {
    // Extract base64url-encoded URL from `u` parameter (format: a1<base64url>)
    const match = url.match(/[&?]u=a1([^&]+)/);
    if (match) {
      const decoded = Buffer.from(match[1], 'base64url').toString('utf8');
      if (decoded.startsWith('http')) return decoded;
    }
  } catch {}
  return url;
}

// ─── Search engines ───────────────────────────────────────────────────────────

async function searchGoogle(page, query, pageNum = 1) {
  await waitForSlot('google.com');
  const url = SEARCH_URLS.google(query, pageNum);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await randomDelay(800, 1500);
  await dismissCookieBanner(page);
  await randomDelay(500, 1000);

  const results = await page.evaluate(() => {
    const items = [];
    document.querySelectorAll('h3').forEach(h3 => {
      const link = h3.closest('a');
      if (!link) return;
      const href = link.href;
      if (!href || href.includes('google.com') || href.includes('googleusercontent') || href.startsWith('#')) return;
      const container = h3.closest('[data-ved], .g, [data-hveid], .MjjYud > div') || h3.parentElement?.parentElement;
      const snippetEl = container?.querySelector('.VwiC3b, .yDYNvb, [data-sncf], span[style*="-webkit-line-clamp"]');
      items.push({
        title: h3.textContent.trim(),
        url: href,
        snippet: snippetEl?.textContent?.trim() || '',
      });
    });
    return items;
  });

  return results.filter(r => r.url && r.title && !r.url.includes('google.com'));
}

async function searchBing(page, query, pageNum = 1) {
  await waitForSlot('bing.com');
  const url = SEARCH_URLS.bing(query, pageNum);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await randomDelay(800, 1800);

  const raw = await page.evaluate(() => {
    const items = [];
    document.querySelectorAll('li.b_algo').forEach(el => {
      const titleEl = el.querySelector('h2 a');
      const snippetEl = el.querySelector('.b_caption p, .b_algoSlug');
      if (titleEl) {
        items.push({
          title: titleEl.textContent.trim(),
          url: titleEl.href,
          snippet: snippetEl ? snippetEl.textContent.trim() : '',
        });
      }
    });
    return items;
  });

  // Decode Bing redirect URLs
  return raw.map(r => ({ ...r, url: decodeBingUrl(r.url) }));
}

async function searchDDG(page, query, pageNum = 1) {
  await waitForSlot('duckduckgo.com');
  const url = SEARCH_URLS.ddg(query, pageNum);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await randomDelay(600, 1400);

  const raw = await page.evaluate(() => {
    const items = [];
    document.querySelectorAll('.result').forEach(el => {
      const titleEl = el.querySelector('.result__title a, .result__a, h2 a');
      const snippetEl = el.querySelector('.result__snippet');
      if (titleEl) {
        items.push({
          title: titleEl.textContent.trim(),
          url: titleEl.href,
          snippet: snippetEl ? snippetEl.textContent.trim() : '',
        });
      }
    });
    return items;
  });

  return raw.map(r => {
    try {
      const m = r.url.match(/uddg=([^&]+)/);
      if (m) r.url = decodeURIComponent(m[1]);
    } catch {}
    return r;
  }).filter(r => r.url && !r.url.includes('duckduckgo.com/y.js'));
}

// ─── Page fetch ───────────────────────────────────────────────────────────────

async function fetchPage(context, url, opts = {}) {
  if (!opts.noCache) {
    const cached = getCached(url, opts.cacheTtl || 600000);
    if (cached) { cached.fromCache = true; return cached; }
  }

  await waitForSlot(url);
  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await randomDelay(500, 1200);
    await dismissCookieBanner(page);

    const captchaDetected = await isCaptcha(page);
    if (captchaDetected.detected) {
      console.error(`⚠️  CAPTCHA on ${url} — trying to solve...`);
      const result = await handleCaptcha(page, url, { alertTelegram: opts.alertTelegram });
      if (result === 'solved') {
        await randomDelay(2000, 4000);
      } else {
        const screenshotPath = await takeScreenshot(page, 'captcha');
        return { url, title: 'CAPTCHA', content: '[CAPTCHA — needs human, screenshot saved at ' + screenshotPath + ']', captcha: true, captchaScreenshot: screenshotPath, links: [] };
      }
    }

    let screenshotPath = null;
    if (opts.screenshot) {
      const domain = new URL(url).hostname.replace(/\./g, '-');
      screenshotPath = await takeScreenshot(page, domain);
      console.log(`   📸 Screenshot: ${screenshotPath}`);
    }

    if (opts.scroll) {
      for (let i = 0; i < 3; i++) {
        await humanScroll(page);
      }
    }

    const result = await page.evaluate(() => {
      const title = document.title;
      const bodyClone = document.body.cloneNode(true);
      ['script', 'style', 'nav', 'footer', 'header', 'aside', 'iframe', 'noscript'].forEach(tag => {
        bodyClone.querySelectorAll(tag).forEach(el => el.remove());
      });
      const links = [];
      document.querySelectorAll('a[href^="http"]').forEach(a => {
        const text = a.textContent.trim();
        if (text && a.href && !links.find(l => l.url === a.href)) {
          links.push({ text: text.slice(0, 100), url: a.href });
        }
      });
      return { title, url: window.location.href, html: bodyClone.innerHTML, links: links.slice(0, 50) };
    });

    result.content = htmlToMarkdown(result.html);
    delete result.html;
    if (screenshotPath) result.screenshotPath = screenshotPath;
    if (!opts.noCache) setCache(url, result);

    return result;
  } finally {
    try { await page.close(); } catch {}
  }
}

// ─── Commands ─────────────────────────────────────────────────────────────────

function getArg(args, name, def) {
  const eqIdx = args.findIndex(a => a === `--${name}`);
  if (eqIdx !== -1 && args[eqIdx + 1] && !args[eqIdx + 1].startsWith('--')) return args[eqIdx + 1];
  const eq = args.find(a => a.startsWith(`--${name}=`));
  if (eq) return eq.split('=').slice(1).join('=');
  return def;
}

async function cmdSearch(args) {
  const query = args.find(a => !a.startsWith('--'));
  const limit = parseInt(getArg(args, 'limit', '10'));
  const engine = getArg(args, 'engine', 'ddg');
  const jsonOut = args.includes('--json');
  const defaultProfile = engine === 'google' ? 'google-com' : null;
  const profile = getArg(args, 'profile', defaultProfile);
  const proxy = getArg(args, 'proxy', null);
  if (proxy) loadProxies(proxy);
  if (!query) { console.error('Usage: ghost-browse search "query" [--limit N] [--engine google|bing|ddg] [--profile name]'); process.exit(1); }

  const trace = createTrace({ enabled: args.includes('--trace'), command: 'search', meta: { query, engine, limit } });
  const selectedProxy = nextProxy(`search:${engine}`);
  const t0 = Date.now();

  const browser = await launch({ profile, proxy: selectedProxy ? { server: selectedProxy.server } : null });
  const page = await browser.context.newPage();

  try {
    trace.event('search.start', { query, engine, proxy: selectedProxy?._proxyId || null });

    let results;
    if (engine === 'bing') results = await searchBing(page, query);
    else if (engine === 'google') results = await searchGoogle(page, query);
    else results = await searchDDG(page, query);

    const limited = results.slice(0, limit);
    reportProxySuccess(selectedProxy, Date.now() - t0);
    trace.event('search.ok', { results: limited.length });
    trace.finish({ ok: true, results: limited.length });

    if (jsonOut) {
      console.log(JSON.stringify({ tool: 'ghost-browse', command: 'search', engine, query, fingerprint: browser.fingerprint._seed ? 'profile' : 'anonymous', trace: trace.filePath, results: limited }, null, 2));
    } else {
      console.log(`\n🔍 Search: "${query}" [${engine}] — ${limited.length} results\n`);
      limited.forEach((r, i) => {
        console.log(`${i + 1}. ${r.title}`);
        console.log(`   ${r.url}`);
        if (r.snippet) console.log(`   ${r.snippet.slice(0, 200)}`);
        console.log();
      });
      if (trace.filePath) console.log(`🧵 Trace: ${trace.filePath}`);
    }
  } catch (err) {
    reportProxyFailure(selectedProxy);
    trace.event('search.error', { error: err.message });
    trace.finish({ ok: false, error: err.message });
    throw err;
  } finally {
    try { await page.close(); } catch {}
    await browser.close();
  }
}

async function cmdFetch(args) {
  const url = args.find(a => !a.startsWith('--'));
  const jsonOut = args.includes('--json');
  const scroll = args.includes('--scroll');
  const maxChars = parseInt(getArg(args, 'max', '8000'));
  const profile = getArg(args, 'profile', null);
  const proxy = getArg(args, 'proxy', null);
  const screenshot = args.includes('--screenshot');
  const retries = parseInt(getArg(args, 'retries', '2'));
  const alertTelegram = args.includes('--alert-telegram');
  if (proxy) loadProxies(proxy);
  if (!url) { console.error('Usage: ghost-browse fetch "https://..." [--scroll] [--max N]'); process.exit(1); }

  const trace = createTrace({ enabled: args.includes('--trace'), command: 'fetch', meta: { url } });
  const selectedProxy = nextProxy(url);
  const t0 = Date.now();

  const browser = await launch({ profile, proxy: selectedProxy ? { server: selectedProxy.server } : null });
  try {
    trace.event('fetch.start', { url, proxy: selectedProxy?._proxyId || null, retries });

    const result = await withRetry(
      () => fetchPage(browser.context, url, { scroll, screenshot, alertTelegram }),
      {
        retries,
        onError: async (err, attempt) => {
          trace.event('fetch.retry', { attempt, error: err.message });
        },
      },
    );

    reportProxySuccess(selectedProxy, Date.now() - t0);
    trace.event('fetch.ok', { title: result.title, links: result.links?.length || 0 });
    trace.finish({ ok: true, title: result.title });

    if (jsonOut) {
      console.log(JSON.stringify({ tool: 'ghost-browse', command: 'fetch', fingerprint: browser.fingerprint._seed ? 'profile' : 'anonymous', trace: trace.filePath, ...result, content: result.content.slice(0, maxChars) }, null, 2));
    } else {
      console.log(`\n📄 ${result.title}`);
      console.log(`🔗 ${result.url}\n`);
      console.log(result.content.slice(0, maxChars));
      if (result.links?.length) {
        console.log(`\n🔗 Links (${result.links.length}):`);
        result.links.slice(0, 10).forEach(l => console.log(`  • ${l.text}: ${l.url}`));
      }
      if (trace.filePath) console.log(`\n🧵 Trace: ${trace.filePath}`);
    }
  } catch (err) {
    reportProxyFailure(selectedProxy);
    trace.event('fetch.error', { error: err.message });
    trace.finish({ ok: false, error: err.message });
    throw err;
  } finally {
    await browser.close();
  }
}

async function cmdBatch(args) {
  const urls = args.filter(a => !a.startsWith('--') && (a.startsWith('http://') || a.startsWith('https://')));
  const jsonOut = args.includes('--json');
  const concurrency = parseInt(getArg(args, 'concurrency', '5'));
  const maxChars = parseInt(getArg(args, 'max', '4000'));
  const profile = getArg(args, 'profile', null);
  const proxy = getArg(args, 'proxy', null);
  if (proxy) loadProxies(proxy);
  if (!urls.length) { console.error('Usage: ghost-browse batch "url1" "url2" ... [--concurrency N]'); process.exit(1); }

  const trace = createTrace({ enabled: args.includes('--trace'), command: 'batch', meta: { count: urls.length, concurrency } });
  const selectedProxy = nextProxy(urls[0] || null);
  const t0 = Date.now();

  const browser = await launch({ profile, proxy: selectedProxy ? { server: selectedProxy.server } : null });
  const results = [];

  try {
    trace.event('batch.start', { urls: urls.length, proxy: selectedProxy?._proxyId || null });

    for (let i = 0; i < urls.length; i += concurrency) {
      const chunk = urls.slice(i, i + concurrency);
      const fetched = await Promise.allSettled(chunk.map(url => fetchPage(browser.context, url)));
      fetched.forEach((r, j) => {
        if (r.status === 'fulfilled') results.push({ url: urls[i + j], ...r.value });
        else results.push({ url: urls[i + j], error: r.reason?.message });
      });
    }

    reportProxySuccess(selectedProxy, Date.now() - t0);
    trace.event('batch.ok', { results: results.length, errors: results.filter(r => r.error).length });
    trace.finish({ ok: true, results: results.length });

    if (jsonOut) {
      console.log(JSON.stringify({ tool: 'ghost-browse', command: 'batch', trace: trace.filePath, results: results.map(r => ({ ...r, content: r.content?.slice(0, maxChars) })) }, null, 2));
    } else {
      results.forEach((r, i) => {
        console.log(`\n${'═'.repeat(60)}`);
        console.log(`[${i + 1}/${results.length}] ${r.title || r.url}`);
        console.log(`🔗 ${r.url}`);
        if (r.error) { console.log(`❌ Error: ${r.error}`); return; }
        console.log(r.content?.slice(0, maxChars));
      });
      if (trace.filePath) console.log(`\n🧵 Trace: ${trace.filePath}`);
    }
  } catch (err) {
    reportProxyFailure(selectedProxy);
    trace.event('batch.error', { error: err.message });
    trace.finish({ ok: false, error: err.message });
    throw err;
  } finally {
    await browser.close();
  }
}

async function cmdPages(args) {
  const query = args.find(a => !a.startsWith('--'));
  const pages = parseInt(getArg(args, 'pages', '3'));
  const engine = getArg(args, 'engine', 'ddg');
  const jsonOut = args.includes('--json');
  const profile = getArg(args, 'profile', null);
  const proxy = getArg(args, 'proxy', null);
  if (proxy) loadProxies(proxy);
  if (!query) { console.error('Usage: ghost-browse pages "query" [--pages N] [--engine google|bing|ddg]'); process.exit(1); }

  const trace = createTrace({ enabled: args.includes('--trace'), command: 'pages', meta: { query, pages, engine } });
  const selectedProxy = nextProxy(`pages:${engine}`);
  const t0 = Date.now();

  const browser = await launch({ profile, proxy: selectedProxy ? { server: selectedProxy.server } : null });
  const page = await browser.context.newPage();
  const allResults = [];

  try {
    trace.event('pages.start', { query, pages, engine, proxy: selectedProxy?._proxyId || null });

    for (let p = 1; p <= pages; p++) {
      let results;
      if (engine === 'bing') results = await searchBing(page, query, p);
      else if (engine === 'google') results = await searchGoogle(page, query, p);
      else results = await searchDDG(page, query, p);

      allResults.push(...results.map(r => ({ ...r, page: p })));
      if (p < pages) await randomDelay(1500, 3000);
    }

    reportProxySuccess(selectedProxy, Date.now() - t0);
    trace.event('pages.ok', { results: allResults.length });
    trace.finish({ ok: true, results: allResults.length });

    if (jsonOut) {
      console.log(JSON.stringify({ tool: 'ghost-browse', command: 'pages', trace: trace.filePath, results: allResults }, null, 2));
    } else {
      console.log(`\n🔍 "${query}" — ${pages} pages, ${allResults.length} results\n`);
      allResults.forEach((r, i) => {
        console.log(`${i + 1}. [p${r.page}] ${r.title}`);
        console.log(`   ${r.url}`);
        if (r.snippet) console.log(`   ${r.snippet.slice(0, 180)}`);
        console.log();
      });
      if (trace.filePath) console.log(`🧵 Trace: ${trace.filePath}`);
    }
  } catch (err) {
    reportProxyFailure(selectedProxy);
    trace.event('pages.error', { error: err.message });
    trace.finish({ ok: false, error: err.message });
    throw err;
  } finally {
    try { await page.close(); } catch {}
    await browser.close();
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const [,, cmd, ...rest] = process.argv;

const commands = { search: cmdSearch, fetch: cmdFetch, batch: cmdBatch, pages: cmdPages };

if (!cmd || !commands[cmd]) {
  console.log(`
ghost-browse v2.6.0 — Stealth browser for AI agents (GUI mode)

Core commands:
  search "query" [--limit N] [--engine google|bing|ddg] [--proxy url] [--json] [--trace]
  fetch  "url"   [--scroll]  [--max N]  [--screenshot] [--retries N] [--json] [--trace]
  batch  "url1" "url2" ...   [--concurrency N] [--max N] [--json] [--proxy url|file] [--trace]
  pages  "query" [--pages N] [--engine google|bing|ddg] [--json] [--profile name] [--proxy url|file] [--trace]

Advanced commands:
  node schema-extract.mjs "url" --schema schema.json [--json] [--trace]
  node crawl-map.mjs "url" [--depth 2] [--max-pages 50] [--same-domain] [--json] [--trace]
  node smart-actions.mjs click "url" --key action_key --selectors "sel1,sel2,text=..." [--json] [--trace]
  node queue-runner.mjs enqueue <fetch|search|map|extract-schema|smart-click|smart-type> <target> [...]
  node queue-runner.mjs run [--once]

Research & monitoring:
  node research.mjs "topic" [--limit 5] [--engine ddg] [--profile name] [--json]
  node watch.mjs "url" [--interval 300] [--selector ".price"] [--profile name] [--once]
  node server.mjs [--port 3847]    # persistent HTTP API

Site extractors (extractors.mjs):
  node extractors.mjs twitter-timeline --limit 20
  node extractors.mjs reddit-feed programming
  node extractors.mjs hackernews top
  node extractors.mjs github-trending javascript
  node extractors.mjs twitter-search "query"
  node extractors.mjs article "url"

Profiles (profile-manager.mjs):
  node profile-manager.mjs import-cdp
  node profile-manager.mjs list / show <name>

Features:
  ✅ GUI mode via Xvfb — undetectable by Google/Twitter/Reddit
  ✅ Persistent fingerprint per profile — same cookies, same browser identity
  ✅ Random fingerprint for anonymous browsing — unique every session
  ✅ Smart cache — TTL-based, avoid redundant fetches
  ✅ Rate limiter — per-domain limits prevent IP bans
  ✅ Parallel — batch up to N pages simultaneously
  ✅ Proxy intelligence — health scoring + cooldown + sticky domain sessions
  ✅ Self-healing selectors — remembers working selectors for flaky DOMs
  ✅ Session trace/replay — --trace writes full action timeline (jsonl)
  ✅ Schema extraction — stable structured JSON via schema-extract.mjs
  ✅ Crawl map graph — deep link graph via crawl-map.mjs
  ✅ Queue + resume — persistent long-run jobs via queue-runner.mjs
  ✅ Captcha — auto-solve checkbox + screenshot human fallback
  ✅ Retry — --retries N (exponential backoff)
  ✅ Screenshots — --screenshot on every fetch
  ✅ Persistent server — HTTP API, 3-5s faster per request
  ✅ Watch mode — monitor changes with alerts
  ✅ Research mode — search + read + extract in one command
`);
  process.exit(0);
}

commands[cmd](rest).catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
