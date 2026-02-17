# ghost-browse 👻

Stealth browser toolkit for AI agents. GUI mode via Xvfb — undetectable by Google, Twitter, Reddit. Full Chrome profile for authenticated browsing. Built for [OpenClaw](https://github.com/openclaw/openclaw) agents. Works standalone.

**Key insight:** Sites ban **headless browsers**, not VPS IPs. ghost-browse runs in GUI mode (Xvfb virtual display) with your real Chrome profile — indistinguishable from a human.

## Features

| Feature | Description |
|---------|-------------|
| 🖥️ GUI mode | `headless: false` + Xvfb, passes all bot detection |
| 🔐 Persistent fingerprint | Same profile = same browser identity (Canvas, WebGL, platform) |
| 🎭 Anonymous fingerprint | Random identity per session for anonymous browsing |
| ⚡ Parallel | Batch-fetch N pages simultaneously |
| 📦 Smart cache | TTL-based, instant repeat fetches |
| ⏱️ Rate limiter | Per-domain limits prevent IP bans (Google 3/min, etc.) |
| 🔍 Research mode | Search + read top-N pages in one command |
| 🌐 Multi-engine | Google (with login), Bing, DuckDuckGo |
| 📊 Site extractors | Twitter, Reddit, HN, GitHub structured data |
| 🖥️ Server mode | Persistent HTTP API, 3-5s faster per request |
| 👀 Watch mode | Monitor page changes with diff alerts |
| 🔄 Retry | Exponential backoff on failures |
| ⚠️ Captcha | Auto-solve checkbox + human fallback |
| 📸 Screenshots | PNG on every fetch |
| 🔀 Proxy | Rotation with file support |
| 📄 PDF extract | Download + extract text from PDFs |
| ⚙️ Config file | All settings in one place, no hardcoded paths |

## Quick Start

```bash
npm install

# Xvfb should be running (OpenClaw auto-starts it on :99)

# Search
node ghost-browse.mjs search "AI news" --engine google --limit 10
node ghost-browse.mjs search "bitcoin price" --engine bing --limit 10
node ghost-browse.mjs search "javascript frameworks" --limit 10  # DDG default

# Fetch page
node ghost-browse.mjs fetch "https://techcrunch.com" --screenshot

# Research (search + read + extract in one)
node research.mjs "TON blockchain news" --limit 5
node research.mjs "best databases 2026" --engine bing --limit 10

# Site extractors
node extractors.mjs twitter-timeline --limit 20
node extractors.mjs reddit-feed programming --limit 10
node extractors.mjs hackernews top
node extractors.mjs github-trending javascript

# Persistent server
node server.mjs --port 3847
curl localhost:3847/search?q=query&engine=ddg
curl localhost:3847/fetch?url=https://example.com

# Watch for changes
node watch.mjs "https://example.com/status" --interval 60

# PDF extraction
node pdf-extract.mjs "https://arxiv.org/pdf/1706.03762" --max 5000

# Batch parallel fetch
node ghost-browse.mjs batch "https://url1" "https://url2" "https://url3"
```

## Fingerprint System

ghost-browse has a two-mode fingerprint system:

### Anonymous Mode (default)
Every launch gets a random fingerprint — different Canvas hash, WebGL GPU, platform, cores, RAM, languages. Sites see a unique visitor each time.

```bash
node ghost-browse.mjs search "query"  # random fingerprint
```

### Profile Mode (with --profile)
When using a cookie profile for authenticated browsing, the fingerprint is **deterministic** — generated from a seeded PRNG keyed to the profile name. Same profile always presents the same browser identity.

```bash
node ghost-browse.mjs fetch "https://x.com/home" --profile x-com
# Always: same platform, same GPU, same canvas noise, same cores
```

**Why it matters:** Sites like Twitter/Reddit detect "same cookies, different browser fingerprint" as suspicious. Profile mode ensures consistency.

**Spoofed properties:**
- Canvas (subtle XOR noise, 1-3 bits)
- WebGL renderer/vendor (NVIDIA, AMD, Intel, Apple)
- AudioContext
- Platform (Win32, MacIntel, Linux x86_64)
- Hardware concurrency (2-16 cores)
- Device memory (2-16 GB)
- Languages, timezone, touch points

## Rate Limiter

Built-in per-domain rate limiting prevents IP bans:

| Domain | Limit |
|--------|-------|
| google.com | 3 req/min |
| x.com / twitter.com | 10 req/min |
| reddit.com | 10 req/min |
| default | 20 req/min |

Configurable via `ghost-browse.config.json`. Auto-waits when limit exceeded.

## Configuration

Optional `ghost-browse.config.json`:

```json
{
  "chromeExecutable": "/usr/bin/google-chrome-stable",
  "userDataDir": "/path/to/chrome/user-data",
  "display": ":99",
  "defaultEngine": "ddg",
  "cacheTtlMs": 600000,
  "serverPort": 3847,
  "rateLimits": {
    "google.com": { "requests": 3, "perMs": 60000 },
    "default": { "requests": 20, "perMs": 60000 }
  }
}
```

All settings have sensible defaults — config file is optional.

## Cookie Profiles

Import cookies from Chrome via CDP (fully decrypted):

```bash
node profile-manager.mjs import-cdp    # extracts from running Chrome
node profile-manager.mjs list           # show all profiles
node profile-manager.mjs show x-com     # inspect a profile
```

Profiles stored in `profiles/` (gitignored). Supported: x-com, twitter-com, reddit-com, google-com, chatgpt-com, openai-com, polymarket-com, tradingview-com.

## Architecture

```
ghost-browse.mjs          Main CLI (search, fetch, batch, pages)
├── browser-launcher.mjs   Unified Chrome launcher (profile copy, fingerprint, cleanup)
├── fingerprint.mjs        Fingerprint generation (seeded + random modes)
├── config.mjs             Configuration loader
├── rate-limiter.mjs       Per-domain rate limiting
├── cache.mjs              Smart page cache with TTL
├── captcha-handler.mjs    Captcha detection + auto-solve
├── extractors.mjs         Site-specific extractors (Twitter, Reddit, HN, GitHub)
├── research.mjs           Search + read + extract in one command
├── server.mjs             Persistent HTTP API server
├── watch.mjs              Page change monitor with diff
├── pdf-extract.mjs        PDF/document text extraction
└── profile-manager.mjs    Cookie profile management (CDP import)
```

## Tested Sites

| Site | Status | Notes |
|------|--------|-------|
| DuckDuckGo | ✅ Stable | Default search engine |
| Bing | ✅ Stable | URL decoding fixed in v2.2.0 |
| Google | ✅ Works | Auto-loads google-com profile, rate limited to 3/min |
| Twitter/X | ✅ Works | Timeline, search, with likes/retweets/views |
| Reddit | ✅ Works | Feed + comments, shreddit web components |
| HackerNews | ✅ Stable | Top/new/ask/show |
| GitHub | ✅ Works | Trending with descriptions, language, stars |
| arXiv PDF | ✅ Works | Via pdf-extract.mjs |

## Requirements

- Node.js 18+
- Playwright (`npm install`)
- Google Chrome (`/usr/bin/google-chrome-stable`)
- Xvfb running on `:99` (for GUI mode)
- Optional: `pdftotext` (poppler-utils) or Python `pdfplumber`/`PyPDF2` for PDF extraction

## License

MIT
