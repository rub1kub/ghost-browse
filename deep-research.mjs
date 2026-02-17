#!/usr/bin/env node
/**
 * deep-research.mjs — Multi-source research in one command
 * 
 * Searches across web (DDG/Bing/Google), Twitter, Reddit, HackerNews, GitHub
 * in parallel, reads top results, produces a unified markdown report.
 *
 * Usage:
 *   node deep-research.mjs "topic" [--sources web,twitter,reddit,hn,github] [--limit 5] [--max 3000] [--json]
 *
 * Examples:
 *   node deep-research.mjs "TON blockchain"
 *   node deep-research.mjs "AI agents 2026" --sources web,twitter,reddit
 *   node deep-research.mjs "Rust vs Go" --sources web,hn,github --limit 10
 */
process.env.DISPLAY = process.env.DISPLAY || ':99';

import { launch } from './browser-launcher.mjs';
import { waitForSlot } from './rate-limiter.mjs';
import { getCached, setCache } from './cache.mjs';
import { extractTwitterSearch } from './extractors.mjs';
import { extractRedditFeed } from './extractors.mjs';
import { extractHackerNews } from './extractors.mjs';
import { extractGitHubTrending } from './extractors.mjs';

// ─── Args ─────────────────────────────────────────────────────────────────────

function getArg(args, name, def) {
  const i = args.indexOf(`--${name}`);
  if (i !== -1 && args[i + 1] && !args[i + 1].startsWith('--')) return args[i + 1];
  const eq = args.find(a => a.startsWith(`--${name}=`));
  if (eq) return eq.split('=').slice(1).join('=');
  return def;
}

const args = process.argv.slice(2);
const topic = args.find(a => !a.startsWith('--'));
const sourcesArg = getArg(args, 'sources', 'web,twitter,reddit,hn');
const sources = sourcesArg.split(',').map(s => s.trim().toLowerCase());
const webEngine = getArg(args, 'engine', 'ddg');
const limit = parseInt(getArg(args, 'limit', '5'));
const maxChars = parseInt(getArg(args, 'max', '2500'));
const readPages = parseInt(getArg(args, 'read', '3'));
const jsonOut = args.includes('--json');
const concurrency = parseInt(getArg(args, 'concurrency', '3'));
const decompose = args.includes('--decompose');

