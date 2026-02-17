---
name: ghost-browse
description: >
  Stealth browser for web search and page reading. Use when you need to search Google/Bing/DuckDuckGo,
  read JS-rendered pages, or fetch multiple URLs in parallel without being blocked.
  Anti-detection: randomized fingerprint, human-like behavior. Faster and stealthier than web_fetch.
---

# ghost-browse

Stealth parallel browser for AI agents. Searches the web like a human, reads pages with full JS rendering, runs multiple requests in parallel.

## Why use this instead of web_fetch?

- **web_fetch** fails on JS-heavy sites (SPAs, React, Vue). ghost-browse renders them fully.
- **web_fetch** gets blocked easily. ghost-browse randomizes fingerprints and mimics human behavior.
- **web_fetch** is sequential. ghost-browse batches up to 10 pages in parallel.

## Setup (once)

```bash
cd skills/ghost-browse
npm install
npx playwright install chromium  # if chromium not available
```

## Commands

### Search the web
```bash
# Google search (default)
node ghost-browse.mjs search "bitcoin price" --limit 10

# Bing
node ghost-browse.mjs search "query" --engine bing --limit 5

# DuckDuckGo (most anonymous)
node ghost-browse.mjs search "query" --engine ddg

# JSON output (for programmatic use)
node ghost-browse.mjs search "query" --json
```

### Multi-page search (go through pages of results)
```bash
# Get results from pages 1-3
node ghost-browse.mjs pages "query" --pages 3 --engine google

# All results as JSON
node ghost-browse.mjs pages "topic" --pages 5 --json
```

### Fetch a single page (full JS render)
```bash
node ghost-browse.mjs fetch "https://example.com"

# With scroll (loads lazy content)
node ghost-browse.mjs fetch "https://example.com" --scroll

# Limit output size
node ghost-browse.mjs fetch "https://example.com" --max 5000

# JSON with links
node ghost-browse.mjs fetch "https://example.com" --json
```

### Batch fetch (parallel)
```bash
# Fetch 5 URLs simultaneously
node ghost-browse.mjs batch "https://site1.com" "https://site2.com" "https://site3.com"

# Control parallelism (default: 5)
node ghost-browse.mjs batch url1 url2 url3 url4 url5 --concurrency 3

# JSON output
node ghost-browse.mjs batch url1 url2 --json --max 3000
```

## Output format

### Search result:
```
1. Title of the page
   https://url.com
   Snippet text here...
```

### Fetch result:
```
📄 Page Title
🔗 https://url.com

[markdown content of the page]

🔗 Links (12):
  • Link text: https://linked-url.com
```

## Anti-detection features

- Randomized User-Agent (Chrome, Firefox, Safari on Windows/Mac/Linux)
- Randomized viewport (1920×1080, 1440×900, 1366×768, etc.)
- Random timezone (NY, LA, London, Berlin)
- navigator.webdriver = undefined (undetectable)
- Chrome object spoofing
- Human-like delays between actions (800–2500ms)
- Random scroll patterns
- Randomized typing speed

## Tips

- For research tasks: use `pages` to get 30+ results across 3 Google pages
- For competitor analysis: use `batch` to read 10 sites at once
- For JS-heavy dashboards: use `fetch --scroll` to load lazy content
- Prefer `--engine ddg` for anonymous searches (no personalization)
- Use `--json` output when processing results programmatically
