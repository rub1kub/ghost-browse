# ghost-browse 👻

**Stealth browser toolkit for AI agents.** GUI mode via Xvfb — undetectable by Google, Twitter, Reddit. Full Chrome profile for authenticated browsing.

Built for [OpenClaw](https://github.com/openclaw/openclaw) agents. Works standalone.

> **Key insight:** Sites ban **headless browsers**, not VPS IPs. ghost-browse runs in **GUI mode** (Xvfb virtual display) with your **real Chrome profile** — indistinguishable from a human.

## Features

| Feature | Description |
|---------|-------------|
| 🖥️ GUI mode | `headless: false` + Xvfb, passes all bot detection |
| 🔐 Real session | Uses Chrome profile: cookies, history, fingerprint |
| ⚡ Parallel | Batch-fetch N pages simultaneously |
| 📦 Smart cache | TTL-based, instant repeat fetches |
| 🔍 Research mode | Search + read top-N pages in one command |
| 🌐 Multi-engine | Google (with login), Bing, DuckDuckGo |
| 📊 Site extractors | Twitter, Reddit, HN, GitHub structured data |
| 🖥️ Server mode | Persistent HTTP API, 3-5s faster per request |
| 👀 Watch mode | Monitor page changes with alerts |
| 🔄 Retry | Exponential backoff on failures |
| ⚠️ Captcha | Auto-solve checkbox + human fallback |
| 📸 Screenshots | PNG on every fetch |
| 🔀 Proxy | Rotation with health-check |

## Quick Start

```bash
npm install
# Xvfb should be running (OpenClaw auto-starts it on :99)

# Search
node ghost-browse.mjs search "AI news" --engine google --limit 10
node ghost-browse.mjs search "bitcoin price" --limit 10  # DDG default

# Fetch page
node ghost-browse.mjs fetch "https://techcrunch.com" --screenshot

# Research (search + read + extract in one)
node research.mjs "TON blockchain news" --limit 5

# Site extractors
node extractors.mjs twitter-timeline --limit 20
node extractors.mjs reddit-feed programming --limit 10
node extractors.mjs hackernews top
node extractors.mjs github-trending javascript

# Persistent server
node server.mjs --port 3847
curl "localhost:3847/search?q=query"
curl "localhost:3847/fetch?url=https://..."

# Monitor changes
node watch.mjs "https://example.com/status" --interval 60

# Manage profiles
node profile-manager.mjs import-cdp
node profile-manager.mjs list
```

## Architecture

```
ghost-browse.mjs          Core: search, fetch, batch, pages
├── research.mjs           Search + read + extract pipeline
├── extractors.mjs         Twitter, Reddit, HN, GitHub parsers
├── server.mjs             Persistent HTTP API server
├── watch.mjs              Page change monitor
├── cache.mjs              Smart TTL cache
├── captcha-handler.mjs    Auto-solve + human fallback
├── profile-manager.mjs    Cookie import & management
└── profiles/              Auth cookies (gitignored)
```

## How GUI Mode Works

```
Xvfb :99 ─── virtual 1920×1080 display
     │
     └── google-chrome-stable (headless: false)
              │
              ├── Copied real Chrome profile (no SingletonLock conflict)
              ├── navigator.webdriver = undefined
              ├── window.chrome = { runtime: ... }
              ├── Random UA, viewport, timezone per session
              └── Looks 100% real to Google/Twitter/Reddit
```

## All Commands

### ghost-browse.mjs
```
search "query" [--limit N] [--engine google|bing|ddg] [--proxy url] [--json]
fetch  "url"   [--scroll] [--max N] [--screenshot] [--retries N] [--json]
batch  "url1" "url2" ...  [--concurrency N] [--max N] [--json]
pages  "query" [--pages N] [--engine google|bing|ddg] [--json]
```

### research.mjs
```
node research.mjs "topic" [--limit 5] [--engine ddg|google] [--max 3000] [--concurrency 3] [--json]
```

### extractors.mjs
```
twitter-timeline [--limit N] [--json]
twitter-search "query" [--limit N] [--json]
reddit-feed [subreddit] [--limit N] [--json]
hackernews [top|new|ask|show] [--limit N] [--json]
github-trending [language] [--limit N] [--json]
article "url" [--json]
```

### server.mjs
```
node server.mjs [--port 3847]
GET  /search?q=query&engine=ddg&limit=10
GET  /fetch?url=https://...&max=8000
GET  /status
POST /stop
```

### watch.mjs
```
node watch.mjs "url" [--interval 300] [--selector ".price"] [--once]
```

### profile-manager.mjs
```
list / import-cdp / show <name> / delete <name> / export-netscape <name>
```

## Tested

| Site | Status | Notes |
|------|--------|-------|
| Google | ✅ | With Chrome profile, no captcha |
| DuckDuckGo | ✅ | No auth needed |
| Bing | ✅ | No auth needed |
| Reddit | ✅ | GUI mode bypasses detection |
| Twitter/X | ✅ | Real timeline with auth |
| HackerNews | ✅ | Works great |
| GitHub | ✅ | Trending, repos |

## Requirements

- Linux with Xvfb (`Xvfb :99 -screen 0 1920x1080x24`)
- Google Chrome stable
- Node.js 18+

## License

MIT
