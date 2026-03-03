# ghost-browse 👻

> Stealth browser toolkit for AI agents — undetectable, authenticated, production-ready.

[![Node.js](https://img.shields.io/badge/Node.js-22+-green)](https://nodejs.org)
[![Playwright](https://img.shields.io/badge/Playwright-CDP-blue)](https://playwright.dev)
[![OpenClaw](https://img.shields.io/badge/Built%20for-OpenClaw-purple)](https://github.com/openclaw/openclaw)

## What is it?

Sites ban headless browsers. ghost-browse solves this by running a **real Chrome instance** via Xvfb with persistent fingerprints, real cookies, and human-like behavior — making it indistinguishable from a regular user.

Built to power AI agents that need to browse the web without getting blocked.

## Key Features

- 🔐 **Persistent profiles** — real Chrome sessions with saved cookies (Twitter/X, Reddit, Google, Polymarket, Figma, etc.)
- 🤖 **AI-native API** — `search`, `fetch`, `batch`, `research` commands designed for LLM tool-calling
- 🌐 **Multi-engine search** — DuckDuckGo (default), Bing, Google without rate limits
- 📊 **Structured extractors** — Twitter timeline, Reddit feed, HackerNews, GitHub trending
- 🧠 **Deep research mode** — multi-source parallel research in ~20 seconds
- 🔄 **Rate limiting** — built-in per-domain throttling (Google 3/min, Twitter 10/min)
- 📄 **PDF extraction** — arXiv, academic papers, documents

## Usage

```bash
# Deep research (web + twitter + reddit + HN)
node deep-research.mjs "AI agents 2026" --sources web,twitter,reddit,hn

# Stealth fetch with JS rendering
node ghost-browse.mjs fetch "https://site.com" --max 5000

# Authenticated browsing (uses saved profile)
node ghost-browse.mjs fetch "https://x.com/home" --profile x-com

# Parallel batch crawl
node ghost-browse.mjs batch "https://url1" "https://url2" "https://url3"

# Structured extractors
node extractors.mjs twitter-timeline --limit 20
node extractors.mjs github-trending javascript
```

## Real-world Usage

Powers a production AI agent system ([OpenClaw](https://github.com/openclaw/openclaw)) that:
- Runs **daily automated research** across web + social media
- Posts to X/Twitter autonomously with real browser session
- Monitors Polymarket, HackerNews, Reddit for signals
- Bypasses bot detection on Cloudflare-protected sites

## Tech Stack

- **Node.js + Playwright** (CDP mode — connects to running Chrome)
- **Xvfb** for headless GUI mode on Linux servers
- **Profile manager** — import/export Chrome DevTools cookies
- Works standalone or as OpenClaw agent tool

## Profiles Included

`twitter-com`, `x-com`, `reddit-com`, `google-com`, `polymarket-com`, `figma-com`, `tradingview-com`

---

Built by [@rub1kub](https://github.com/rub1kub) · Part of [OpenClaw](https://github.com/openclaw/openclaw) agent stack
