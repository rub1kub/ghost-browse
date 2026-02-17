#!/usr/bin/env node
/**
 * captcha-handler.mjs — Detect captchas, screenshot them, alert user via Telegram
 */
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dir = dirname(fileURLToPath(import.meta.url));
const CAPTCHA_DIR = join(__dir, 'captcha-screenshots');

// ─── Captcha detection patterns ──────────────────────────────────────────────

const CAPTCHA_SIGNALS = {
  titles: [
    /captcha/i, /robot/i, /human verification/i, /are you human/i,
    /security check/i, /unusual traffic/i, /access denied/i,
    /cloudflare/i, /just a moment/i, /ddos-guard/i, /please wait/i,
  ],
  urls: [
    /captcha/i, /challenge/i, /cf-chl/i, /recaptcha/i, /hcaptcha/i,
  ],
  content: [
    /verify you are human/i, /i'm not a robot/i, /click to verify/i,
    /security verification/i, /this site is protected by recaptcha/i,
    /complete the security check/i, /checking your browser/i,
    /one more step/i, /why do i have to complete a captcha/i,
  ],
};

export async function isCaptcha(page) {
  try {
    const title = await page.title();
    const url = page.url();

    // Check title
    if (CAPTCHA_SIGNALS.titles.some(rx => rx.test(title))) return { detected: true, type: 'title', signal: title };
    // Check URL
    if (CAPTCHA_SIGNALS.urls.some(rx => rx.test(url))) return { detected: true, type: 'url', signal: url };

    // Check page content
    const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 3000) || '');
    for (const rx of CAPTCHA_SIGNALS.content) {
      if (rx.test(bodyText)) return { detected: true, type: 'content', signal: rx.toString() };
    }

    return { detected: false };
  } catch {
    return { detected: false };
  }
}

export async function handleCaptcha(page, url, opts = {}) {
  const captchaInfo = await isCaptcha(page);
  if (!captchaInfo.detected) return false;

  console.log(`\n⚠️  CAPTCHA detected on ${url}`);
  console.log(`   Signal: ${captchaInfo.signal}`);

  // Screenshot it
  mkdirSync(CAPTCHA_DIR, { recursive: true });
  const timestamp = Date.now();
  const screenshotPath = join(CAPTCHA_DIR, `captcha-${timestamp}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: false });
  console.log(`   Screenshot: ${screenshotPath}`);

  // Alert user via Telegram if configured
  if (opts.alertTelegram) {
    await alertUserTelegram(screenshotPath, url, opts);
  }

  return true;
}

async function alertUserTelegram(screenshotPath, captchaUrl, opts = {}) {
  const target = opts.telegramTarget || '1084693264';
  const accountId = opts.telegramAccount || 'tima';

  try {
    // Use openclaw message tool via CLI or direct API
    // Try openclaw CLI first
    const message = `🤖 КАПЧА на ${captchaUrl}\n\nСкриншот прикреплён. Решить вручную или добавить прокси.`;

    // Write a temp script to send via openclaw
    const scriptPath = '/tmp/ghost-captcha-alert.mjs';
    writeFileSync(scriptPath, `
import fetch from 'node-fetch';
// This would call openclaw's message API
console.log('Captcha alert: ${captchaUrl}');
// Fallback: write to a file that heartbeat can pick up
import { writeFileSync } from 'fs';
writeFileSync('/tmp/ghost-captcha-pending.json', JSON.stringify({
  url: '${captchaUrl}',
  screenshot: '${screenshotPath}',
  time: new Date().toISOString()
}));
`);

    // Try to use openclaw CLI
    try {
      execSync(`openclaw message send --to ${target} --message "🤖 Капча обнаружена на: ${captchaUrl}" 2>/dev/null`, { timeout: 5000 });
    } catch {}

    // Always write to pending file for heartbeat pickup
    writeFileSync('/tmp/ghost-captcha-pending.json', JSON.stringify({
      url: captchaUrl,
      screenshot: screenshotPath,
      time: new Date().toISOString(),
      message,
    }));

    console.log('   Telegram alert queued (check /tmp/ghost-captcha-pending.json)');
  } catch (e) {
    console.log('   Alert failed:', e.message);
  }
}

export default { isCaptcha, handleCaptcha };
