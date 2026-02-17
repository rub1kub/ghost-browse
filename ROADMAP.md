# ghost-browse ROADMAP v2.2+

## 🐛 Баги (найдены при тестировании)

### 1. Bing: URL'ы не декодированы
**Серьёзность:** Высокая
Bing возвращает redirect-URL вида `https://www.bing.com/ck/a?!&&p=...&u=a1aHR0cHM6Ly...`
DDG имеет декодер (`uddg=` → `decodeURIComponent`), а для Bing аналогичного нет.
**Фикс:** Декодировать Base64 из параметра `u` (формат: `a1` + base64url).

### 2. Twitter: likes/retweets/replies = 0
**Серьёзность:** Средняя
`[data-testid$="-count"]` не находит элементы — Twitter менял DOM. Нужно парсить `aria-label` у кнопок like/retweet/reply (формат: "123 Likes").
**Фикс:** Парсить через `aria-label` или `aria-expanded` вместо `data-testid`.

### 3. GitHub Trending: пустые описания
**Серьёзность:** Низкая
Селектор `p` слишком общий. GitHub изменил вёрстку — описание в `p.col-9`.
**Фикс:** Уточнить селектор на `p.col-9.color-fg-muted` или аналог.

### 4. Server mode: нет fingerprint injection
**Серьёзность:** Средняя
`server.mjs` запускает browser без `generateFingerprint()` / `getFingerprintScript()`.
**Фикс:** Добавить fingerprint при создании контекста.

---

## 🔴 Критичные доработки

### 5. Persistent Fingerprint per Profile (ГЛАВНОЕ)
**Проблема:** Каждый запуск = новый рандомный fingerprint. Для залогиненных сессий (Twitter, Reddit, Google) это красный флаг: «те же куки, но другой браузер/OS/GPU».

**Решение: Двухрежимный fingerprint:**
- `anonymous` (по умолчанию): рандомный fingerprint каждый запуск → для поиска, анонимных fetch
- `profile` (когда `--profile x-com`): fingerprint генерируется из детерминированного seed (hash от имени профиля), сохраняется в `profiles/x-com.fingerprint.json`

**Реализация:**
```js
// fingerprint.mjs
export function generateFingerprint(seed = null) {
  if (seed) {
    // Детерминированный PRNG из seed
    const rng = seededRandom(seed);
    // Всегда один и тот же набор для данного профиля
    return { platform: 'Win32', canvasNoise: rng(1,255), ... };
  }
  // Текущее поведение — полный рандом
  return { ... };
}
```

### 6. DRY: Единый browser launcher
**Проблема:** `extractors.mjs`, `research.mjs`, `server.mjs`, `watch.mjs` — каждый дублирует код запуска Chrome (copy user-data, launchPersistentContext, addInitScript).

**Решение:** Вынести в `browser-launcher.mjs`:
```js
export async function launch(opts = {}) {
  // profile copy, persistent context, fingerprint, cleanup
  return { context, close, profileDir };
}
```
Все файлы импортируют один launcher. Одно место для фиксов.

### 7. Rate Limiter per Domain
**Проблема:** Сейчас можно случайно закидать Google 20 запросами за минуту → IP в бан.

**Решение:** `rate-limiter.mjs`:
```js
const LIMITS = {
  'google.com': { requests: 3, perMs: 60000 },
  'x.com': { requests: 10, perMs: 60000 },
  'reddit.com': { requests: 10, perMs: 60000 },
  default: { requests: 20, perMs: 60000 },
};
// await rateLimiter.wait('google.com') — блокирует если превышен лимит
```

---

## 🟡 Важные улучшения

### 8. Улучшенный Canvas Noise
**Проблема:** Текущий алгоритм меняет каждый 4-й байт (красный канал) на `(R + noise) % 256`. Это слишком агрессивно — сильно смещает цвета и видно на визуальном осмотре.

**Лучше:**
```js
// XOR с маленьким числом (1-3 бита) вместо сложения с 76-253
imageData.data[i] ^= (seed & 0x03); // меняет максимум 2 бита
```

### 9. Bing URL Decoder
```js
function decodeBingUrl(url) {
  const match = url.match(/[&?]u=a1([^&]+)/);
  if (match) {
    try {
      return Buffer.from(match[1], 'base64url').toString('utf8');
    } catch {}
  }
  return url;
}
```

