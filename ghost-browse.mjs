#!/usr/bin/env node
/**
 * ghost-browse — stealth parallel browser for AI agents
 * Searches Google/Bing/DDG, fetches JS-rendered pages, runs in parallel.
 * Designed for OpenClaw agents: no bot detection, human-like behavior.
 *
 * Usage:
 *   node ghost-browse.mjs search "query" [--limit 10] [--engine google|bing|ddg]
 *   node ghost-browse.mjs fetch "https://example.com"
 *   node ghost-browse.mjs batch "url1" "url2" "url3" ...
 *   node ghost-browse.mjs pages "query" [--pages 3]  # full multi-page search
 */

import { chromium } from 'playwright';
import { existsSync } from 'fs';

// ─── Constants ───────────────────────────────────────────────────────────────

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15',
];

const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
  { width: 1366, height: 768 },
  { width: 1280, height: 800 },
  { width: 1536, height: 864 },
];

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
  // Simple HTML → text, keeping links and structure
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

// ─── Browser factory ──────────────────────────────────────────────────────────

async function launchBrowser() {
  // Try system Chrome first (available via OpenClaw), fall back to chromium
  const execPath = process.env.CHROME_PATH || '/home/openclawd/.openclaw/bin/chrome-xvfb';

  const browser = await chromium.launch({
    headless: true,
    executablePath: existsSync(execPath) ? execPath : undefined,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-web-security',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-zygote',
      '--window-size=1920,1080',
    ],
  });
  return browser;
}

async function newStealthContext(browser, opts = {}) {
  const ua = opts.userAgent || pick(USER_AGENTS);
  const vp = opts.viewport || pick(VIEWPORTS);

  const context = await browser.newContext({
    userAgent: ua,
    viewport: vp,
    locale: 'en-US',
    timezoneId: pick(['America/New_York', 'America/Los_Angeles', 'Europe/London', 'Europe/Berlin']),
    permissions: [],
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    },
  });

  // Evasion scripts
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {}, app: {} };
    Object.defineProperty(navigator, 'permissions', {
      get: () => ({ query: () => Promise.resolve({ state: 'prompt' }) }),
    });
  });

  return context;
}

// ─── Human-like interaction ───────────────────────────────────────────────────

async function humanType(page, selector, text) {
  await page.click(selector);
  await randomDelay(300, 700);
  for (const char of text) {
    await page.type(selector, char, { delay: rand(60, 180) });
  }
}

async function humanScroll(page, amount = null) {
  const scrollAmount = amount || rand(200, 600);
  await page.evaluate((amount) => window.scrollBy(0, amount), scrollAmount);
  await randomDelay(300, 800);
}

// ─── Search engines ───────────────────────────────────────────────────────────

async function searchGoogle(page, query, pageNum = 1) {
  const url = SEARCH_URLS.google(query, pageNum);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await randomDelay(800, 1800);

  const results = await page.evaluate(() => {
    const items = [];
    // Standard results
    document.querySelectorAll('div.g, div[data-hveid]').forEach(el => {
      const linkEl = el.querySelector('a[href^="http"]');
      const titleEl = el.querySelector('h3');
      const snippetEl = el.querySelector('.VwiC3b, [data-sncf], .IsZvec span');
      if (linkEl && titleEl) {
        const url = linkEl.href;
        if (!url.includes('google.com') && !url.includes('googleusercontent')) {
          items.push({
            title: titleEl.textContent.trim(),
            url,
            snippet: snippetEl ? snippetEl.textContent.trim() : '',
          });
        }
      }
    });
    return items;
  });

  return results.filter(r => r.url && r.title);
}

