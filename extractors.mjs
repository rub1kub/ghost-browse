#!/usr/bin/env node
/**
 * extractors.mjs — Site-specific content extractors
 * Structured data from Twitter/X, Reddit, HackerNews, GitHub, etc.
 */

// ─── Twitter / X ─────────────────────────────────────────────────────────────

export async function extractTwitterTimeline(page, opts = {}) {
  await page.waitForSelector('[data-testid="tweet"]', { timeout: 15000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 2000));

  return await page.evaluate(() => {
    const tweets = [];
    document.querySelectorAll('[data-testid="tweet"]').forEach(el => {
      const userEl = el.querySelector('[data-testid="User-Name"]');
      const textEl = el.querySelector('[data-testid="tweetText"]');
      const timeEl = el.querySelector('time');
      const statsEl = el.querySelectorAll('[data-testid$="-count"]');

      const stats = {};
      statsEl.forEach(s => {
        const key = s.getAttribute('data-testid')?.replace('-count', '');
        if (key) stats[key] = s.textContent.trim();
      });

      const linkEl = el.querySelector('a[href*="/status/"]');
      const tweetUrl = linkEl ? `https://x.com${linkEl.getAttribute('href')}` : null;

      if (textEl) {
        tweets.push({
          user: userEl?.textContent?.trim()?.split('\n')?.[0] || '',
          text: textEl.textContent.trim(),
          time: timeEl?.getAttribute('datetime'),
          url: tweetUrl,
          likes: stats.like || '0',
          retweets: stats.retweet || '0',
          replies: stats.reply || '0',
        });
      }
    });
    return tweets;
  });
}

export async function extractTwitterSearch(page, query) {
  const searchUrl = `https://x.com/search?q=${encodeURIComponent(query)}&src=typed_query&f=live`;
  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await new Promise(r => setTimeout(r, 3000));
  return extractTwitterTimeline(page);
}

// ─── Reddit ──────────────────────────────────────────────────────────────────

export async function extractRedditFeed(page, subreddit = '', sort = 'hot') {
  // Use Reddit's JSON API for reliability
  const url = subreddit
    ? `https://www.reddit.com/r/${subreddit}/${sort}/.json?limit=25`
    : `https://www.reddit.com/${sort}/.json?limit=25`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await new Promise(r => setTimeout(r, 1500));

  // Parse JSON API response
  const jsonText = await page.evaluate(() => {
    try {
      const pre = document.querySelector('pre');
      return pre ? pre.textContent : document.body.innerText;
    } catch { return ''; }
  });

  try {
    const data = JSON.parse(jsonText);
    const posts = (data?.data?.children || []).map(({ data: p }) => ({
      title: p.title,
      url: p.url?.startsWith('/r/') ? `https://reddit.com${p.url}` : p.url,
      commentsUrl: `https://reddit.com${p.permalink}`,
      subreddit: p.subreddit_name_prefixed || `r/${p.subreddit}`,
      author: `u/${p.author}`,
      score: p.score,
      comments: p.num_comments,
      time: p.created_utc ? new Date(p.created_utc * 1000).toISOString() : null,
      flair: p.link_flair_text,
    }));
    return posts.filter(p => p.title);
  } catch {
    return [];
  }
}

export async function extractRedditComments(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await new Promise(r => setTimeout(r, 2000));

  return await page.evaluate(() => {
    const post = {
      title: document.querySelector('h1')?.textContent?.trim() || '',
      body: document.querySelector('[data-test-id="post-content"] [data-click-id="text"]')?.textContent?.trim() || '',
    };

    const comments = [];
    document.querySelectorAll('[data-testid="comment"]').forEach(el => {
      const authorEl = el.querySelector('[data-testid="comment_author_link"]');
      const bodyEl = el.querySelector('[data-testid="comment"] > div p, .md');
      const scoreEl = el.querySelector('[id*="vote-arrows"]');
      if (bodyEl) {
        comments.push({
          author: authorEl?.textContent?.trim() || '[deleted]',
          body: bodyEl.textContent.trim(),
          score: scoreEl?.textContent?.trim() || '',
        });
      }
    });

    return { post, comments };
  });
}

