#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(__dir, '.cache');
const STATE_PATH = join(STATE_DIR, 'proxy-health.json');

function now() {
  return Date.now();
}

function normalizeProxy(p) {
  if (!p) return null;
  const trimmed = String(p).trim();
  if (!trimmed) return null;
  return trimmed.includes('://') ? trimmed : `http://${trimmed}`;
}

function loadProxyList(proxyArg) {
  if (!proxyArg) return [];
  if (existsSync(proxyArg)) {
    return readFileSync(proxyArg, 'utf8')
      .split('\n')
      .map((x) => normalizeProxy(x))
      .filter(Boolean);
  }
  return [normalizeProxy(proxyArg)].filter(Boolean);
}

function loadState() {
  if (!existsSync(STATE_PATH)) return { proxies: {}, sticky: {} };
  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
    return {
      proxies: parsed.proxies || {},
      sticky: parsed.sticky || {},
    };
  } catch {
    return { proxies: {}, sticky: {} };
  }
}

function saveState(state) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function domainFrom(input) {
  if (!input) return 'unknown';
  try {
    if (String(input).includes('://')) return new URL(input).hostname;
    return String(input).toLowerCase();
  } catch {
    return 'unknown';
  }
}

function ensureProxyStats(state, proxy) {
  if (!state.proxies[proxy]) {
    state.proxies[proxy] = {
      ok: 0,
      fail: 0,
      score: 0,
      lastLatencyMs: null,
      lastSeenAt: null,
      cooldownUntil: 0,
    };
  }
  return state.proxies[proxy];
}

function calcHealth(stats) {
  const attempts = stats.ok + stats.fail;
  const successRate = attempts ? stats.ok / attempts : 0.5;
  const latencyPenalty = stats.lastLatencyMs ? Math.min(0.35, stats.lastLatencyMs / 12000) : 0;
  const recencyBonus = stats.lastSeenAt ? 0.05 : 0;
  return successRate - latencyPenalty + recencyBonus;
}

export class ProxyIntelligence {
  constructor(proxyArg) {
    this.list = loadProxyList(proxyArg);
    this.state = loadState();
    this.lastPicked = null;

    for (const p of this.list) ensureProxyStats(this.state, p);
    saveState(this.state);
  }

  count() {
    return this.list.length;
  }

  pick(targetUrlOrDomain = 'unknown') {
    if (!this.list.length) return null;

    const domain = domainFrom(targetUrlOrDomain);
    const nowTs = now();

    // Sticky session per domain if proxy is still healthy and not cooling down
    const stickyProxy = this.state.sticky[domain];
    if (stickyProxy && this.list.includes(stickyProxy)) {
      const st = ensureProxyStats(this.state, stickyProxy);
      if (!st.cooldownUntil || st.cooldownUntil <= nowTs) {
        this.lastPicked = stickyProxy;
        return { server: stickyProxy, _proxyId: stickyProxy, _domain: domain, _sticky: true };
      }
    }

    const candidates = this.list
      .map((proxy) => {
        const st = ensureProxyStats(this.state, proxy);
        return {
          proxy,
          stats: st,
          cooling: st.cooldownUntil && st.cooldownUntil > nowTs,
          health: calcHealth(st),
        };
      })
      .filter((x) => !x.cooling)
      .sort((a, b) => b.health - a.health);

    const selected = (candidates[0] || { proxy: this.list[0] }).proxy;
    this.state.sticky[domain] = selected;
    saveState(this.state);

    this.lastPicked = selected;
    return { server: selected, _proxyId: selected, _domain: domain, _sticky: false };
  }

  reportSuccess(proxyId, latencyMs = null) {
    if (!proxyId) return;
    const st = ensureProxyStats(this.state, proxyId);
    st.ok += 1;
    st.lastSeenAt = new Date().toISOString();
    st.lastLatencyMs = Number.isFinite(latencyMs) ? Math.round(latencyMs) : st.lastLatencyMs;
    st.cooldownUntil = 0;
    st.score = calcHealth(st);
    saveState(this.state);
  }

  reportFailure(proxyId) {
    if (!proxyId) return;
    const st = ensureProxyStats(this.state, proxyId);
    st.fail += 1;
    st.lastSeenAt = new Date().toISOString();
    const cooldownMs = Math.min(10 * 60 * 1000, 20_000 * Math.max(1, st.fail));
    st.cooldownUntil = now() + cooldownMs;
    st.score = calcHealth(st);
    saveState(this.state);
  }

  snapshot() {
    return {
      total: this.list.length,
      proxies: this.list.map((p) => ({ proxy: p, ...(this.state.proxies[p] || {}) })),
      sticky: this.state.sticky,
    };
  }
}

export default { ProxyIntelligence };