if (!topic) {
  console.log(`
deep-research.mjs — Multi-source research in one command

Usage: node deep-research.mjs "topic" [options]

Options:
  --sources web,twitter,reddit,hn,github   Sources to search (default: web,twitter,reddit,hn)
  --engine ddg|bing|google                 Web search engine (default: ddg)
  --limit N                                Results per source (default: 5)
  --read N                                 Web pages to read in full (default: 3)
  --max N                                  Max chars per page (default: 2500)
  --concurrency N                          Parallel page reads (default: 3)
  --decompose                              Auto-decompose topic into sub-questions + keyword variations
  --json                                   JSON output

Examples:
  node deep-research.mjs "AI agents 2026"
  node deep-research.mjs "TON blockchain" --sources web,twitter,reddit
  node deep-research.mjs "Rust vs Go performance" --sources web,hn,github --engine bing
  node deep-research.mjs "OpenAI drama" --sources twitter,reddit,hn
  node deep-research.mjs "impact of AI on healthcare" --decompose
`);
  process.exit(0);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

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

const timer = () => {
  const start = Date.now();
  return () => ((Date.now() - start) / 1000).toFixed(1) + 's';
};

// ─── Topic Decomposition & Keyword Variations ─────────────────────────────────

/**
 * Decompose a broad topic into 3-5 sub-questions and generate
 * 2-3 keyword variations per question for wider search coverage.
 * Uses simple heuristics (no LLM needed).
 */
function decomposeTopic(topic) {
  const t = topic.toLowerCase().trim();
  const words = t.split(/\s+/).filter(w => w.length > 2);
  const core = words.filter(w => !['the','and','for','with','from','about','how','what','why','does','are','its'].includes(w));
  
  // Generate sub-questions based on common research angles
  const subQuestions = [];
  
  // 1. Current state / overview
  subQuestions.push({
    label: 'Overview & current state',
    queries: [
      topic,
      `${core.join(' ')} 2026 overview`,
      `${core.join(' ')} latest news`,
    ],
  });
  
  // 2. Key players / companies / projects
  subQuestions.push({
    label: 'Key players & projects',
    queries: [
      `${core.join(' ')} top companies projects`,
      `${core.join(' ')} leading players market`,
    ],
  });
  
  // 3. Technical details / how it works
  subQuestions.push({
    label: 'Technical details',
    queries: [
      `${core.join(' ')} how it works technical`,
      `${core.join(' ')} architecture explained`,
    ],
  });
  
  // 4. Challenges / risks / criticism
  subQuestions.push({
    label: 'Challenges & risks',
    queries: [
      `${core.join(' ')} challenges problems risks`,
      `${core.join(' ')} criticism concerns`,
    ],
  });
  
  // 5. Future outlook / trends
  subQuestions.push({
    label: 'Future outlook',
    queries: [
      `${core.join(' ')} future predictions trends`,
      `${core.join(' ')} roadmap next`,
    ],
  });
  
  return subQuestions;
}

// ─── Confidence & Cross-Reference Scoring ─────────────────────────────────────

/**
 * Compute confidence level for findings based on source coverage.
 * - HIGH: claim appears in 3+ sources
 * - MEDIUM: claim appears in 2 sources
 * - LOW: single source only (unverified)
 */
function computeConfidence(allResults) {
  const sourceCounts = {};
  let totalResults = 0;
  let sourcesWithData = 0;
  
  for (const r of allResults) {
    const count = r.results?.length || 0;
    sourceCounts[r.source] = count;
    totalResults += count;
    if (count > 0) sourcesWithData++;
  }
  
  // Overall confidence
  let level, emoji;
  if (sourcesWithData >= 3 && totalResults >= 10) {
    level = 'HIGH';
    emoji = '🟢';
  } else if (sourcesWithData >= 2 && totalResults >= 5) {
    level = 'MEDIUM';
    emoji = '🟡';
  } else {
    level = 'LOW';
    emoji = '🔴';
  }
  
  return { level, emoji, sourceCounts, totalResults, sourcesWithData };
}

/**
 * Cross-reference URLs across sources to find topics that appear
 * in multiple places (higher credibility).
 */
function crossReference(allResults) {
  const urlMap = new Map(); // url → Set of source names
  const titleMap = new Map(); // normalized title fragment → [{source, title, url}]
  
  for (const r of allResults) {
    for (const item of (r.results || [])) {
      const url = item.url || '';
      if (url) {
        if (!urlMap.has(url)) urlMap.set(url, new Set());
        urlMap.get(url).add(r.source);
      }
      // Also track by title keywords for fuzzy cross-ref
      const title = (item.title || item.text || '').toLowerCase();
      const titleWords = title.split(/\s+/).filter(w => w.length > 4).slice(0, 5).join(' ');
      if (titleWords.length > 10) {
        if (!titleMap.has(titleWords)) titleMap.set(titleWords, []);
        titleMap.get(titleWords).push({ source: r.source, title: item.title || item.text, url });
      }
    }
  }
  
  // Find items appearing in 2+ sources
  const crossRefs = [];
  for (const [url, sources] of urlMap) {
    if (sources.size >= 2) {
      crossRefs.push({ url, sources: [...sources], type: 'exact-url' });
    }
  }
  for (const [key, items] of titleMap) {
    const uniqueSources = new Set(items.map(i => i.source));
    if (uniqueSources.size >= 2) {
      crossRefs.push({
        title: items[0].title,
        sources: [...uniqueSources],
        type: 'similar-topic',
        items,
      });
    }
  }
  
  return crossRefs;
}

// ─── Source: Web Search ───────────────────────────────────────────────────────

async function searchWeb(page, query, engine) {
  const elapsed = timer();
  try {
    let results = [];
    
    if (engine === 'google') {
      await waitForSlot('google.com');
      await page.goto(`https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en`, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await new Promise(r => setTimeout(r, 2000));
      for (const sel of ['#L2AGLb', 'button[aria-label*="Reject"]']) {
        try { const b = await page.$(sel); if (b) { await b.click(); await new Promise(r => setTimeout(r, 500)); } } catch {}
      }
      results = await page.evaluate(() => {
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
    } else if (engine === 'bing') {
      await waitForSlot('bing.com');
      await page.goto(`https://www.bing.com/search?q=${encodeURIComponent(query)}`, { waitUntil: 'domcontentloaded', timeout: 25000 });
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
      results = raw.map(r => ({ ...r, url: decodeBingUrl(r.url) }));
    } else {
      // DDG
      await waitForSlot('duckduckgo.com');
      await page.goto(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { waitUntil: 'domcontentloaded', timeout: 25000 });
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
      results = raw.map(r => {
        try { const m = r.url.match(/uddg=([^&]+)/); if (m) r.url = decodeURIComponent(m[1]); } catch {}
        return r;
      }).filter(r => r.url && !r.url.includes('duckduckgo.com'));
    }

    console.log(`  ✅ Web [${engine}]: ${results.length} results (${elapsed()})`);
    return { source: 'web', engine, results: results.slice(0, limit), time: elapsed() };
  } catch (e) {
    console.log(`  ❌ Web [${engine}]: ${e.message.slice(0, 60)} (${elapsed()})`);
    return { source: 'web', engine, results: [], error: e.message, time: elapsed() };
  }
}

// ─── Source: Twitter ──────────────────────────────────────────────────────────

async function searchTwitter(page, query) {
  const elapsed = timer();
  try {
    await waitForSlot('x.com');
    const searchUrl = `https://x.com/search?q=${encodeURIComponent(query)}&src=typed_query&f=live`;
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await Promise.race([
      page.waitForSelector('[data-testid="tweet"]', { timeout: 15000 }),
      new Promise(r => setTimeout(r, 12000)),
    ]);
    await new Promise(r => setTimeout(r, 2000));

    const tweets = await page.evaluate(() => {
      const items = [];
      document.querySelectorAll('[data-testid="tweet"]').forEach(el => {
        const userEl = el.querySelector('[data-testid="User-Name"]');
        const textEl = el.querySelector('[data-testid="tweetText"]');
        const timeEl = el.querySelector('time');
        const linkEl = el.querySelector('a[href*="/status/"]');

        const stats = { likes: '0', retweets: '0', replies: '0' };
        el.querySelectorAll('[role="group"] button').forEach((btn, idx) => {
          const text = btn.textContent.trim();
          if (text && /^\d/.test(text)) {
            if (idx === 0) stats.replies = text;
            else if (idx === 1) stats.retweets = text;
            else if (idx === 2) stats.likes = text;
          }
        });
        // aria-label fallback
        el.querySelectorAll('[role="button"][aria-label]').forEach(btn => {
          const label = btn.getAttribute('aria-label') || '';
          const num = label.match(/([\d,.KkMm]+)/)?.[1] || '';
          if (num) {
            if (/like/i.test(label)) stats.likes = num;
            else if (/repost|retweet/i.test(label)) stats.retweets = num;
            else if (/repl/i.test(label)) stats.replies = num;
          }
        });

        if (textEl) {
          items.push({
            user: userEl?.textContent?.trim()?.split('\n')?.[0] || '',
            text: textEl.textContent.trim(),
            time: timeEl?.getAttribute('datetime'),
            url: linkEl ? `https://x.com${linkEl.getAttribute('href')}` : null,
            likes: stats.likes,
            retweets: stats.retweets,
            replies: stats.replies,
          });
        }
      });
      return items;
    });

    console.log(`  ✅ Twitter: ${tweets.length} tweets (${elapsed()})`);
    return { source: 'twitter', results: tweets.slice(0, limit), time: elapsed() };
  } catch (e) {
    console.log(`  ❌ Twitter: ${e.message.slice(0, 60)} (${elapsed()})`);
    return { source: 'twitter', results: [], error: e.message, time: elapsed() };
  }
}

// ─── Source: Reddit ───────────────────────────────────────────────────────────

async function searchReddit(page, query) {
  const elapsed = timer();
  try {
    await waitForSlot('reddit.com');

    // Strategy 1: JSON API (most reliable)
    try {
      const jsonUrl = `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=relevance&t=month&limit=25`;
      await page.goto(jsonUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await new Promise(r => setTimeout(r, 1500));
      const jsonText = await page.evaluate(() => document.querySelector('pre')?.textContent || document.body.innerText);
      const data = JSON.parse(jsonText);
      const posts = (data?.data?.children || []).map(({ data: p }) => ({
        title: p.title,
        url: `https://reddit.com${p.permalink}`,
        subreddit: p.subreddit_name_prefixed || `r/${p.subreddit}`,
        author: `u/${p.author}`,
        score: p.score,
        comments: p.num_comments,
      })).filter(p => p.title);

      if (posts.length > 0) {
        console.log(`  ✅ Reddit: ${posts.length} posts (${elapsed()})`);
        return { source: 'reddit', results: posts.slice(0, limit), time: elapsed() };
      }
    } catch {}

    // Strategy 2: HTML search with shreddit-post
    await page.goto(`https://www.reddit.com/search/?q=${encodeURIComponent(query)}&sort=relevance&t=month`, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await Promise.race([
      page.waitForSelector('shreddit-post', { timeout: 10000 }),
      new Promise(r => setTimeout(r, 8000)),
    ]);
    // Extra wait for shreddit components to hydrate
    await new Promise(r => setTimeout(r, 2000));
    
    const posts = await page.evaluate(() => {
      const results = [];
      document.querySelectorAll('shreddit-post').forEach(el => {
        const permalink = el.getAttribute('permalink') || '';
        results.push({
          title: el.getAttribute('post-title') || '',
          url: permalink ? `https://reddit.com${permalink}` : '',
          subreddit: el.getAttribute('subreddit-prefixed-name') || '',
          author: el.getAttribute('author') ? `u/${el.getAttribute('author')}` : '',
          score: parseInt(el.getAttribute('score') || '0'),
          comments: parseInt(el.getAttribute('comment-count') || '0'),
        });
      });
      return results;
    });

    const filtered = posts.filter(p => p.title);
    console.log(`  ✅ Reddit: ${filtered.length} posts (${elapsed()})`);
    return { source: 'reddit', results: filtered.slice(0, limit), time: elapsed() };
  } catch (e) {
    console.log(`  ❌ Reddit: ${e.message.slice(0, 60)} (${elapsed()})`);
    return { source: 'reddit', results: [], error: e.message, time: elapsed() };
  }
}

// ─── Source: HackerNews ───────────────────────────────────────────────────────

async function searchHN(page, query) {
  const elapsed = timer();
  try {
    // Use Algolia HN search for better results
    await page.goto(`https://hn.algolia.com/?dateRange=pastMonth&page=0&prefix=true&query=${encodeURIComponent(query)}&sort=byPopularity&type=story`, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await new Promise(r => setTimeout(r, 3000));

    const stories = await page.evaluate(() => {
      const items = [];
      document.querySelectorAll('.Story').forEach(el => {
        const titleEl = el.querySelector('.Story_title a');
        const pointsEl = el.querySelector('.Story_meta span');
        const commentsEl = el.querySelector('.Story_comment a');
        if (titleEl) {
          items.push({
            title: titleEl.textContent.trim(),
            url: titleEl.href,
            points: pointsEl?.textContent?.trim() || '0',
            comments: commentsEl?.textContent?.trim() || '0',
            commentsUrl: commentsEl?.href || '',
          });
        }
      });
      return items;
    });

    // Fallback to HN front page if Algolia fails
    if (stories.length === 0) {
      const hnResults = await extractHackerNews(page, 'top');
      console.log(`  ✅ HN (front page): ${hnResults.length} stories (${elapsed()})`);
      return { source: 'hn', results: hnResults.slice(0, limit), time: elapsed() };
    }

    console.log(`  ✅ HN: ${stories.length} stories (${elapsed()})`);
    return { source: 'hn', results: stories.slice(0, limit), time: elapsed() };
  } catch (e) {
    console.log(`  ❌ HN: ${e.message.slice(0, 60)} (${elapsed()})`);
    return { source: 'hn', results: [], error: e.message, time: elapsed() };
  }
}

// ─── Source: GitHub ───────────────────────────────────────────────────────────

async function searchGitHub(page, query) {
  const elapsed = timer();
  try {
    await page.goto(`https://github.com/search?q=${encodeURIComponent(query)}&type=repositories&s=stars&o=desc`, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await new Promise(r => setTimeout(r, 3000));

    const repos = await page.evaluate(() => {
      const items = [];
      document.querySelectorAll('[data-testid="results-list"] > div, .repo-list-item, article').forEach(el => {
        const nameEl = el.querySelector('a[href*="/"]');
        const descEl = el.querySelector('p, .mb-1');
        const langEl = el.querySelector('[itemprop="programmingLanguage"], span.repo-language-color + span');
        const starsEl = el.querySelector('a[href*="/stargazers"]');
        if (nameEl && nameEl.textContent.includes('/')) {
          items.push({
            name: nameEl.textContent.replace(/\s+/g, ' ').trim(),
            url: nameEl.href?.startsWith('http') ? nameEl.href : `https://github.com${nameEl.getAttribute('href')}`,
            description: descEl?.textContent?.trim()?.slice(0, 200) || '',
            language: langEl?.textContent?.trim() || '',
            stars: starsEl?.textContent?.trim() || '',
          });
        }
      });
      return items;
    });

    console.log(`  ✅ GitHub: ${repos.length} repos (${elapsed()})`);
    return { source: 'github', results: repos.slice(0, limit), time: elapsed() };
  } catch (e) {
    console.log(`  ❌ GitHub: ${e.message.slice(0, 60)} (${elapsed()})`);
    return { source: 'github', results: [], error: e.message, time: elapsed() };
  }
}

// ─── Read web pages ───────────────────────────────────────────────────────────

async function readPage(context, url, maxC) {
  const cached = getCached(url, 600000);
  if (cached) return { ...cached, fromCache: true };

  // Skip PDFs — can't render in browser, use pdf-extract instead
  if (url.match(/\.pdf(\?|$)/i)) {
    try {
      const { execSync } = await import('child_process');
      const __dir2 = (await import('path')).dirname((await import('url')).fileURLToPath(import.meta.url));
      const output = execSync(`node "${__dir2}/pdf-extract.mjs" "${url}" --max ${maxC}`, { encoding: 'utf8', timeout: 30000 });
      // Extract content after the header lines
      const lines = output.split('\n');
      const contentStart = lines.findIndex(l => !l.startsWith('📄') && !l.startsWith('🔗') && !l.startsWith('📥') && l.trim());
      const content = lines.slice(Math.max(contentStart, 0)).join('\n').trim().slice(0, maxC);
      const data = { title: url.split('/').pop(), url, content: content || '[PDF extracted but empty]' };
      setCache(url, data);
      return data;
    } catch (e) {
      return { title: 'PDF Error', url, content: `[PDF extraction failed: ${e.message.slice(0, 80)}]`, error: true };
    }
  }

  const page = await context.newPage();
  try {
    await waitForSlot(url);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await new Promise(r => setTimeout(r, 1500));
    const result = await page.evaluate(() => {
      const clone = document.body.cloneNode(true);
      ['script', 'style', 'nav', 'footer', 'header', 'aside', 'iframe', 'noscript'].forEach(t => clone.querySelectorAll(t).forEach(e => e.remove()));
      return { title: document.title, html: clone.innerHTML };
    });
    const content = htmlToText(result.html).slice(0, maxC);
    const data = { title: result.title, url, content };
    setCache(url, data);
    return data;
  } catch (e) {
    return { title: 'Error', url, content: `[Failed: ${e.message.slice(0, 80)}]`, error: true };
  } finally {
    await page.close();
  }
}

// ─── Markdown report ──────────────────────────────────────────────────────────

function generateReport(topic, results, pageContents, { confidence, crossRefs, subQuestions } = {}) {
  const lines = [];
  lines.push(`# Research: ${topic}`);
  
  // Confidence header
  const confStr = confidence 
    ? ` | Confidence: ${confidence.emoji} ${confidence.level} (${confidence.sourcesWithData} sources, ${confidence.totalResults} results)`
    : '';
  lines.push(`_${new Date().toISOString().slice(0, 16)} UTC | Sources: ${results.map(r => r.source).join(', ')}${confStr}_\n`);
  
  // Sub-questions used (if decompose mode)
  if (subQuestions && subQuestions.length) {
    lines.push(`## 🔍 Research Sub-Questions`);
    subQuestions.forEach((sq, i) => {
      lines.push(`${i + 1}. **${sq.label}**: ${sq.queries.slice(0, 2).join(' / ')}`);
    });
    lines.push('');
  }
  
  // Cross-references (items appearing in multiple sources)
  if (crossRefs && crossRefs.length) {
    lines.push(`## 🔗 Cross-Referenced (appeared in 2+ sources)`);
    crossRefs.slice(0, 10).forEach(cr => {
      if (cr.title) {
        lines.push(`- **${cr.title.slice(0, 100)}** — found in: ${cr.sources.join(', ')}`);
      } else {
        lines.push(`- ${cr.url} — found in: ${cr.sources.join(', ')}`);
      }
    });
    lines.push('');
  }

  // Web results + page contents
  const web = results.find(r => r.source === 'web');
  if (web && web.results.length) {
    lines.push(`## 🌐 Web Search [${web.engine}] (${web.time})`);
    web.results.forEach((r, i) => {
      lines.push(`${i + 1}. **${r.title}**`);
      lines.push(`   ${r.url}`);
      if (r.snippet) lines.push(`   > ${r.snippet.slice(0, 200)}`);
    });
    lines.push('');
  }

  // Page contents
  if (pageContents.length) {
    lines.push(`## 📖 Read Pages (${pageContents.length})`);
    pageContents.forEach((p, i) => {
      if (p.error) {
        lines.push(`### ${i + 1}. ❌ ${p.url}\n`);
      } else {
        lines.push(`### ${i + 1}. ${p.title}`);
        lines.push(`${p.url}${p.fromCache ? ' (cached)' : ''}\n`);
        lines.push(p.content.slice(0, maxChars));
        lines.push('');
      }
    });
  }

  // Twitter
  const tw = results.find(r => r.source === 'twitter');
  if (tw && tw.results.length) {
    lines.push(`## 🐦 Twitter/X (${tw.time})`);
    tw.results.forEach((r, i) => {
      lines.push(`${i + 1}. **@${r.user?.split('@')?.[0]?.trim() || '?'}**: ${r.text?.slice(0, 200)}`);
      if (r.url) lines.push(`   ${r.url}`);
      lines.push(`   ❤️ ${r.likes || 0} | 🔄 ${r.retweets || 0} | 💬 ${r.replies || 0}`);
    });
    lines.push('');
  }

  // Reddit
  const rd = results.find(r => r.source === 'reddit');
  if (rd && rd.results.length) {
    lines.push(`## 🤖 Reddit (${rd.time})`);
    rd.results.forEach((r, i) => {
      lines.push(`${i + 1}. **${r.title}** (${r.subreddit})`);
      if (r.url) lines.push(`   ${r.url}`);
      lines.push(`   ⬆️ ${r.score} | 💬 ${r.comments}`);
    });
    lines.push('');
  }

  // HN
  const hn = results.find(r => r.source === 'hn');
  if (hn && hn.results.length) {
    lines.push(`## 🟧 HackerNews (${hn.time})`);
    hn.results.forEach((r, i) => {
      lines.push(`${i + 1}. **${r.title}** — ${r.points}`);
      if (r.url) lines.push(`   ${r.url}`);
      if (r.commentsUrl) lines.push(`   💬 ${r.comments} — ${r.commentsUrl}`);
    });
    lines.push('');
  }

  // GitHub
  const gh = results.find(r => r.source === 'github');
  if (gh && gh.results.length) {
    lines.push(`## 🐙 GitHub (${gh.time})`);
    gh.results.forEach((r, i) => {
      lines.push(`${i + 1}. **${r.name}**${r.language ? ` [${r.language}]` : ''}${r.stars ? ` ★${r.stars}` : ''}`);
      if (r.description) lines.push(`   ${r.description}`);
      if (r.url) lines.push(`   ${r.url}`);
    });
    lines.push('');
  }

  // Errors
  const errors = results.filter(r => r.error);
  if (errors.length) {
    lines.push(`## ⚠️ Errors`);
    errors.forEach(r => lines.push(`- ${r.source}: ${r.error}`));
    lines.push('');
  }

  return lines.join('\n');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const totalTimer = timer();
console.log(`\n🔬 Deep Research: "${topic}"`);
console.log(`   Sources: ${sources.join(', ')} | Engine: ${webEngine} | Limit: ${limit} | Read: ${readPages}${decompose ? ' | Decompose: ON' : ''}\n`);

// Topic decomposition
let subQuestions = null;
let searchQueries = [topic]; // default: just the topic itself
if (decompose) {
  subQuestions = decomposeTopic(topic);
  searchQueries = [...new Set(subQuestions.flatMap(sq => sq.queries))]; // unique queries
  console.log(`📋 Decomposed into ${subQuestions.length} sub-questions (${searchQueries.length} total queries):`);
  subQuestions.forEach((sq, i) => console.log(`   ${i + 1}. ${sq.label}: "${sq.queries[0]}"`));
  console.log('');
}

// Launch browser once — reuse for all sources
const browser = await launch({ profile: sources.includes('twitter') ? 'x-com' : null });
const allResults = [];

// Phase 1: Search all sources in parallel (each gets its own page)
const searchJobs = [];

if (sources.includes('web')) {
  if (decompose && searchQueries.length > 1) {
    // In decompose mode: run multiple web searches (first query per sub-question)
    const webQueries = subQuestions.map(sq => sq.queries[0]);
    searchJobs.push((async () => {
      const combinedResults = [];
      const seen = new Set();
      const elapsed = timer();
      for (const q of webQueries) {
        const page = await browser.context.newPage();
        try {
          const r = await searchWeb(page, q, webEngine);
          for (const item of (r.results || [])) {
            if (!seen.has(item.url)) {
              seen.add(item.url);
              combinedResults.push(item);
            }
          }
        } finally { await page.close(); }
      }
      console.log(`  📊 Web combined: ${combinedResults.length} unique results from ${webQueries.length} queries (${elapsed()})`);
      return { source: 'web', engine: webEngine, results: combinedResults.slice(0, limit * 2), time: elapsed() };
    })());
  } else {
    searchJobs.push((async () => {
      const page = await browser.context.newPage();
      try { return await searchWeb(page, topic, webEngine); }
      finally { await page.close(); }
    })());
  }
}
if (sources.includes('twitter')) {
  searchJobs.push((async () => {
    const page = await browser.context.newPage();
    try { return await searchTwitter(page, topic); }
    finally { await page.close(); }
  })());
}
if (sources.includes('reddit')) {
  searchJobs.push((async () => {
    const page = await browser.context.newPage();
    try { return await searchReddit(page, topic); }
    finally { await page.close(); }
  })());
}
if (sources.includes('hn')) {
  searchJobs.push((async () => {
    const page = await browser.context.newPage();
    try { return await searchHN(page, topic); }
    finally { await page.close(); }
  })());
}
if (sources.includes('github')) {
  searchJobs.push((async () => {
    const page = await browser.context.newPage();
    try { return await searchGitHub(page, topic); }
    finally { await page.close(); }
  })());
}

// Add timeout wrapper per source (30s max)
const SOURCE_TIMEOUT = 30000;
function withTimeout(promise, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${SOURCE_TIMEOUT/1000}s`)), SOURCE_TIMEOUT)),
  ]);
}

const searchResults = await Promise.allSettled(
  searchJobs.map((job, i) => withTimeout(job, `Source ${i}`))
);
searchResults.forEach(r => {
  if (r.status === 'fulfilled' && r.value) allResults.push(r.value);
  else if (r.status === 'rejected') console.log(`  ❌ Source failed: ${r.reason?.message?.slice(0, 60)}`);
});

// Phase 2: Read top web pages in full
let pageContents = [];
const webResult = allResults.find(r => r.source === 'web');
if (webResult && webResult.results.length > 0 && readPages > 0) {
  console.log(`\n📖 Reading top ${Math.min(readPages, webResult.results.length)} pages...`);
  const urlsToRead = webResult.results.slice(0, readPages);
  
  for (let i = 0; i < urlsToRead.length; i += concurrency) {
    const batch = urlsToRead.slice(i, i + concurrency);
    const fetched = await Promise.allSettled(
      batch.map(sr => readPage(browser.context, sr.url, maxChars))
    );
    fetched.forEach(r => {
      if (r.status === 'fulfilled') {
        pageContents.push(r.value);
        console.log(`  ✅ Read: ${r.value.title?.slice(0, 50)} (${r.value.content?.length || 0} chars${r.value.fromCache ? ', cached' : ''})`);
      } else {
        pageContents.push({ error: true, url: '?', content: r.reason?.message });
      }
    });
  }
}

await browser.close();

// Phase 3: Compute confidence & cross-references
const confidence = computeConfidence(allResults);
const crossRefs = crossReference(allResults);

// Phase 4: Output
const totalTime = totalTimer();
console.log(`\n✅ Research complete in ${totalTime}`);
console.log(`   Confidence: ${confidence.emoji} ${confidence.level} | Sources with data: ${confidence.sourcesWithData}/${allResults.length} | Total results: ${confidence.totalResults}`);
if (crossRefs.length) console.log(`   Cross-referenced topics: ${crossRefs.length}`);

if (jsonOut) {
  console.log(JSON.stringify({
    topic,
    confidence,
    crossRefs,
    subQuestions: subQuestions || null,
    sources: allResults,
    pageContents,
    totalTime,
  }, null, 2));
} else {
  const report = generateReport(topic, allResults, pageContents, { confidence, crossRefs, subQuestions });
  console.log(`\n${'═'.repeat(70)}\n`);
  console.log(report);
}