// ─── HackerNews ───────────────────────────────────────────────────────────────

export async function extractHackerNews(page, type = 'top') {
  const urls = { top: 'https://news.ycombinator.com/', new: 'https://news.ycombinator.com/newest', ask: 'https://news.ycombinator.com/ask', show: 'https://news.ycombinator.com/show' };
  await page.goto(urls[type] || urls.top, { waitUntil: 'domcontentloaded', timeout: 30000 });

  return await page.evaluate(() => {
    const items = [];
    document.querySelectorAll('.athing').forEach(el => {
      const titleEl = el.querySelector('.titleline a');
      const subEl = el.nextElementSibling?.querySelector('.subtext');
      const score = subEl?.querySelector('.score')?.textContent?.trim();
      const comments = subEl?.querySelectorAll('a');
      const commentsLink = Array.from(comments || []).find(a => a.href.includes('item?'));

      if (titleEl) {
        items.push({
          id: el.id,
          title: titleEl.textContent.trim(),
          url: titleEl.href,
          points: score || '0',
          comments: commentsLink?.textContent?.trim() || '0',
          commentsUrl: commentsLink?.href || '',
        });
      }
    });
    return items;
  });
}

// ─── GitHub ───────────────────────────────────────────────────────────────────

export async function extractGitHubTrending(page, lang = '', period = 'daily') {
  const url = `https://github.com/trending/${lang}?since=${period}`;
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForSelector('article.Box-row', { timeout: 8000 }).catch(() => {});

  return await page.evaluate(() => {
    const repos = [];
    document.querySelectorAll('article.Box-row').forEach(el => {
      const nameEl = el.querySelector('h2 a');
      const descEl = el.querySelector('p');
      const langEl = el.querySelector('[itemprop="programmingLanguage"]');
      const starsEl = el.querySelector('a[href*="/stargazers"]');
      const todayEl = el.querySelector('.d-inline-block.float-sm-right');

      if (nameEl) {
        repos.push({
          name: nameEl.textContent.replace(/\s+/g, ' ').trim(),
          url: `https://github.com${nameEl.getAttribute('href')}`,
          description: descEl?.textContent?.trim() || '',
          language: langEl?.textContent?.trim() || '',
          stars: starsEl?.textContent?.trim() || '0',
          starsToday: todayEl?.textContent?.trim() || '',
        });
      }
    });
    return repos;
  });
}

// ─── Generic news site ────────────────────────────────────────────────────────

export async function extractArticle(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await new Promise(r => setTimeout(r, 1500));

  return await page.evaluate(() => {
    // Try JSON-LD structured data first
    const jsonLd = document.querySelector('script[type="application/ld+json"]');
    if (jsonLd) {
      try {
        const data = JSON.parse(jsonLd.textContent);
        if (data.articleBody) return { title: data.headline, content: data.articleBody, author: data.author?.name, published: data.datePublished };
      } catch {}
    }

    // Semantic HTML
    const title = document.querySelector('h1')?.textContent?.trim() || document.title;
    const article = document.querySelector('article, [role="main"], .post-content, .article-content, .entry-content');
    const content = article ? article.innerText.trim() : document.body.innerText.slice(0, 10000);

    return { title, content, url: window.location.href };
  });
}

// ─── Command line interface ───────────────────────────────────────────────────

const EXTRACTORS = {
  'twitter-timeline': { fn: extractTwitterTimeline, url: 'https://x.com/home' },
  'twitter-search': { fn: extractTwitterSearch, url: null },
  'reddit-feed': { fn: extractRedditFeed, url: 'https://www.reddit.com/hot/' },
  'reddit-comments': { fn: extractRedditComments, url: null },
  'hackernews': { fn: extractHackerNews, url: 'https://news.ycombinator.com/' },
  'github-trending': { fn: extractGitHubTrending, url: 'https://github.com/trending' },
  'article': { fn: extractArticle, url: null },
};

