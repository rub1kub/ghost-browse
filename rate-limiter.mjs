/**
 * rate-limiter.mjs — Per-domain rate limiting
 * Prevents IP bans from rapid requests to the same domain.
 */
import { loadConfig } from './config.mjs';

const requestLog = new Map(); // domain → [timestamp, timestamp, ...]

function getDomain(urlOrDomain) {
  try {
    if (urlOrDomain.includes('://')) {
      return new URL(urlOrDomain).hostname;
    }
    return urlOrDomain;
  } catch {
    return urlOrDomain;
  }
}

function getLimit(domain) {
  const config = loadConfig();
  const limits = config.rateLimits || {};
  // Match exact domain or parent
  if (limits[domain]) return limits[domain];
  // Try parent: api.x.com → x.com
  const parts = domain.split('.');
  if (parts.length > 2) {
    const parent = parts.slice(-2).join('.');
    if (limits[parent]) return limits[parent];
  }
  return limits.default || { requests: 20, perMs: 60000 };
}

/**
 * Wait if rate limit would be exceeded for this domain
 * @param {string} urlOrDomain - URL or domain name
 * @returns {Promise<void>}
 */
export async function waitForSlot(urlOrDomain) {
  const domain = getDomain(urlOrDomain);
  const limit = getLimit(domain);
  const now = Date.now();

  if (!requestLog.has(domain)) {
    requestLog.set(domain, []);
  }

  const log = requestLog.get(domain);

  // Clean old entries outside the window
  while (log.length && log[0] < now - limit.perMs) {
    log.shift();
  }

  if (log.length >= limit.requests) {
    // Need to wait until the oldest request exits the window
    const waitMs = log[0] + limit.perMs - now + 100; // +100ms buffer
    if (waitMs > 0) {
      console.log(`  ⏱️  Rate limit: waiting ${Math.round(waitMs / 1000)}s for ${domain} (${limit.requests}/${limit.perMs / 1000}s)`);
      await new Promise(r => setTimeout(r, waitMs));
    }
    // Clean again after waiting
    const nowAfter = Date.now();
    while (log.length && log[0] < nowAfter - limit.perMs) {
      log.shift();
    }
  }

  log.push(Date.now());
}

/**
 * Record a request without waiting (for tracking only)
 */
export function recordRequest(urlOrDomain) {
  const domain = getDomain(urlOrDomain);
  if (!requestLog.has(domain)) {
    requestLog.set(domain, []);
  }
  requestLog.get(domain).push(Date.now());
}

/**
 * Get current rate limit status for all domains
 */
export function getStatus() {
  const status = {};
  const now = Date.now();
  for (const [domain, log] of requestLog) {
    const limit = getLimit(domain);
    const recentCount = log.filter(t => t > now - limit.perMs).length;
    status[domain] = {
      recent: recentCount,
      limit: limit.requests,
      windowMs: limit.perMs,
    };
  }
  return status;
}

export default { waitForSlot, recordRequest, getStatus };
