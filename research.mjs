#!/usr/bin/env node
/**
 * research.mjs — Search + read + summarize in one command
 * Usage: node research.mjs "topic" [--limit 5] [--engine google|ddg|bing] [--max 3000] [--profile name] [--json]
 */
process.env.DISPLAY = process.env.DISPLAY || ':99';

import { launch } from './browser-launcher.mjs';
import { waitForSlot } from './rate-limiter.mjs';

function getArg(args, name, def) {
  const i = args.indexOf(`--${name}`);
  if (i !== -1 && args[i + 1] && !args[i + 1].startsWith('--')) return args[i + 1];
  const eq = args.find(a => a.startsWith(`--${name}=`));
  if (eq) return eq.split('=').slice(1).join('=');
  return def;
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

// ─── Bing URL decoder ─────────────────────────────────────────────────────────

function decodeBingUrl(url) {
  if (!url || !url.includes('bing.com/ck/')) return url;
  try {
    const match = url.match(/[&?]u=a1([^&]+)/);
    if (match) {
      const decoded = Buffer.from(match[1], 'base64url').toString('utf8');
      if (decoded.startsWith('http')) return decoded;
    }
  } catch {}
  return url;
}

async function searchDDG(page, query) {
  await waitForSlot('duckduckgo.com');
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
  await waitForSlot('google.com');
  await page.goto(`https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await new Promise(r => setTimeout(r, 2000));
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

async function searchBing(page, query) {
  await waitForSlot('bing.com');
  await page.goto(`https://www.bing.com/search?q=${encodeURIComponent(query)}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await new Promise(r => setTimeout(r, 1500));
  const raw = await page.evaluate(() => {
    const items = [];
    document.querySelectorAll('li.b_algo').forEach(el => {
      const t = el.querySelector('h2 a');
      const s = el.querySelector('.b_caption p, .b_algoSlug');
      if (t) items.push({ title: t.textContent.trim(), url: t.href, snippet: s?.textContent?.trim() || '' });
    });
    return items;
  });
  return raw.map(r => ({ ...r, url: decodeBingUrl(r.url) }));
}

async function fetchPageContent(page, url, maxChars = 4000) {
  try {
    await waitForSlot(url);
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
const profile = getArg(args, 'profile', engine === 'google' ? 'google-com' : null);

if (!query) {
  console.log(`
research.mjs — Search + read top results in one command

Usage: node research.mjs "topic" [--limit 5] [--engine google|ddg|bing] [--max 3000] [--profile name] [--json]

Examples:
  node research.mjs "TON blockchain news 2026"
  node research.mjs "best Node.js frameworks" --engine google --limit 10
  node research.mjs "AI regulation EU" --json
`);
  process.exit(0);
}

console.log(`\n🔍 Researching: "${query}" [${engine}] — reading top ${limit} results...\n`);

const browser = await launch({ profile });
const searchPage = await browser.context.newPage();

let searchResults;
if (engine === 'google') searchResults = await searchGoogle(searchPage, query);
else if (engine === 'bing') searchResults = await searchBing(searchPage, query);
else searchResults = await searchDDG(searchPage, query);

const urls = searchResults.slice(0, limit);
console.log(`Found ${searchResults.length} results, reading top ${urls.length}...\n`);
await searchPage.close();

const allResults = [];
for (let i = 0; i < urls.length; i += concurrency) {
  const batch = urls.slice(i, i + concurrency);
  const fetched = await Promise.allSettled(batch.map(async (sr) => {
    const page = await browser.context.newPage();
    const result = await fetchPageContent(page, sr.url, maxChars);
    await page.close();
    return { ...sr, ...result };
  }));
  fetched.forEach(r => {
    if (r.status === 'fulfilled') allResults.push(r.value);
    else allResults.push({ error: true, content: r.reason?.message });
  });
}

await browser.close();

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
