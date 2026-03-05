#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dir, '.cache');
const HEAL_PATH = join(CACHE_DIR, 'self-heal.json');

function loadData() {
  if (!existsSync(HEAL_PATH)) return { keys: {} };
  try {
    const data = JSON.parse(readFileSync(HEAL_PATH, 'utf8'));
    return data && typeof data === 'object' ? data : { keys: {} };
  } catch {
    return { keys: {} };
  }
}

function saveData(data) {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(HEAL_PATH, JSON.stringify(data, null, 2));
}

function ensureSelectorNode(data, key, selector) {
  if (!data.keys[key]) data.keys[key] = { selectors: {} };
  if (!data.keys[key].selectors[selector]) {
    data.keys[key].selectors[selector] = {
      ok: 0,
      fail: 0,
      lastOkAt: null,
      lastFailAt: null,
    };
  }
  return data.keys[key].selectors[selector];
}

function selectorScore(stats) {
  const total = stats.ok + stats.fail;
  const rate = total ? stats.ok / total : 0.5;
  const confidence = Math.min(1, total / 8);
  return rate * 0.8 + confidence * 0.2;
}

export class SelfHealStore {
  constructor() {
    this.data = loadData();
  }

  orderedSelectors(key, selectors = []) {
    const unique = [...new Set(selectors.filter(Boolean))];
    if (!unique.length) return [];

    return unique
      .map((selector) => {
        const stats = this.data.keys?.[key]?.selectors?.[selector] || { ok: 0, fail: 0 };
        return {
          selector,
          score: selectorScore(stats),
          attempts: (stats.ok || 0) + (stats.fail || 0),
        };
      })
      .sort((a, b) => b.score - a.score || b.attempts - a.attempts)
      .map((x) => x.selector);
  }

  record(key, selector, success) {
    const node = ensureSelectorNode(this.data, key, selector);
    if (success) {
      node.ok += 1;
      node.lastOkAt = new Date().toISOString();
    } else {
      node.fail += 1;
      node.lastFailAt = new Date().toISOString();
    }
    saveData(this.data);
  }

  snapshot(key = null) {
    if (!key) return this.data;
    return this.data.keys?.[key] || { selectors: {} };
  }
}

export async function runHealedAction({ page, key, selectors, action }) {
  const store = new SelfHealStore();
  const ordered = store.orderedSelectors(key, selectors);
  let lastErr = null;

  for (const selector of ordered) {
    try {
      const ok = await action(selector);
      if (ok) {
        store.record(key, selector, true);
        return { ok: true, selector };
      }
      store.record(key, selector, false);
    } catch (err) {
      lastErr = err;
      store.record(key, selector, false);
    }
  }

  if (lastErr) throw lastErr;
  return { ok: false, selector: null };
}

export default { SelfHealStore, runHealedAction };