async function searchBing(page, query, pageNum = 1) {
  const url = SEARCH_URLS.bing(query, pageNum);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await randomDelay(800, 1800);

  return await page.evaluate(() => {
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
}

async function searchDDG(page, query, pageNum = 1) {
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

  // Decode DDG redirect URLs
  return raw.map(r => {
    try {
      const m = r.url.match(/uddg=([^&]+)/);
      if (m) r.url = decodeURIComponent(m[1]);
    } catch {}
    return r;
  }).filter(r => r.url && !r.url.includes('duckduckgo.com/y.js'));
}

// ─── Page fetch ───────────────────────────────────────────────────────────────

async function fetchPage(browser, url, opts = {}) {
  const context = await newStealthContext(browser);
  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await randomDelay(500, 1200);

    if (opts.scroll) {
      for (let i = 0; i < 3; i++) {
        await humanScroll(page);
      }
    }

    const result = await page.evaluate(() => {
      // Extract main content
      const title = document.title;
      const bodyClone = document.body.cloneNode(true);

      // Remove noisy elements
      ['script', 'style', 'nav', 'footer', 'header', 'aside', 'iframe', 'noscript'].forEach(tag => {
        bodyClone.querySelectorAll(tag).forEach(el => el.remove());
      });

      // Get links
      const links = [];
      document.querySelectorAll('a[href^="http"]').forEach(a => {
        const text = a.textContent.trim();
        if (text && a.href && !links.find(l => l.url === a.href)) {
          links.push({ text: text.slice(0, 100), url: a.href });
        }
      });

      return {
        title,
        url: window.location.href,
        html: bodyClone.innerHTML,
        links: links.slice(0, 50),
      };
    });

    result.content = htmlToMarkdown(result.html);
    delete result.html;

    return result;
  } finally {
    await context.close();
  }
}

// ─── Commands ─────────────────────────────────────────────────────────────────

function getArg(args, name, def) {
  // Supports both --name=val and --name val
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

  if (!query) { console.error('Usage: ghost-browse search "query" [--limit N] [--engine google|bing|ddg]'); process.exit(1); }

  const browser = await launchBrowser();
  const context = await newStealthContext(browser);
  const page = await context.newPage();

  try {
    let results;
    if (engine === 'bing') results = await searchBing(page, query);
    else if (engine === 'google') results = await searchGoogle(page, query);
    else results = await searchDDG(page, query);

    const limited = results.slice(0, limit);

    if (jsonOut) {
      console.log(JSON.stringify(limited, null, 2));
    } else {
      console.log(`\n🔍 Search: "${query}" [${engine}] — ${limited.length} results\n`);
      limited.forEach((r, i) => {
        console.log(`${i + 1}. ${r.title}`);
        console.log(`   ${r.url}`);
        if (r.snippet) console.log(`   ${r.snippet.slice(0, 200)}`);
        console.log();
      });
    }
  } finally {
    await context.close();
    await browser.close();
  }
}

async function cmdFetch(args) {
  const url = args.find(a => !a.startsWith('--'));
  const jsonOut = args.includes('--json');
  const scroll = args.includes('--scroll');
  const maxChars = parseInt(getArg(args, 'max', '8000'));

  if (!url) { console.error('Usage: ghost-browse fetch "https://..." [--scroll] [--max N]'); process.exit(1); }

  const browser = await launchBrowser();
  try {
    const result = await fetchPage(browser, url, { scroll });
    if (jsonOut) {
      console.log(JSON.stringify({ ...result, content: result.content.slice(0, maxChars) }, null, 2));
    } else {
      console.log(`\n📄 ${result.title}`);
      console.log(`🔗 ${result.url}\n`);
      console.log(result.content.slice(0, maxChars));
      if (result.links.length) {
        console.log(`\n🔗 Links (${result.links.length}):`);
        result.links.slice(0, 10).forEach(l => console.log(`  • ${l.text}: ${l.url}`));
      }
    }
  } finally {
    await browser.close();
  }
}

async function cmdBatch(args) {
  const urls = args.filter(a => !a.startsWith('--') && (a.startsWith('http://') || a.startsWith('https://')));
  const jsonOut = args.includes('--json');
  const concurrency = parseInt(getArg(args, 'concurrency', '5'));
  const maxChars = parseInt(getArg(args, 'max', '4000'));

  if (!urls.length) { console.error('Usage: ghost-browse batch "url1" "url2" ... [--concurrency N]'); process.exit(1); }

  const browser = await launchBrowser();
  const results = [];

  try {
    // Process in chunks
    for (let i = 0; i < urls.length; i += concurrency) {
      const chunk = urls.slice(i, i + concurrency);
      const fetched = await Promise.allSettled(chunk.map(url => fetchPage(browser, url)));
      fetched.forEach((r, j) => {
        if (r.status === 'fulfilled') {
          results.push({ url: urls[i + j], ...r.value });
        } else {
          results.push({ url: urls[i + j], error: r.reason?.message });
        }
      });
    }

    if (jsonOut) {
      console.log(JSON.stringify(results.map(r => ({
        ...r,
        content: r.content?.slice(0, maxChars),
      })), null, 2));
    } else {
      results.forEach((r, i) => {
        console.log(`\n${'═'.repeat(60)}`);
        console.log(`[${i + 1}/${results.length}] ${r.title || r.url}`);
        console.log(`🔗 ${r.url}`);
        if (r.error) { console.log(`❌ Error: ${r.error}`); return; }
        console.log(r.content?.slice(0, maxChars));
      });
    }
  } finally {
    await browser.close();
  }
}

async function cmdPages(args) {
  // Multi-page search: goes through N pages of results
  const query = args.find(a => !a.startsWith('--'));
  const pages = parseInt(getArg(args, 'pages', '3'));
  const engine = getArg(args, 'engine', 'ddg');
  const jsonOut = args.includes('--json');

  if (!query) { console.error('Usage: ghost-browse pages "query" [--pages N] [--engine google|bing|ddg]'); process.exit(1); }

  const browser = await launchBrowser();
  const context = await newStealthContext(browser);
  const page = await context.newPage();
  const allResults = [];

  try {
    for (let p = 1; p <= pages; p++) {
      let results;
      if (engine === 'bing') results = await searchBing(page, query, p);
      else if (engine === 'google') results = await searchGoogle(page, query, p);
      else results = await searchDDG(page, query, p);

      allResults.push(...results.map(r => ({ ...r, page: p })));

      if (p < pages) await randomDelay(1500, 3000); // Human-like page turn delay
    }

    if (jsonOut) {
      console.log(JSON.stringify(allResults, null, 2));
    } else {
      console.log(`\n🔍 "${query}" — ${pages} pages, ${allResults.length} results\n`);
      allResults.forEach((r, i) => {
        console.log(`${i + 1}. [p${r.page}] ${r.title}`);
        console.log(`   ${r.url}`);
        if (r.snippet) console.log(`   ${r.snippet.slice(0, 180)}`);
        console.log();
      });
    }
  } finally {
    await context.close();
    await browser.close();
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const [,, cmd, ...rest] = process.argv;

const commands = {
  search: cmdSearch,
  fetch:  cmdFetch,
  batch:  cmdBatch,
  pages:  cmdPages,
};

if (!cmd || !commands[cmd]) {
  console.log(`
ghost-browse v1.0.0 — Stealth parallel browser for AI agents

Commands:
  search "query" [--limit N] [--engine google|bing|ddg] [--json]
  fetch  "url"   [--scroll]  [--max N]  [--json]
  batch  "url1" "url2" ...   [--concurrency N] [--max N] [--json]
  pages  "query" [--pages N] [--engine google|bing|ddg] [--json]

Features:
  • Anti-detection: randomized UA, viewport, timing, evasion scripts
  • Parallel: batch fetches up to 10 pages simultaneously
  • JS rendering: full Chromium render, handles SPAs
  • Human-like: scroll patterns, typing delays, random waits
`);
  process.exit(0);
}

commands[cmd](rest).catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
