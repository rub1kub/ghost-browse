#!/usr/bin/env node
import { mkdirSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const TRACE_DIR = join(__dir, 'traces');

function nowIso() {
  return new Date().toISOString();
}

function randId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createTrace({ enabled = false, sessionId = null, command = null, meta = {} } = {}) {
  if (!enabled) {
    return {
      enabled: false,
      sessionId: null,
      filePath: null,
      event() {},
      finish() {},
    };
  }

  mkdirSync(TRACE_DIR, { recursive: true });
  const id = sessionId || `${command || 'session'}-${randId()}`;
  const filePath = join(TRACE_DIR, `${id}.jsonl`);

  const write = (obj) => appendFileSync(filePath, `${JSON.stringify(obj)}\n`);

  write({
    ts: nowIso(),
    type: 'session.start',
    sessionId: id,
    command,
    meta,
  });

  return {
    enabled: true,
    sessionId: id,
    filePath,
    event(type, payload = {}) {
      write({ ts: nowIso(), type, sessionId: id, ...payload });
    },
    finish(summary = {}) {
      write({ ts: nowIso(), type: 'session.finish', sessionId: id, ...summary });
    },
  };
}

export default { createTrace };
