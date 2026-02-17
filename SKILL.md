---
name: ghost-browse
description: >
  Stealth browser for web research — search, fetch, and extract from any site.
  Multi-source deep research: web + Twitter + Reddit + HN + GitHub in one command (~20s).
  Anti-detection: persistent fingerprint per profile, GUI mode, rate limiting.
  Use when you need fast, comprehensive research across multiple sources.
---

# ghost-browse

Stealth browser toolkit for AI agents. One command = research across web, Twitter, Reddit, HackerNews, GitHub.

## Quick Start

```bash
cd projects/ghost-browse  # or wherever installed
npm install
```

## Deep Research (recommended)

One command, all sources, ~20 seconds:

```bash
# Full research (web + Twitter + Reddit + HN)
node deep-research.mjs "AI agents 2026"

# Specific sources
node deep-research.mjs "TON blockchain" --sources web,twitter,reddit,hn
node deep-research.mjs "Rust vs Go" --sources web,hn,github
node deep-research.mjs "OpenAI drama" --sources twitter,reddit

# Control depth
node deep-research.mjs "topic" --limit 5 --read 3 --max 2000

# JSON output
node deep-research.mjs "topic" --json
```

Sources: `web`, `twitter`, `reddit`, `hn`, `github`

## Individual Commands

### Search
```bash
node ghost-browse.mjs search "query" --engine ddg --limit 10
node ghost-browse.mjs search "query" --engine bing --limit 5
node ghost-browse.mjs search "query" --engine google --limit 10  # auto-loads google profile
```

### Fetch page
```bash
node ghost-browse.mjs fetch "https://example.com" --max 5000
node ghost-browse.mjs fetch "https://example.com" --scroll --screenshot
node ghost-browse.mjs fetch "https://x.com/home" --profile x-com
```

### Batch (parallel)
```bash
node ghost-browse.mjs batch "url1" "url2" "url3" --concurrency 5 --max 3000
```

### Site Extractors (structured data)
```bash
node extractors.mjs twitter-timeline --limit 20    # your timeline
node extractors.mjs twitter-search "query"          # search tweets
node extractors.mjs reddit-feed programming         # subreddit feed
node extractors.mjs hackernews top                  # HN front page
node extractors.mjs github-trending javascript      # trending repos
node extractors.mjs article "https://..."           # extract article
```

### Research (search + read)
```bash
node research.mjs "topic" --limit 5 --engine ddg
```

### PDF Extract
```bash
node pdf-extract.mjs "https://arxiv.org/pdf/1706.03762" --max 5000
```

### Watch (monitor changes)
```bash
node watch.mjs "https://site.com/status" --interval 60 --once
```

### Server (persistent, 1-2s per request)
```bash
node server.mjs --port 3847
curl localhost:3847/search?q=query
curl localhost:3847/fetch?url=https://...
```

## Profiles

Authenticated browsing with cookie profiles:

```bash
node profile-manager.mjs import-cdp    # extract cookies from Chrome
node profile-manager.mjs list
```

Available: `x-com`, `reddit-com`, `google-com`, `chatgpt-com`, `polymarket-com`, etc.

With `--profile`, fingerprint is persistent (same cookies = same browser identity).

## Key Design Decisions

- **GUI mode** (`headless: false` + Xvfb): sites detect headless, not IPs
- **Persistent fingerprint**: seeded PRNG per profile — no "different browser, same cookies" red flag
- **Rate limiter**: Google 3/min, Twitter 10/min — prevents IP bans
- **Error recovery**: if one source fails, others continue
- **30s timeout per source**: nothing hangs forever
