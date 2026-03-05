#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __dir = dirname(fileURLToPath(import.meta.url));
const QUEUE_DIR = join(__dir, '.queue');
const STATE_PATH = join(QUEUE_DIR, 'jobs-state.json');
const RESULTS_DIR = join(QUEUE_DIR, 'results');

function nowIso() {
  return new Date().toISOString();
}

function newId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ensureDirs() {
  mkdirSync(QUEUE_DIR, { recursive: true });
  mkdirSync(RESULTS_DIR, { recursive: true });
}

function loadState() {
  ensureDirs();
  if (!existsSync(STATE_PATH)) return { jobs: [] };
  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
    return { jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [] };
  } catch {
    return { jobs: [] };
  }
}

function saveState(state) {
  ensureDirs();
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function getArg(args, name, def = null) {
  const idx = args.findIndex((a) => a === `--${name}`);
  if (idx !== -1 && args[idx + 1] && !args[idx + 1].startsWith('--')) return args[idx + 1];
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.split('=').slice(1).join('=');
  return def;
}

function buildJobCommand(job) {
  const extra = Array.isArray(job.extraArgs) ? job.extraArgs : [];

  if (job.kind === 'fetch') return ['ghost-browse.mjs', 'fetch', job.target, '--json', ...extra];
  if (job.kind === 'search') return ['ghost-browse.mjs', 'search', job.target, '--json', ...extra];
  if (job.kind === 'map') return ['crawl-map.mjs', job.target, '--json', ...extra];
  if (job.kind === 'extract-schema') return ['schema-extract.mjs', job.target, '--json', ...extra];
  if (job.kind === 'smart-click') return ['smart-actions.mjs', 'click', job.target, '--json', ...extra];
  if (job.kind === 'smart-type') return ['smart-actions.mjs', 'type', job.target, '--json', ...extra];

  throw new Error(`Unsupported job kind: ${job.kind}`);
}

function cmdEnqueue(rest) {
  const [kind, target, ...extraArgs] = rest;
  if (!kind || !target) {
    console.error('Usage: node queue-runner.mjs enqueue <fetch|search|map|extract-schema|smart-click|smart-type> <target> [extra args]');
    process.exit(1);
  }

  const state = loadState();
  const job = {
    id: newId(),
    kind,
    target,
    extraArgs,
    status: 'pending',
    attempts: 0,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    startedAt: null,
    finishedAt: null,
    error: null,
    resultPath: null,
  };

  state.jobs.push(job);
  saveState(state);
  console.log(JSON.stringify({ ok: true, queued: job }, null, 2));
}

function resumeStaleInProgress(state, staleMs = 10 * 60 * 1000) {
  const now = Date.now();
  for (const job of state.jobs) {
    if (job.status !== 'in_progress' || !job.startedAt) continue;
    const age = now - new Date(job.startedAt).getTime();
    if (age > staleMs) {
      job.status = 'pending';
      job.error = 'resumed after stale in_progress state';
      job.updatedAt = nowIso();
    }
  }
}

function runOne(job, timeoutMs) {
  const cmd = buildJobCommand(job);
  const proc = spawnSync('node', cmd, {
    cwd: __dir,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
  });

  const out = {
    status: proc.status,
    signal: proc.signal,
    stdout: proc.stdout || '',
    stderr: proc.stderr || '',
  };

  return out;
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function cmdRun(rest) {
  const timeoutMs = parseInt(getArg(rest, 'timeout-ms', '300000'), 10);
  const maxJobs = parseInt(getArg(rest, 'max', '100'), 10);
  const once = rest.includes('--once');

  const state = loadState();
  resumeStaleInProgress(state);

  const queue = state.jobs.filter((j) => j.status === 'pending').slice(0, maxJobs);
  if (!queue.length) {
    console.log(JSON.stringify({ ok: true, message: 'no pending jobs' }, null, 2));
    return;
  }

  const results = [];
  for (const job of queue) {
    job.status = 'in_progress';
    job.attempts = (job.attempts || 0) + 1;
    job.startedAt = nowIso();
    job.updatedAt = nowIso();
    saveState(state);

    const run = runOne(job, timeoutMs);

    const resultPath = join(RESULTS_DIR, `${job.id}.json`);
    const parsed = safeJsonParse(run.stdout.trim());
    const resultPayload = {
      jobId: job.id,
      kind: job.kind,
      target: job.target,
      runAt: nowIso(),
      process: {
        status: run.status,
        signal: run.signal,
      },
      output: parsed ?? { rawStdout: run.stdout, rawStderr: run.stderr },
    };
    writeFileSync(resultPath, JSON.stringify(resultPayload, null, 2));

    job.resultPath = resultPath;
    job.finishedAt = nowIso();
    job.updatedAt = nowIso();

    if (run.status === 0) {
      job.status = 'done';
      job.error = null;
    } else {
      job.status = 'failed';
      job.error = (run.stderr || run.stdout || 'unknown error').slice(0, 1000);
    }

    saveState(state);

    results.push({
      id: job.id,
      kind: job.kind,
      status: job.status,
      resultPath,
      error: job.error,
    });

    if (once) break;
  }

  console.log(JSON.stringify({ ok: true, processed: results.length, results }, null, 2));
}

function cmdStatus(rest) {
  const jsonOut = rest.includes('--json');
  const state = loadState();

  const counts = state.jobs.reduce((acc, j) => {
    acc[j.status] = (acc[j.status] || 0) + 1;
    return acc;
  }, {});

  const out = {
    total: state.jobs.length,
    counts,
    latest: state.jobs.slice(-20),
  };

  if (jsonOut) console.log(JSON.stringify(out, null, 2));
  else {
    console.log(`Jobs: ${out.total}`);
    console.log(`pending=${counts.pending || 0} in_progress=${counts.in_progress || 0} done=${counts.done || 0} failed=${counts.failed || 0}`);
    for (const j of out.latest) {
      console.log(`- ${j.id} [${j.status}] ${j.kind} ${j.target}`);
      if (j.error) console.log(`  error: ${j.error.slice(0, 120)}`);
    }
  }
}

function cmdRetry(rest) {
  const [jobId] = rest;
  if (!jobId) {
    console.error('Usage: node queue-runner.mjs retry <jobId>');
    process.exit(1);
  }

  const state = loadState();
  const job = state.jobs.find((j) => j.id === jobId);
  if (!job) {
    console.error(`Job not found: ${jobId}`);
    process.exit(1);
  }

  job.status = 'pending';
  job.error = null;
  job.updatedAt = nowIso();
  saveState(state);
  console.log(JSON.stringify({ ok: true, retried: jobId }, null, 2));
}

function main() {
  const [,, cmd, ...rest] = process.argv;
  if (cmd === 'enqueue') return cmdEnqueue(rest);
  if (cmd === 'run') return cmdRun(rest);
  if (cmd === 'status') return cmdStatus(rest);
  if (cmd === 'retry') return cmdRetry(rest);

  console.log(`
queue-runner.mjs — persistent job queue with resume

Usage:
  node queue-runner.mjs enqueue <kind> <target> [extra args]
  node queue-runner.mjs run [--once] [--max 100] [--timeout-ms 300000]
  node queue-runner.mjs status [--json]
  node queue-runner.mjs retry <jobId>

Kinds:
  fetch | search | map | extract-schema | smart-click | smart-type

Examples:
  node queue-runner.mjs enqueue fetch "https://example.com" --profile x-com
  node queue-runner.mjs enqueue map "https://example.com" --depth 2 --same-domain
  node queue-runner.mjs enqueue extract-schema "https://site" --schema schema.json
  node queue-runner.mjs run --once
  node queue-runner.mjs status
`);
}

main();
