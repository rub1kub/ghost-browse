# Changelog

## v2.4.0 (2026-02-17) — Research Intelligence

### NEW: Topic Decomposition (`--decompose`)
Automatically breaks a broad topic into 5 research sub-questions (Overview, Key Players, Technical Details, Challenges, Future Outlook) and generates 2-3 keyword variations per question for wider search coverage.

```bash
node deep-research.mjs "impact of AI on healthcare" --decompose
# Searches with: "impact AI healthcare", "AI healthcare 2026 overview", 
# "AI healthcare top companies projects", "AI healthcare challenges risks", etc.
```

In decompose mode, web searches run multiple queries (one per sub-question) and deduplicate results automatically.

### NEW: Confidence Scoring
Every research report now includes a confidence level based on source coverage:
- 🟢 **HIGH**: 3+ sources with data, 10+ total results
- 🟡 **MEDIUM**: 2+ sources, 5+ results  
- 🔴 **LOW**: single source or sparse results

### NEW: Cross-Reference Detection
Automatically identifies topics/URLs that appear in 2+ sources (higher credibility). Both exact URL matches and fuzzy title-keyword matches. Cross-referenced items are highlighted at the top of the report.

### Report Format Enhanced
- Research sub-questions listed in report header (decompose mode)
- Cross-referenced section before source details
- Confidence badge in report metadata line

---

## v2.3.0 (2026-02-17) — Deep Research

### NEW: `deep-research.mjs`
Multi-source research in one command. Searches web + Twitter + Reddit + HN + GitHub in parallel, reads top pages, produces unified markdown report.

```bash
node deep-research.mjs "AI agents 2026"                           # all sources
node deep-research.mjs "TON blockchain" --sources web,twitter,hn  # specific
node deep-research.mjs "Rust vs Go" --engine bing --limit 10      # customize
```

**Performance:** ~20s for 4 sources + 2 page reads (one browser launch, parallel tabs).

**Features:**
- Parallel search across all sources (one persistent context)
- 30s timeout per source — if one hangs, others complete
- Reddit: JSON API primary (25+ posts), HTML fallback
- HN: Algolia search (by popularity, past month)
- GitHub: search by stars
- PDF auto-detection: routes to pdf-extract.mjs
- Markdown report with all results organized by source
- `--json` for programmatic consumption

**Fixes:**
- Reddit search now uses JSON API (was returning 0 posts via HTML)
- Twitter search: inline extraction, more reliable in parallel context
- Per-source timeout prevents entire research from hanging

---

## v2.2.0 (2026-02-17) — Architecture Rewrite

### 🔴 Breaking: Persistent Fingerprint per Profile
- **Problem**: Every launch generated a random fingerprint. For authenticated sessions (Twitter, Reddit, Google), sites saw "same cookies, different browser" = suspicious bot signal.
- **Solution**: Two-mode fingerprint system:
  - `anonymous` (no `--profile`): random fingerprint every launch — for search, anonymous fetch
  - `profile` (with `--profile x-com`): deterministic fingerprint from seeded PRNG — same profile always presents the same browser identity
- Uses Mulberry32 PRNG seeded from profile name hash — reproducible across runs.

### 🔴 Unified Browser Launcher (`browser-launcher.mjs`)
- **Problem**: 5 files (ghost-browse, extractors, research, server, watch) each duplicated ~30 lines of Chrome launch code.
- **Solution**: Single `browser-launcher.mjs` module. All files import `launch()`. One place to fix bugs, add features.

### 🔴 Rate Limiter (`rate-limiter.mjs`)
- **Problem**: No request throttling → 20+ requests to Google in a minute → IP banned.
- **Solution**: Per-domain rate limits with sliding window:
  - Google: 3 req/min
  - Twitter/Reddit: 10 req/min
  - Default: 20 req/min
- Auto-waits when limit exceeded. Configurable via `ghost-browse.config.json`.

### 🔴 Config File (`config.mjs` + `ghost-browse.config.json`)
- No more hardcoded paths. All settings (Chrome path, user-data dir, display, rate limits, server port) in one config.
- Falls back to sensible defaults if no config file exists.

### 🐛 Bug Fixes

#### Bing URL Decoding
- **Problem**: Bing returned redirect URLs (`bing.com/ck/a?...`) instead of actual URLs.
- **Fix**: Decode Base64url from `u=a1<base64>` parameter. All Bing results now show real URLs.

