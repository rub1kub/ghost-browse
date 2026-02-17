# ghost-browse 👻

**Stealth parallel browser for AI agents.** Searches Google/Bing/DuckDuckGo, reads JS-rendered pages, fetches multiple URLs in parallel — without bot detection.

Built for [OpenClaw](https://github.com/openclaw/openclaw) agents, works as a standalone CLI.

## Features

- 🕵️ **Anti-detection** — randomized UA, viewport, timezone, JS evasion (`navigator.webdriver = undefined`)
- ⚡ **Parallel** — batch-fetch up to 10 pages simultaneously with `batch` command
- 🎭 **Human-like** — random delays, scroll patterns, typing speed variation
- 🌐 **Multi-engine** — Google, Bing, DuckDuckGo, with multi-page support
- 📄 **JS rendering** — full Chromium render, handles SPAs and lazy-loaded content
- 🤖 **Agent-ready** — `--json` flag on all commands for programmatic use

## Quick Start

```bash
npm install
npx playwright install chromium

# Search Google
node ghost-browse.mjs search "latest AI news" --limit 10

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
| `search "query"` | Search one page of results |
| `pages "query" --pages N` | Search N pages (more results) |
| `fetch "url"` | Fetch and render a single URL |
| `batch "url1" "url2"...` | Fetch multiple URLs in parallel |

### Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--engine google\|bing\|ddg` | google | Search engine |
| `--limit N` | 10 | Max results |
| `--pages N` | 3 | Pages to search through |
| `--concurrency N` | 5 | Parallel fetches |
| `--scroll` | false | Scroll page to load lazy content |
| `--max N` | 8000 | Max chars in output |
| `--json` | false | JSON output |

## OpenClaw Skill

Install as an OpenClaw skill:

```bash
cp -r . ~/.openclaw/workspace/skills/ghost-browse
cd ~/.openclaw/workspace/skills/ghost-browse && npm install
```

Then in agent instructions: use `node skills/ghost-browse/ghost-browse.mjs search "query"`.

## Anti-Detection Details

```
User-Agents:  5 real Chrome/Firefox/Safari UAs, rotated per session
Viewports:    5 common screen sizes, randomized
Timezone:     Random (NY/LA/London/Berlin)
navigator:    webdriver=undefined, plugins=[1,2,3,4,5], chrome object spoofed
Delays:       800–2500ms between actions (human-like)
```

## Use Cases

- **Research** — search + batch-read sources in one command
- **Monitoring** — watch pages for content changes
- **Competitor analysis** — read 10 competitor pages in parallel
- **Data extraction** — fetch JS-rendered pages that web_fetch can't handle

## License

MIT — open source, use freely.
