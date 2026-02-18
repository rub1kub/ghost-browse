#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { loadConfig } from './config.mjs';
import { generateFingerprint } from './fingerprint.mjs';

const LIVE = process.argv.includes('--live');

function ok(msg) {
  console.log(`✅ ${msg}`);
}

function info(msg) {
  console.log(`• ${msg}`);
}

async function waitForServer(url, headers = {}) {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(url, { headers });
      if (res.ok || res.status === 401) return;
    } catch {}
    await sleep(250);
  }
  throw new Error(`Server did not start: ${url}`);
}

async function withServer(args, fn) {
  const proc = spawn('node', ['server.mjs', ...args], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  proc.stdout.on('data', (d) => process.stdout.write(String(d)));
  proc.stderr.on('data', (d) => process.stderr.write(String(d)));

  try {
    await fn(proc);
  } finally {
    try {
      proc.kill('SIGTERM');
    } catch {}
  }
}

async function testConfigDefaults() {
  const cfg = loadConfig();
  assert.equal(cfg.serverHost, '127.0.0.1');
  assert.equal(typeof cfg.serverPort, 'number');
  assert.ok(cfg.rateLimits['google.com']);
  ok('config defaults loaded (serverHost/serverPort/rateLimits)');
}

async function testFingerprintDeterminism() {
  const a = generateFingerprint('x-com');
  const b = generateFingerprint('x-com');
  const c = generateFingerprint('reddit-com');
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  ok('seeded fingerprint is deterministic per profile');
}

async function testServerAuthGuard() {
  const port = 3990 + Math.floor(Math.random() * 50);
  const host = '127.0.0.1';
  const token = 'test-token-123';
  const base = `http://${host}:${port}`;

  await withServer(['--host', host, '--port', String(port), '--token', token], async () => {
    await waitForServer(`${base}/status`);

    const noAuth = await fetch(`${base}/status`);
    assert.equal(noAuth.status, 401);

    const withAuth = await fetch(`${base}/status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(withAuth.status, 200);
    const body = await withAuth.json();
    assert.equal(body.status, 'running');

    const stopRes = await fetch(`${base}/stop`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(stopRes.status, 200);
  });

  ok('server auth guard works (401 without Bearer, 200 with Bearer)');
}

async function testLiveSmoke() {
  const port = 4050 + Math.floor(Math.random() * 50);
  const host = '127.0.0.1';
  const base = `http://${host}:${port}`;

  await withServer(['--host', host, '--port', String(port)], async () => {
    await waitForServer(`${base}/status`);

    const searchRes = await fetch(`${base}/search?q=openclaw&engine=ddg&limit=3`);
    assert.equal(searchRes.status, 200);
    const search = await searchRes.json();
    assert.ok(Array.isArray(search.results));
    assert.ok(search.results.length > 0, 'live search returned empty results');

    const fetchRes = await fetch(`${base}/fetch?url=${encodeURIComponent('https://example.com')}&max=800`);
    assert.equal(fetchRes.status, 200);
    const page = await fetchRes.json();
    assert.ok(page.content && page.content.length > 50, 'live fetch returned too little content');

    const stopRes = await fetch(`${base}/stop`, { method: 'POST' });
    assert.equal(stopRes.status, 200);
  });

  ok('live smoke passed (search + fetch)');
}

async function main() {
  info('Running ghost-browse tests...');
  await testConfigDefaults();
  await testFingerprintDeterminism();
  await testServerAuthGuard();

  if (LIVE) {
    info('Running live smoke checks...');
    await testLiveSmoke();
  } else {
    info('Skipping live smoke (run with --live)');
  }

  console.log('\n🎉 All tests passed');
}

main().catch((err) => {
  console.error('\n❌ Test failed');
  console.error(err);
  process.exit(1);
});
