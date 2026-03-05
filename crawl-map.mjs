#!/usr/bin/env node
process.env.DISPLAY = process.env.DISPLAY || ':99';

import { writeFileSync } from 'fs';
import { launch } from './browser-launcher.mjs';
import { ProxyIntelligence } from './proxy-intelligence.mjs';
import { createTrace } from './trace-recorder.mjs';

function getArg(args, name, def = null) {
  const idx = args.findIndex((a) => a === `--${name}`);
  if (idx !== -1 && args[idx + 1] && !args[idx + 1].startsWith('--')) return args[idx + 1];
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.split('=').slice(1).join('=');
  return def;
}

function normalizeUrl(base, href) {
  if (!href) return null;
  if (href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('javascript:') || href.startsWith('tel:')) return null;
  try {
    return new URL(href, base).toString().split('#')[0];
  } catch {
    return null;
  }
}

function sameDomain(a, b) {
  try {
    return new URL(a).hostname === new URL(b).hostname;
  } catch {
    return false;
  }
}

async function readPageMap(page, url, timeout) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  return await page.evaluate(() => {
    const title = document.title || '';
    const links = [];
    document.querySelectorAll('a[href]').forEach((a) => {
      const href = a.getAttribute('href');
      const text = (a.textContent || '').trim().slice(0, 120);
      if (href) links.push({ href, text });
    });
    return { title, links };
  });
}

async function main() {
  const args = process.argv.slice(2);
  const seedUrl = args.find((a) => !a.startsWith('--'));
  if (!seedUrl) {
    console.error('Usage: node crawl-map.mjs "https://site.com" [--depth 2] [--max-pages 50] [--same-domain] [--json] [--out graph.json] [--trace]');
    process.exit(1);
  }

  const depthMax = parseInt(getArg(args, 'depth', '2'), 10);
  const maxPages = parseInt(getArg(args, 'max-pages', '50'), 10);
  const timeout = parseInt(getArg(args, 'timeout', '30000'), 10);
  const jsonOut = args.includes('--json');
  const onlySameDomain = args.includes('--same-domain');
  const outPath = getArg(args, 'out', null);
  const profile = getArg(args, 'profile', null);
  const proxyArg = getArg(args, 'proxy', null);

  const trace = createTrace({ enabled: args.includes('--trace'), command: 'crawl-map', meta: { seedUrl } });
  const proxies = new ProxyIntelligence(proxyArg);
  const selectedProxy = proxies.pick(seedUrl);

  const browser = await launch({ profile, proxy: selectedProxy ? { server: selectedProxy.server } : null });
  const page = await browser.context.newPage();

  const t0 = Date.now();
  const nodes = new Map();
  const edges = [];
  const queue = [{ url: seedUrl, depth: 0 }];
  const seen = new Set();
  const startHost = (() => {
    try { return new URL(seedUrl).hostname; } catch { return null; }
  })();

  try {
    while (queue.length && nodes.size < maxPages) {
      const { url, depth } = queue.shift();
      if (!url || seen.has(url)) continue;
      if (depth > depthMax) continue;

      seen.add(url);
      trace.event('visit.start', { url, depth });

      let snapshot;
      try {
        snapshot = await readPageMap(page, url, timeout);
      } catch (err) {
        trace.event('visit.error', { url, depth, error: err.message });
        continue;
      }

      nodes.set(url, { url, depth, title: snapshot.title || '' });
      trace.event('visit.ok', { url, depth, links: snapshot.links.length });

      for (const l of snapshot.links) {
        const abs = normalizeUrl(url, l.href);
        if (!abs) continue;
        if (onlySameDomain && !sameDomain(seedUrl, abs)) continue;

        edges.push({ from: url, to: abs, anchor: l.text || '' });
        if (!seen.has(abs) && depth + 1 <= depthMax && nodes.size + queue.length < maxPages * 2) {
          if (!onlySameDomain || (startHost && new URL(abs).hostname === startHost)) {
            queue.push({ url: abs, depth: depth + 1 });
          }
        }
      }
    }

    const result = {
      tool: 'ghost-browse',
      command: 'crawl-map',
      seedUrl,
      generatedAt: new Date().toISOString(),
      constraints: { depthMax, maxPages, sameDomain: onlySameDomain },
      stats: {
        nodes: nodes.size,
        edges: edges.length,
        durationMs: Date.now() - t0,
      },
      nodes: [...nodes.values()],
      edges,
      trace: trace.filePath,
    };

    if (outPath) writeFileSync(outPath, JSON.stringify(result, null, 2));

    proxies.reportSuccess(selectedProxy?._proxyId, Date.now() - t0);
    trace.finish({ ok: true, nodes: nodes.size, edges: edges.length });

    if (jsonOut) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`\n🗺️ Crawl map for ${seedUrl}`);
      console.log(`Nodes: ${result.stats.nodes} | Edges: ${result.stats.edges} | Depth: ${depthMax}`);
      if (outPath) console.log(`Saved: ${outPath}`);
      if (trace.filePath) console.log(`Trace: ${trace.filePath}`);
      console.log('\nTop nodes:');
      result.nodes.slice(0, 20).forEach((n, i) => {
        console.log(`${i + 1}. [d${n.depth}] ${n.title || '(no title)'}`);
        console.log(`   ${n.url}`);
      });
    }
  } catch (err) {
    proxies.reportFailure(selectedProxy?._proxyId);
    trace.event('error', { message: err.message });
    trace.finish({ ok: false, error: err.message });
    throw err;
  } finally {
    try { await page.close(); } catch {}
    try { await browser.close(); } catch {}
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