#### Twitter Stats (likes/retweets/replies)
- **Problem**: `data-testid$="-count"` selectors stopped working — Twitter changed DOM.
- **Fix**: Three-layer fallback:
  1. Parse `aria-label` on action buttons ("123 Likes")
  2. Fallback to `data-testid$="-count"` spans
  3. Fallback to `[role="group"] button` text by position
- Now also extracts `views` count.

#### GitHub Trending Descriptions
- **Problem**: Descriptions were empty — wrong CSS selector.
- **Fix**: Target `p.col-9` / `p[class*="color-fg-muted"]`. Also switched from `networkidle` (caused timeouts) to `domcontentloaded` + 2s wait. Output now shows description, language, stars, and today's stars.

#### Server Fingerprint
- **Problem**: `server.mjs` launched browser without fingerprint injection.
- **Fix**: Uses `browser-launcher.mjs` which always injects fingerprint.

### 🟡 Improvements

#### Canvas Noise (Softer)
- **Before**: `(R + noise) % 256` with noise 76-253 — visibly shifted colors, easily detectable.
- **After**: `R ^= bits` with bits 1-3 — changes max 2 bits per pixel. Invisible to humans, unique per session. Also applies to Green channel for more entropy.

#### `--profile` Everywhere
- Extractors: auto-load default profile per site (`x-com` for Twitter, `reddit-com` for Reddit)
- `research.mjs`: `--profile` flag, auto-loads `google-com` for Google engine
- `watch.mjs`: `--profile` flag for authenticated page monitoring
- `server.mjs`: uses unified launcher

#### Watch Mode Diff
- **Before**: Just "CHANGED" / "No changes".
- **After**: Shows line-by-line diff of what changed.

#### Bing Support in Research
- `research.mjs` now supports `--engine bing` in addition to DDG and Google.

#### Structured JSON Output
- `--json` output now includes `tool`, `command`, `fingerprint` mode metadata.

### New Files
- `browser-launcher.mjs` — unified browser launcher
- `config.mjs` — configuration loader
- `rate-limiter.mjs` — per-domain rate limiting
- `ghost-browse.config.json` — optional config (not required, defaults work)
- `CHANGELOG.md` — this file
- `ROADMAP.md` — future plans

### File Count
13 files, ~3500 lines of code.

---

## v2.1.0 (2026-02-17) — Fingerprint Rotation + PDF

- Fingerprint rotation: Canvas noise, WebGL GPU spoofing, AudioContext, platform/cores/RAM randomization
- PDF text extraction (`pdf-extract.mjs`): download + extract via PyPDF2/pdfplumber/pdftotext
- Codex auth profile copied to tima agent

## v2.0.0 (2026-02-16) — Research + Server + Watch

- Research mode (`research.mjs`): search + read + extract in one command
- Persistent server (`server.mjs`): HTTP API, keeps Chrome running between requests
- Watch mode (`watch.mjs`): monitor page changes with alerts
- Smart cache (`cache.mjs`): TTL-based page caching

## v1.3.1 (2026-02-15) — Captcha Auto-Solve

- `trySolveCaptcha()`: click reCAPTCHA checkbox in iframes
- Screenshot fallback + `/tmp/ghost-captcha-pending.json` for human pickup

## v1.3.0 (2026-02-15) — GUI Mode

- GUI mode via Xvfb (`headless: false`) — passes all bot detection
- Real Chrome profile copy (avoids SingletonLock conflict)
- Tested: Reddit ✅, Twitter ✅, HackerNews ✅, GitHub ✅

## v1.2.0 (2026-02-14) — Proxy + Retry + Screenshots

- Proxy rotation (`--proxy url|file`)
- Retry with exponential backoff (`--retries N`)
- Screenshot support (`--screenshot`)
- Captcha detection (`captcha-handler.mjs`)
- Site extractors (`extractors.mjs`)

## v1.1.0 (2026-02-14) — Profile System

- Cookie profile management (`profile-manager.mjs`)
- CDP cookie extraction from Chrome
- `--profile` flag for authenticated browsing

## v1.0.0 (2026-02-13) — Initial Release

- Stealth parallel browser with DDG/Bing/Google search
- JS-rendered page fetching
- Batch parallel fetch
- Multi-page search (`pages` command)
- Human-like behavior (typing delays, scrolling, random viewports)