### 10. Twitter Stats Fix
```js
// Вместо data-testid$="-count", парсить aria-label кнопок
const buttons = el.querySelectorAll('[role="button"][aria-label]');
buttons.forEach(btn => {
  const label = btn.getAttribute('aria-label'); // "123 Likes"
  if (/like/i.test(label)) stats.likes = label.match(/\d+/)?.[0];
  if (/repost|retweet/i.test(label)) stats.retweets = label.match(/\d+/)?.[0];
  if (/repl/i.test(label)) stats.replies = label.match(/\d+/)?.[0];
});
```

### 11. `--profile` везде
Сейчас `--profile` работает только в `ghost-browse.mjs fetch/search`. Нужно добавить:
- `research.mjs --profile x-com`
- `watch.mjs --profile google-com`
- `server.mjs` эндпоинты `/search?profile=x-com`

### 12. Config File (`ghost-browse.config.json`)
Вместо хардкода путей и параметров:
```json
{
  "chromeExecutable": "/usr/bin/google-chrome-stable",
  "userDataDir": "/home/openclawd/.openclaw/browser/openclaw/user-data",
  "display": ":99",
  "defaultEngine": "ddg",
  "cacheTtlMs": 600000,
  "rateLimits": { "google.com": [3, 60000] },
  "serverPort": 3847
}
```

### 13. Structured Output для AI-агентов
Все команды уже поддерживают `--json`, но формат нестандартный. Предложение — единый envelope:
```json
{
  "tool": "ghost-browse",
  "command": "search",
  "engine": "ddg",
  "query": "...",
  "results": [...],
  "metadata": { "duration_ms": 4500, "cached": false, "fingerprint": "anonymous" }
}
```

---

## 🟢 Фичи (nice to have)

### 14. Табы вместо контекстов для batch
Сейчас batch открывает новые страницы в одном контексте, но sequential. Можно параллелить через N табов с Promise.allSettled — уже работает, но нет лимита одновременных табов (может перегрузить память).

### 15. Новые extractors
- **YouTube** — trending, search results, video info (title, views, channel)
- **LinkedIn** — feed, job listings (нужен профиль)
- **Telegram Web** — public channel posts
- **Product Hunt** — trending products
- **StackOverflow** — вопросы по теме

### 16. Smart Captcha Retry
Сейчас при captcha → screenshot + alert. Лучше:
1. Подождать 30-60 сек (Google часто снимает капчу после паузы)
2. Попробовать другой поисковик (Google → Bing fallback)
3. Если есть прокси — попробовать через прокси
4. Только потом alert

### 17. Diff-режим для watch
`watch.mjs` показывает только «changed/not changed». Нужен diff:
```
[CHANGED] https://example.com/status
  - Old: "Server: running, version 2.1"
  + New: "Server: running, version 2.2"
```

### 18. Cookie Refresh
Куки устаревают. Нужен `profile-manager.mjs refresh` — перезапуск import-cdp для обновления.

### 19. CLI авто-обновление профилей
`ghost-browse.mjs` при запуске: если профиль старше N дней → warning "Profile x-com is 7 days old, run `node profile-manager.mjs import-cdp` to refresh".

### 20. Error Taxonomy
Стандартизировать ошибки для AI-агентов:
```json
{
  "error": true,
  "code": "CAPTCHA_BLOCKED",  // or TIMEOUT, NETWORK, RATE_LIMITED, AUTH_EXPIRED
  "message": "...",
  "suggestion": "Try again in 5 min or switch engine"
}
```

---

## Приоритеты для v2.2.0

| # | Задача | Сложность | Влияние |
|---|--------|-----------|---------|
| 5 | Persistent fingerprint per profile | Средняя | 🔴 Критично |
| 6 | DRY browser launcher | Средняя | 🔴 Критично |
| 1 | Bing URL decode | Лёгкая | Высокое |
| 2 | Twitter stats fix | Лёгкая | Высокое |
| 3 | GitHub trending descriptions | Лёгкая | Среднее |
| 7 | Rate limiter | Средняя | Высокое |
| 8 | Canvas noise fix | Лёгкая | Среднее |
| 10 | Twitter aria-label parsing | Лёгкая | Высокое |
| 12 | Config file | Средняя | Среднее |
