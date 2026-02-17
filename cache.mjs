#!/usr/bin/env node
/**
 * cache.mjs — Smart page cache with TTL
 * Saves fetch results to avoid redundant browser launches
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';

const __dir = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dir, '.cache');
const DEFAULT_TTL = 10 * 60 * 1000; // 10 minutes

export function cacheKey(url) {
  return createHash('md5').update(url).digest('hex');
}

export function getCached(url, ttlMs = DEFAULT_TTL) {
  const key = cacheKey(url);
  const path = join(CACHE_DIR, `${key}.json`);
  if (!existsSync(path)) return null;
  try {
    const stat = statSync(path);
    if (Date.now() - stat.mtimeMs > ttlMs) {
      unlinkSync(path);
      return null;
    }
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

export function setCache(url, data) {
  mkdirSync(CACHE_DIR, { recursive: true });
  const key = cacheKey(url);
  const path = join(CACHE_DIR, `${key}.json`);
  writeFileSync(path, JSON.stringify({ url, cachedAt: new Date().toISOString(), ...data }));
}

export function clearCache() {
  if (!existsSync(CACHE_DIR)) return 0;
  const files = readdirSync(CACHE_DIR).filter(f => f.endsWith('.json'));
  files.forEach(f => unlinkSync(join(CACHE_DIR, f)));
  return files.length;
}

export function cacheStats() {
  if (!existsSync(CACHE_DIR)) return { entries: 0, sizeKB: 0 };
  const files = readdirSync(CACHE_DIR).filter(f => f.endsWith('.json'));
  const totalSize = files.reduce((sum, f) => sum + statSync(join(CACHE_DIR, f)).size, 0);
  return { entries: files.length, sizeKB: Math.round(totalSize / 1024) };
}
