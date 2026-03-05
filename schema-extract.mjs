#!/usr/bin/env node
process.env.DISPLAY = process.env.DISPLAY || ':99';

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { launch } from './browser-launcher.mjs';
import { ProxyIntelligence } from './proxy-intelligence.mjs';
import { SelfHealStore } from './self-heal-store.mjs';
import { createTrace } from './trace-recorder.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));

function getArg(args, name, def = null) {
  const idx = args.findIndex((a) => a === `--${name}`);
  if (idx !== -1 && args[idx + 1] && !args[idx + 1].startsWith('--')) return args[idx + 1];
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.split('=').slice(1).join('=');
  return def;
}

function parseSchema(schemaArg) {
  if (!schemaArg) throw new Error('schema is required: --schema file.json or --schema-json "{...}"');
  if (existsSync(schemaArg)) return JSON.parse(readFileSync(schemaArg, 'utf8'));
  return JSON.parse(schemaArg);
}

function normalizeSchema(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('invalid schema');
  const fields = raw.fields || raw.properties || {};
  if (!fields || typeof fields !== 'object') throw new Error('schema must include fields/properties object');
  return fields;
}

function applyTransform(v, transform) {
  if (v == null) return v;
  if (!transform) return v;
  const t = String(transform).toLowerCase();
  if (t === 'trim') return String(v).trim();
  if (t === 'lower') return String(v).toLowerCase();
  if (t === 'upper') return String(v).toUpperCase();
  if (t === 'number') {
    const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  if (t === 'int') {
    const n = parseInt(String(v).replace(/[^0-9\-]/g, ''), 10);
    return Number.isFinite(n) ? n : null;
  }
  return v;
}

async function readValue(page, selector, cfg = {}) {
  const attr = cfg.attr || cfg.type || 'text';
  const multiple = Boolean(cfg.multiple || cfg.array || attr === 'array');

  const reader = (el, attrName) => {
    if (!el) return null;
    if (attrName === 'text') return (el.textContent || '').trim();
    if (attrName === 'html') return el.innerHTML || '';
    if (attrName === 'href') return el.getAttribute('href') || el.href || null;
    if (attrName === 'src') return el.getAttribute('src') || el.src || null;
    if (attrName === 'value') return el.value ?? el.getAttribute('value');
    return el.getAttribute(attrName);
  };

  if (multiple) {
    const arr = await page.$$eval(
      selector,
      (els, attrName) => {
        const out = [];
        for (const el of els) {
          if (attrName === 'text') out.push((el.textContent || '').trim());
          else if (attrName === 'html') out.push(el.innerHTML || '');
          else if (attrName === 'href') out.push(el.getAttribute('href') || el.href || null);
          else if (attrName === 'src') out.push(el.getAttribute('src') || el.src || null);
          else if (attrName === 'value') out.push(el.value ?? el.getAttribute('value'));
          else out.push(el.getAttribute(attrName));
        }
        return out.filter((x) => x != null && String(x).trim() !== '');
      },
      attr,
    );
    return arr.length ? arr : null;
  }

  const handle = await page.$(selector);
  if (!handle) return null;
  const value = await handle.evaluate(reader, attr);
  return value == null || String(value).trim() === '' ? null : value;
}

async function extractWithSchema(page, fields, trace) {
  const store = new SelfHealStore();
  const data = {};
  const meta = { usedSelectors: {}, missingFields: [], warnings: [] };

  for (const [fieldName, cfgRaw] of Object.entries(fields)) {
    const cfg = cfgRaw || {};
    const rawSelectors = cfg.selectors || (cfg.selector ? [cfg.selector] : []);
    const selectors = store.orderedSelectors(`schema:${fieldName}`, rawSelectors);

    if (!selectors.length) {
      meta.missingFields.push(fieldName);
      meta.warnings.push(`field ${fieldName} has no selector`);
      continue;
    }

    let value = null;
    let used = null;
    for (const selector of selectors) {
      try {
        const v = await readValue(page, selector, cfg);
        if (v != null && (Array.isArray(v) ? v.length : String(v).trim() !== '')) {
          value = v;
          used = selector;
          store.record(`schema:${fieldName}`, selector, true);
          break;
        }
        store.record(`schema:${fieldName}`, selector, false);
      } catch {
        store.record(`schema:${fieldName}`, selector, false);
      }
    }

    if (value == null && cfg.default !== undefined) value = cfg.default;

    if (value == null && cfg.required) {
      meta.missingFields.push(fieldName);
    }

    if (value != null) {
      if (Array.isArray(value) && cfg.transform) {
        value = value.map((x) => applyTransform(x, cfg.transform));
      } else {
        value = applyTransform(value, cfg.transform);
      }
      data[fieldName] = value;
      meta.usedSelectors[fieldName] = used;
      trace?.event('field.extracted', { field: fieldName, selector: used });
    } else {
      trace?.event('field.missing', { field: fieldName });
    }
  }

  return { data, meta };
}

async function main() {
  const args = process.argv.slice(2);
  const url = args.find((a) => !a.startsWith('--'));
  if (!url) {
    console.error('Usage: node schema-extract.mjs "https://..." --schema schema.json [--profile name] [--proxy fileOrUrl] [--json] [--trace]');
    process.exit(1);
  }

  const schemaArg = getArg(args, 'schema', null) || getArg(args, 'schema-json', null);
  const schema = parseSchema(schemaArg);
  const fields = normalizeSchema(schema);

  const jsonOut = args.includes('--json');
  const trace = createTrace({ enabled: args.includes('--trace'), command: 'schema-extract', meta: { url } });
  const profile = getArg(args, 'profile', null);
  const proxyArg = getArg(args, 'proxy', null);
  const timeout = parseInt(getArg(args, 'timeout', '30000'), 10);

  const proxies = new ProxyIntelligence(proxyArg);
  const selectedProxy = proxies.pick(url);
  const t0 = Date.now();

  let browser = null;
  let page = null;
  try {
    browser = await launch({ profile, proxy: selectedProxy ? { server: selectedProxy.server } : null });
    page = await browser.context.newPage();

    trace.event('navigate.start', { url, proxy: selectedProxy?._proxyId || null, profile: profile || null });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    trace.event('navigate.ok', { finalUrl: page.url() });

    const { data, meta } = await extractWithSchema(page, fields, trace);
    const result = {
      tool: 'ghost-browse',
      command: 'schema-extract',
      url: page.url(),
      title: await page.title(),
      extractedAt: new Date().toISOString(),
      data,
      meta,
      trace: trace.filePath,
    };

    proxies.reportSuccess(selectedProxy?._proxyId, Date.now() - t0);
    trace.finish({ ok: true, fields: Object.keys(data).length });

    if (jsonOut) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`\n🧩 Schema extract: ${result.title}`);
      console.log(`🔗 ${result.url}`);
      console.log(JSON.stringify(result.data, null, 2));
      if (result.meta.missingFields.length) {
        console.log(`\n⚠️ Missing fields: ${result.meta.missingFields.join(', ')}`);
      }
      if (result.trace) console.log(`\n🧵 Trace: ${result.trace}`);
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
