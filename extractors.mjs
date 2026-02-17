#!/usr/bin/env node
/**
 * extractors.mjs — Site-specific content extractors
 * Structured data from Twitter/X, Reddit, HackerNews, GitHub, etc.
 * Uses unified browser-launcher.mjs for DRY browser setup.
 */

// ─── Twitter / X ─────────────────────────────────────────────────────────────

export async function extractTwitterTimeline(page, opts = {}) {
  if (!page.url().includes('x.com') && !page.url().includes('twitter.com')) {
    await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 30000 });
  }
  await Promise.race([
    page.waitForSelector('[data-testid="tweet"]', { timeout: 12000 }),
    new Promise(r => setTimeout(r, 10000)),
  ]);
  await new Promise(r => setTimeout(r, 2000));

  return await page.evaluate(() => {
    const tweets = [];
    document.querySelectorAll('[data-testid="tweet"]').forEach(el => {
      const userEl = el.querySelector('[data-testid="User-Name"]');
      const textEl = el.querySelector('[data-testid="tweetText"]');
      const timeEl = el.querySelector('time');

      // Parse stats from aria-label on action buttons (reliable method)
      const stats = { likes: '0', retweets: '0', replies: '0', views: '0' };
      el.querySelectorAll('[role="button"][aria-label], [data-testid="like"] [aria-label], [data-testid="unlike"] [aria-label], [data-testid="retweet"] [aria-label], [data-testid="unretweet"] [aria-label], [data-testid="reply"] [aria-label]').forEach(btn => {
        const label = btn.getAttribute('aria-label') || '';
        const num = label.match(/([\d,.KkMm]+)/)?.[1] || '0';
        if (/like/i.test(label)) stats.likes = num;
        else if (/repost|retweet/i.test(label)) stats.retweets = num;
        else if (/repl/i.test(label)) stats.replies = num;
        else if (/view/i.test(label)) stats.views = num;
      });

      // Fallback: try data-testid$="-count" spans
      if (stats.likes === '0' && stats.retweets === '0') {
        el.querySelectorAll('[data-testid$="-count"]').forEach(s => {
          const key = s.getAttribute('data-testid')?.replace('-count', '');
          if (key) stats[key] = s.textContent.trim();
        });
      }

      // Another fallback: group buttons with visible text
      el.querySelectorAll('[role="group"] button').forEach((btn, idx) => {
        const text = btn.textContent.trim();
        if (text && /^\d/.test(text)) {
          if (idx === 0) stats.replies = text;
          else if (idx === 1) stats.retweets = text;
          else if (idx === 2) stats.likes = text;
          else if (idx === 3) stats.views = text;
        }
      });

      const linkEl = el.querySelector('a[href*="/status/"]');
      const tweetUrl = linkEl ? `https://x.com${linkEl.getAttribute('href')}` : null;

      if (textEl) {
        tweets.push({
          user: userEl?.textContent?.trim()?.split('\n')?.[0] || '',
          text: textEl.textContent.trim(),
          time: timeEl?.getAttribute('datetime'),
          url: tweetUrl,
          likes: stats.likes,
          retweets: stats.retweets,
          replies: stats.replies,
          views: stats.views,
        });
      }
    });
    return tweets;
  });
}

export async function extractTwitterSearch(page, query) {
  const searchUrl = `https://x.com/search?q=${encodeURIComponent(query)}&src=typed_query&f=live`;
  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await Promise.race([
    page.waitForSelector('[data-testid="tweet"]', { timeout: 12000 }),
    new Promise(r => setTimeout(r, 10000)),
  ]);
  await new Promise(r => setTimeout(r, 2000));
  return extractTwitterTimeline(page);
}

// ─── Reddit ──────────────────────────────────────────────────────────────────