if (process.argv[1]?.endsWith('extractors.mjs')) {
  const [,, extractor, ...args] = process.argv;

  if (!extractor || !EXTRACTORS[extractor]) {
    console.log(`
extractors.mjs — Site-specific extractors

Available:
  twitter-timeline          Fetch your X/Twitter home timeline (needs --profile x-com)
  twitter-search "query"    Search Twitter
  reddit-feed [subreddit]   Reddit feed (hot posts)
  reddit-comments <url>     Comments on a Reddit post
  hackernews [top|new|ask]  HackerNews front page
  github-trending [lang]    GitHub trending repos
  article <url>             Extract article content

Flags: --profile <name> --json --limit N

Examples:
  node extractors.mjs twitter-timeline --profile x-com --limit 20
  node extractors.mjs reddit-feed programming --profile reddit-com
  node extractors.mjs twitter-search "TON blockchain" --profile x-com
  node extractors.mjs hackernews top
  node extractors.mjs github-trending javascript
`);
    process.exit(0);
  }

  const { chromium } = await import('playwright');
  const { existsSync, readFileSync } = await import('fs');
  const { join, dirname } = await import('path');
  const { fileURLToPath } = await import('url');

  const __dir = dirname(fileURLToPath(import.meta.url));

  const profileName = args.find((a, i) => args[i-1] === '--profile') || args.find(a => a === '--profile' ? args[args.indexOf(a)+1] : false);
  const jsonOut = args.includes('--json');
  const limit = parseInt(args.find((a, i) => args[i-1] === '--limit') || '50');

  // Simple arg parsing
  let profileArg = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--profile' && args[i+1]) { profileArg = args[i+1]; break; }
  }

  let profileData = null;
  if (profileArg) {
    const pPath = join(__dir, 'profiles', `${profileArg}.json`);
    if (existsSync(pPath)) profileData = JSON.parse(readFileSync(pPath, 'utf8'));
    else console.warn(`Profile "${profileArg}" not found`);
  }

  const browser = await chromium.launch({
    headless: true,
    executablePath: existsSync('/home/openclawd/.openclaw/bin/chrome-xvfb') ? '/home/openclawd/.openclaw/bin/chrome-xvfb' : undefined,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
  });

  const ctxOpts = {
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
  };
  if (profileData?.cookies) {
    ctxOpts.storageState = { cookies: profileData.cookies, origins: [] };
  }

  const context = await browser.newContext(ctxOpts);
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
  });

  const page = await context.newPage();
  const positionalArgs = args.filter(a => !a.startsWith('--') && a !== profileArg);

  let result;
  try {
    if (extractor === 'twitter-timeline') result = await extractTwitterTimeline(page);
    else if (extractor === 'twitter-search') result = await extractTwitterSearch(page, positionalArgs[0] || 'trending');
    else if (extractor === 'reddit-feed') result = await extractRedditFeed(page, positionalArgs[0] || '', positionalArgs[1] || 'hot');
    else if (extractor === 'reddit-comments') result = await extractRedditComments(page, positionalArgs[0]);
    else if (extractor === 'hackernews') result = await extractHackerNews(page, positionalArgs[0] || 'top');
    else if (extractor === 'github-trending') result = await extractGitHubTrending(page, positionalArgs[0] || '', positionalArgs[1] || 'daily');
    else if (extractor === 'article') result = await extractArticle(page, positionalArgs[0]);

    if (Array.isArray(result)) result = result.slice(0, limit);

    if (jsonOut) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`\n📊 ${extractor} results:\n`);
      if (Array.isArray(result)) {
        result.forEach((r, i) => {
          console.log(`${i+1}. ${r.title || r.text?.slice(0,100) || r.name || r.body?.slice(0,80) || JSON.stringify(r).slice(0,100)}`);
          if (r.url) console.log(`   ${r.url}`);
          if (r.score || r.points || r.likes) console.log(`   ⭐ ${r.score || r.points || r.likes} | 💬 ${r.comments || r.replies || '0'}`);
          console.log();
        });
      } else {
        console.log(JSON.stringify(result, null, 2));
      }
    }
  } finally {
    await browser.close();
  }
}
