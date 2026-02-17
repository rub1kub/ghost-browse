#!/usr/bin/env node
/**
 * browser-launcher.mjs — Unified browser launcher for ghost-browse
 * Single source of truth: profile copy, persistent context, fingerprint, cleanup.
 * All modules import this instead of duplicating launch code.
 */
process.env.DISPLAY = process.env.DISPLAY || ':99';

import { chromium } from 'playwright';
import { execSync } from 'child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { generateFingerprint, getFingerprintScript } from './fingerprint.mjs';
import { loadConfig } from './config.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const PROFILES_DIR = join(__dir, 'profiles');

/**
 * Copy Chrome user-data to temp dir (avoids SingletonLock conflicts)
 */
function copyUserData(userDataDir) {
  const tmp = mkdtempSync(join(tmpdir(), 'ghost-browse-'));
  execSync(`cp -r "${userDataDir}/." "${tmp}" 2>/dev/null; rm -f "${tmp}/SingletonLock" "${tmp}/SingletonCookie" "${tmp}/SingletonSocket"`, { timeout: 15000 });
  return tmp;
}

/**
 * Load cookie profile by name
 */
export function loadProfile(name) {
  if (!name) return null;
  const path = join(PROFILES_DIR, `${name}.json`);
  if (!existsSync(path)) {
    console.error(`Profile "${name}" not found. Run: node profile-manager.mjs import-cdp`);
    return null;
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Launch a persistent browser context with full stealth setup
 * 
 * @param {Object} opts
 * @param {string} opts.profile - Cookie profile name (e.g. 'x-com', 'reddit-com')
 * @param {Object} opts.proxy - Proxy config { server: 'http://...' }
 * @param {Object} opts.viewport - { width, height }
 * @param {boolean} opts.anonymousFingerprint - Force random fingerprint even with profile
 * @returns {{ context, close, profileDir, fingerprint }}
 */
export async function launch(opts = {}) {
  const config = loadConfig();
  const userDataDir = config.userDataDir;
  const chromeExe = config.chromeExecutable;
  const display = config.display;

  process.env.DISPLAY = display;

  const VIEWPORTS = [
    { width: 1920, height: 1080 },
    { width: 1440, height: 900 },
    { width: 1366, height: 768 },
    { width: 1280, height: 800 },
    { width: 1536, height: 864 },
  ];

  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const vp = opts.viewport || pick(VIEWPORTS);
  const profileDir = copyUserData(userDataDir);

  // Generate fingerprint: persistent for profiles, random for anonymous
  const fpSeed = (opts.profile && !opts.anonymousFingerprint) ? opts.profile : null;
  const fp = generateFingerprint(fpSeed);

  const ctxOpts = {
    headless: false,
    executablePath: chromeExe,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-infobars',
      `--window-size=${vp.width},${vp.height}`,
    ],
    env: { ...process.env, DISPLAY: display },
    viewport: vp,
    locale: 'en-US',
    timezoneId: fp._timezone || pick(['America/New_York', 'America/Los_Angeles', 'Europe/London', 'Europe/Berlin']),
  };

  if (opts.proxy) ctxOpts.proxy = opts.proxy;

  const context = await chromium.launchPersistentContext(profileDir, ctxOpts);

  // Inject fingerprint spoofing
  await context.addInitScript(getFingerprintScript(fp));

  // Load cookie profile if specified
  if (opts.profile) {
    const profile = loadProfile(opts.profile);
    if (profile?.cookies?.length) {
      try { await context.addCookies(profile.cookies); } catch (e) {
        console.error(`Warning: failed to load cookies for ${opts.profile}: ${e.message}`);
      }
    }
  }

  // Wrap close to cleanup temp dir
  const origClose = context.close.bind(context);
  const close = async () => {
    await origClose();
    try { rmSync(profileDir, { recursive: true, force: true }); } catch {}
  };

  return {
    context,
    close,
    profileDir,
    fingerprint: fp,
  };
}

export default { launch, loadProfile };
