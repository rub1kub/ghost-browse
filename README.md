# ghost-browse 👻

**Stealth parallel browser for AI agents.** Searches Google/Bing/DuckDuckGo, reads JS-rendered pages, fetches multiple URLs in parallel — without bot detection.

Built for [OpenClaw](https://github.com/openclaw/openclaw) agents. Works standalone.

> **Key insight:** Google/Twitter/Reddit don't ban VPS IPs — they ban **headless browsers**. ghost-browse runs in **GUI mode via Xvfb** (virtual display) and uses your real Chrome profile, making it indistinguishable from a human user.

## Features

- 🖥️ **GUI mode** — `headless: false` + Xvfb virtual display, undetectable by Google/Twitter/Reddit
- 🔐 **Real session** — copies your Chrome profile for full auth, cookies, fingerprint
- ⚡ **Parallel** — batch-fetch up to N pages simultaneously (`batch` command)
- 🎭 **Human-like** — random delays, scroll patterns, typing speed variation
- 🌐 **Multi-engine** — Google (with login), Bing, DuckDuckGo, multi-page support
- 📄 **JS rendering** — full Chromium render, handles SPAs and React/Vue
- 📸 **Screenshots** — `--screenshot` flag saves PNG on every fetch
- 🔄 **Retry** — `--retries N` with exponential backoff
- ⚠️ **Captcha detection** — auto-screenshot + queue for Telegram alert
- 🔀 **Proxy support** — `--proxy url` or proxy list file with round-robin rotation
- 📊 **Site extractors** — Twitter timeline/search, Reddit feed, HackerNews, GitHub trending

## Quick Start

```bash
npm install
npx playwright install chromium  # if needed

# Search Google (uses your Chrome profile = no captcha)
node ghost-browse.mjs search "latest AI news" --limit 10 --engine google

# Search DuckDuckGo (no auth needed)
node ghost-browse.mjs search "bitcoin price" --limit 10

# Fetch a page (full JS render)
node ghost-browse.mjs fetch "https://techcrunch.com"

# Batch fetch (parallel)
node ghost-browse.mjs batch "https://site1.com" "https://site2.com" "https://site3.com"

# Multi-page search
node ghost-browse.mjs pages "bitcoin news" --pages 3
```

## Commands

| Command | Description |
|---------|-------------|
| `search "query"` | Search (DDG default, or `--engine google\|bing`) |
| `pages "query" --pages N` | Search across N pages |
| `fetch "url"` | Fetch and render a single URL |
| `batch "url1" "url2"...` | Fetch multiple URLs in parallel |

### Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--engine google\|bing\|ddg` | ddg | Search engine |
| `--limit N` | 10 | Max results |
| `--pages N` | 3 | Pages to search |
| `--concurrency N` | 5 | Parallel fetches |
| `--scroll` | false | Scroll to load lazy content |
| `--screenshot` | false | Save PNG screenshot |
| `--max N` | 8000 | Max chars in output |
| `--retries N` | 2 | Retry on failure (exponential backoff) |
| `--proxy url\|file` | none | Proxy or file with proxy list |
| `--json` | false | JSON output |
| `--alert-telegram` | false | Queue captcha alert for Telegram |

## Site Extractors (`extractors.mjs`)

Structured data extractors for major sites — uses real Chrome session:

```bash
# Your Twitter/X timeline
node extractors.mjs twitter-timeline --limit 20

# Twitter search
node extractors.mjs twitter-search "TON blockchain"

# Reddit subreddit
node extractors.mjs reddit-feed programming
node extractors.mjs reddit-feed worldnews --limit 10

# HackerNews
node extractors.mjs hackernews top --limit 20

# GitHub trending
node extractors.mjs github-trending javascript
node extractors.mjs github-trending python --limit 10

# Article extraction
node extractors.mjs article "https://example.com/article"
```

All extractors support `--json` and `--limit`.

## Profile Manager (`profile-manager.mjs`)

Import cookies from your Chrome browser:

```bash
# Import all key sites at once (Twitter, Reddit, Google, ChatGPT, Polymarket...)
node profile-manager.mjs import-cdp

# List saved profiles
node profile-manager.mjs list

# Inspect a profile
node profile-manager.mjs show x-com
```

Profiles are stored locally in `profiles/` and gitignored (they contain auth tokens).

## How GUI Mode Works

```
Xvfb :99 ─── virtual 1920×1080 display
     │
     └── google-chrome-stable (headless: false)
              │
              ├── Real Chrome profile (cookies, history, fingerprint)
              ├── navigator.webdriver = undefined
              ├── window.chrome = { runtime: ... }
              └── Looks 100% like a real human browser
```

This is why it passes Google/Twitter/Reddit detection where headless browsers fail.

## Requirements

- Linux with Xvfb (auto-started if not running)
- Google Chrome stable (`/usr/bin/google-chrome-stable`)
- Node.js 18+
- For OpenClaw: profile at `/home/openclawd/.openclaw/browser/openclaw/user-data`

## Tested Results

| Site | Status | Notes |
|------|--------|-------|
| Google Search | ✅ Works | Uses Chrome profile (no captcha) |
| DuckDuckGo | ✅ Works | No auth needed |
| Bing | ✅ Works | No auth needed |
| Reddit | ✅ Works | GUI mode bypasses bot detection |
| Twitter/X | ✅ Works | Real timeline with auth |
| HackerNews | ✅ Works | No auth needed |
| GitHub Trending | ✅ Works | No auth needed |

## License

MIT — open source, use freely.
