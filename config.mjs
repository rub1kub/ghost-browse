/**
 * config.mjs — Configuration loader for ghost-browse
 * Reads ghost-browse.config.json if present, falls back to defaults.
 */
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dir, 'ghost-browse.config.json');

const DEFAULTS = {
  chromeExecutable: '/usr/bin/google-chrome-stable',
  userDataDir: '/home/openclawd/.openclaw/browser/openclaw/user-data',
  display: ':99',
  defaultEngine: 'ddg',
  cacheTtlMs: 600000,
  serverPort: 3847,
  serverHost: '127.0.0.1',
  // Optional auth token for HTTP server mode (Bearer)
  serverAuthToken: process.env.GHOST_BROWSE_TOKEN || null,
  rateLimits: {
    'google.com': { requests: 3, perMs: 60000 },
    'x.com': { requests: 10, perMs: 60000 },
    'twitter.com': { requests: 10, perMs: 60000 },
    'reddit.com': { requests: 10, perMs: 60000 },
    default: { requests: 20, perMs: 60000 },
  },
  profileMaxAgeDays: 7, // warn if profile cookies are older than this
};

let _config = null;

export function loadConfig() {
  if (_config) return _config;

  let fileConfig = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      fileConfig = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    } catch (e) {
      console.error(`Warning: failed to parse ${CONFIG_PATH}: ${e.message}`);
    }
  }

  _config = { ...DEFAULTS, ...fileConfig };
  // Deep merge rateLimits
  if (fileConfig.rateLimits) {
    _config.rateLimits = { ...DEFAULTS.rateLimits, ...fileConfig.rateLimits };
  }
  return _config;
}

export function getConfig(key) {
  const config = loadConfig();
  return config[key];
}

export default { loadConfig, getConfig };
