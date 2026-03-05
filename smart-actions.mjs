#!/usr/bin/env node
process.env.DISPLAY = process.env.DISPLAY || ':99';

import { launch } from './browser-launcher.mjs';
import { runHealedAction } from './self-heal-store.mjs';
import { createTrace } from './trace-recorder.mjs';
import { ProxyIntelligence } from './proxy-intelligence.mjs';

function getArg(args, name, def = null) {
  const idx = args.findIndex((a) => a === `--${name}`);
  if (idx !== -1 && args[idx + 1] && !args[idx + 1].startsWith('--')) return args[idx + 1];
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.split('=').slice(1).join('=');
  return def;
}

function splitSelectors(raw) {
  if (!raw) return [];
  return raw
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

async function actOnSelector(page, selector, action, textValue = '') {
  const isTextSelector = selector.startsWith('text=');
  if (isTextSelector) {
    const t = selector.slice('text='.length);
    const loc = page.getByText(t).first();
    if ((await loc.count()) === 0) return false;
    if (action === 'click') await loc.click({ timeout: 5000 });
    if (action === 'type') await loc.fill(textValue, { timeout: 5000 });
    return true;
  }

  const loc = page.locator(selector).first();
  if ((await loc.count()) === 0) return false;
  if (action === 'click') await loc.click({ timeout: 5000 });
  if (action === 'type') await loc.fill(textValue, { timeout: 5000 });
  return true;
}

async function main() {
  const [,, action, ...args] = process.argv;
  if (!['click', 'type'].includes(action)) {
    console.error('Usage: node smart-actions.mjs <click|type> "https://..." --key action_key --selectors "sel1,sel2,text=Log in" [--value "..."] [--profile x-com] [--trace]');
    process.exit(1);
  }

  const url = args.find((a) => !a.startsWith('--'));
  const key = getArg(args, 'key', null);
  const selectors = splitSelectors(getArg(args, 'selectors', ''));
  const value = getArg(args, 'value', '');
  const profile = getArg(args, 'profile', null);
  const proxyArg = getArg(args, 'proxy', null);
  const timeout = parseInt(getArg(args, 'timeout', '30000'), 10);
  const jsonOut = args.includes('--json');
  const screenshot = getArg(args, 'screenshot', null);

  if (!url || !key || !selectors.length) {
    console.error('Missing required args: url, --key, --selectors');
    process.exit(1);
  }

  const trace = createTrace({ enabled: args.includes('--trace'), command: `smart-${action}`, meta: { key, url } });
  const proxies = new ProxyIntelligence(proxyArg);
  const selectedProxy = proxies.pick(url);
  const t0 = Date.now();

  let browser = null;
  let page = null;
  try {
    browser = await launch({ profile, proxy: selectedProxy ? { server: selectedProxy.server } : null });
    page = await browser.context.newPage();

    trace.event('navigate.start', { url, action, proxy: selectedProxy?._proxyId || null });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    trace.event('navigate.ok', { finalUrl: page.url() });

    const result = await runHealedAction({
      page,
      key,
      selectors,
      action: async (selector) => {
        trace.event('selector.try', { selector });
        const ok = await actOnSelector(page, selector, action, value);
        trace.event('selector.result', { selector, ok });
        return ok;
      },
    });

    if (!result.ok) throw new Error(`No selector worked for key=${key}`);

    if (screenshot) {
      await page.screenshot({ path: screenshot, fullPage: false });
      trace.event('screenshot', { path: screenshot });
    }

    const out = {
      tool: 'ghost-browse',
      command: 'smart-actions',
      action,
      key,
      selectorUsed: result.selector,
      url: page.url(),
      ok: true,
      trace: trace.filePath,
      tookMs: Date.now() - t0,
    };

    proxies.reportSuccess(selectedProxy?._proxyId, Date.now() - t0);
    trace.finish({ ok: true, selector: result.selector });

    if (jsonOut) console.log(JSON.stringify(out, null, 2));
    else {
      console.log(`✅ ${action} done: ${result.selector}`);
      console.log(`🔗 ${page.url()}`);
      if (trace.filePath) console.log(`🧵 Trace: ${trace.filePath}`);
    }
  } catch (err) {
    proxies.reportFailure(selectedProxy?._proxyId);
    trace.event('error', { message: err.message });
    trace.finish({ ok: false, error: err.message });
    throw err;
  } finally {
    try { await page?.close(); } catch {}
    try { await browser?.close(); } catch {}
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