export async function extractRedditFeed(page, subreddit = '', sort = 'hot') {
  const htmlUrl = subreddit
    ? `https://www.reddit.com/r/${subreddit}/${sort}/`
    : `https://www.reddit.com/${sort}/`;

  await page.goto(htmlUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

  await Promise.race([
    page.waitForSelector('shreddit-post', { timeout: 10000 }),
    new Promise(r => setTimeout(r, 8000)),
  ]);

  const posts = await page.evaluate(() => {
    const results = [];
    document.querySelectorAll('shreddit-post').forEach(el => {
      const permalink = el.getAttribute('permalink') || '';
      results.push({
        title: el.getAttribute('post-title') || '',
        url: el.getAttribute('content-href') || el.getAttribute('source-url') || (permalink ? `https://reddit.com${permalink}` : ''),
        commentsUrl: permalink ? `https://reddit.com${permalink}` : '',
        subreddit: el.getAttribute('subreddit-prefixed-name') || '',
        author: el.getAttribute('author') ? `u/${el.getAttribute('author')}` : '',
        score: parseInt(el.getAttribute('score') || '0'),
        comments: parseInt(el.getAttribute('comment-count') || '0'),
        time: el.getAttribute('created-timestamp') || null,
        flair: el.getAttribute('flair-text') || null,
      });
    });
    return results;
  });

  if (posts.length > 0) return posts.filter(p => p.title);

  // Fallback: JSON API
  try {
    const jsonUrl = subreddit
      ? `https://www.reddit.com/r/${subreddit}/${sort}/.json?limit=25`
      : `https://www.reddit.com/${sort}/.json?limit=25`;
    await page.goto(jsonUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await new Promise(r => setTimeout(r, 1500));
    const jsonText = await page.evaluate(() => document.querySelector('pre')?.textContent || document.body.innerText);
    const data = JSON.parse(jsonText);
    return (data?.data?.children || []).map(({ data: p }) => ({
      title: p.title,
      url: p.url?.startsWith('/r/') ? `https://reddit.com${p.url}` : p.url,
      commentsUrl: `https://reddit.com${p.permalink}`,
      subreddit: p.subreddit_name_prefixed || `r/${p.subreddit}`,
      author: `u/${p.author}`,
      score: p.score,
      comments: p.num_comments,
      time: p.created_utc ? new Date(p.created_utc * 1000).toISOString() : null,
      flair: p.link_flair_text,
    })).filter(p => p.title);
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
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('article.Box-row', { timeout: 8000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 2000)); // Let JS render

  return await page.evaluate(() => {
    const repos = [];
    document.querySelectorAll('article.Box-row, article[class*="Box-row"]').forEach(el => {
      const nameEl = el.querySelector('h2 a');
      // Description: p with col-9 class (GitHub trending layout)
      const descEl = el.querySelector('p.col-9, p[class*="col-9"][class*="color-fg-muted"], p[class*="color-fg-muted"]');
      const langEl = el.querySelector('[itemprop="programmingLanguage"]');
      const starsEl = el.querySelector('a[href*="/stargazers"]');
      const todayEl = el.querySelector('.d-inline-block.float-sm-right, span.d-inline-block.float-sm-right');

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

// ─── Generic article ──────────────────────────────────────────────────────────

export async function extractArticle(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await new Promise(r => setTimeout(r, 1500));

  return await page.evaluate(() => {
    const jsonLd = document.querySelector('script[type="application/ld+json"]');
    if (jsonLd) {
      try {
        const data = JSON.parse(jsonLd.textContent);
        if (data.articleBody) return { title: data.headline, content: data.articleBody, author: data.author?.name, published: data.datePublished };
      } catch {}
    }
    const title = document.querySelector('h1')?.textContent?.trim() || document.title;
    const article = document.querySelector('article, [role="main"], .post-content, .article-content, .entry-content');
    const content = article ? article.innerText.trim() : document.body.innerText.slice(0, 10000);
    return { title, content, url: window.location.href };
  });
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

const EXTRACTORS = {
  'twitter-timeline': { fn: extractTwitterTimeline, url: 'https://x.com/home', defaultProfile: 'x-com' },
  'twitter-search': { fn: extractTwitterSearch, url: null, defaultProfile: 'x-com' },
  'reddit-feed': { fn: extractRedditFeed, url: null, defaultProfile: 'reddit-com' },
  'reddit-comments': { fn: extractRedditComments, url: null, defaultProfile: 'reddit-com' },
  'hackernews': { fn: extractHackerNews, url: null, defaultProfile: null },
  'github-trending': { fn: extractGitHubTrending, url: null, defaultProfile: null },
  'article': { fn: extractArticle, url: null, defaultProfile: null },
};

if (process.argv[1]?.endsWith('extractors.mjs')) {
  process.env.DISPLAY = process.env.DISPLAY || ':99';

  const { launch } = await import('./browser-launcher.mjs');

  const [,, extractor, ...args] = process.argv;

  if (!extractor || !EXTRACTORS[extractor]) {
    console.log(`
extractors.mjs — Site-specific extractors (GUI mode, anti-detect)

Available:
  twitter-timeline          Fetch your X/Twitter home timeline
  twitter-search "query"    Search Twitter  
  reddit-feed [subreddit]   Reddit feed (hot posts)
  reddit-comments <url>     Comments on a Reddit post
  hackernews [top|new|ask]  HackerNews front page
  github-trending [lang]    GitHub trending repos
  article <url>             Extract article content

Flags: --json --limit N --profile <name>

Examples:
  node extractors.mjs twitter-timeline --limit 20
  node extractors.mjs reddit-feed programming
  node extractors.mjs twitter-search "TON blockchain"
  node extractors.mjs hackernews top
  node extractors.mjs github-trending javascript
`);
    process.exit(0);
  }

  const jsonOut = args.includes('--json');
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1]) : 50;

  // Profile: explicit --profile or extractor default
  const profileIdx = args.indexOf('--profile');
  const profile = profileIdx !== -1 ? args[profileIdx + 1] : EXTRACTORS[extractor].defaultProfile;

  const positionalArgs = args.filter((a, i) => {
    if (a.startsWith('--')) return false;
    if (i > 0 && args[i - 1].startsWith('--')) return false;
    return true;
  });

  // Use unified launcher with persistent fingerprint for profiles
  const browser = await launch({ profile });
  const page = await browser.context.newPage();

  let result;
  try {
    if (extractor === 'twitter-timeline') {
      await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 30000 });
      result = await extractTwitterTimeline(page);
    } else if (extractor === 'twitter-search') result = await extractTwitterSearch(page, positionalArgs[0] || 'trending');
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
          console.log(`${i + 1}. ${r.title || r.text?.slice(0, 100) || r.name || r.body?.slice(0, 80) || JSON.stringify(r).slice(0, 100)}`);
          if (r.description) console.log(`   ${r.description.slice(0, 150)}`);
          if (r.url || r.commentsUrl) console.log(`   ${r.url || r.commentsUrl}`);
          if (r.score !== undefined || r.points || r.likes) console.log(`   ⭐ ${r.score ?? r.points ?? r.likes} | 💬 ${r.comments ?? r.replies ?? '0'}${r.views ? ' | 👁 ' + r.views : ''}`);
          if (r.language) console.log(`   📦 ${r.language}${r.stars ? ' | ★ ' + r.stars : ''}${r.starsToday ? ' | ' + r.starsToday : ''}`);
          console.log();
        });
      } else {
        console.log(JSON.stringify(result, null, 2));
      }
    }
  } finally {
    try { await page.close(); } catch {}
    await browser.close();
  }
}
