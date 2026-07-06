import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveWstackPaths } from '@wrongstack/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readToolMetrics } from '../src/session-metrics.js';

let homeDir: string;
let workdir: string;

beforeAll(async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'bench-metrics-'));
  homeDir = path.join(base, 'home');
  workdir = path.join(base, 'work');
  await fs.mkdir(workdir, { recursive: true });

  // Write a session JSONL where the subprocess would have written it:
  // <home>/projects/<slug>/sessions/<id>.jsonl
  const sessionsDir = resolveWstackPaths({
    projectRoot: workdir,
    globalRoot: homeDir,
  }).projectSessions;
  await fs.mkdir(sessionsDir, { recursive: true });
  const events = [
    { type: 'session_start' },
    { type: 'tool_call_end', name: 'read', id: '1', ok: true },
    { type: 'tool_call_end', name: 'edit', id: '2', ok: true },
    { type: 'tool_call_end', name: 'edit', id: '3', ok: false },
    { type: 'tool_call_end', name: 'write', id: '4', ok: true },
    { type: 'provider_retry', attempt: 1, status: 429 },
    { type: 'provider_error', status: 429 },
    'this is not json', // tolerated
  ];
  const jsonl = events.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n');
  await fs.writeFile(path.join(sessionsDir, '01ABC.jsonl'), jsonl + '\n', 'utf8');
});

afterAll(async () => {
  await fs.rm(path.dirname(homeDir), { recursive: true, force: true });
});

describe('readToolMetrics', () => {
  it('counts tool calls, edit errors, and rate-limit retries from the JSONL', async () => {
    const m = await readToolMetrics({ homeDir, workdir });
    expect(m.totalCalls).toBe(4); // 4 tool_call_end events
    expect(m.editCalls).toBe(3); // edit, edit, write
    expect(m.editErrors).toBe(1); // one edit with ok:false
    expect(m.rateLimitRetries).toBe(2); // provider_retry + provider_error
  });

  it('returns zeroed metrics when no session log exists', async () => {
    const emptyBase = await fs.mkdtemp(path.join(os.tmpdir(), 'bench-metrics-empty-'));
    const m = await readToolMetrics({
      homeDir: path.join(emptyBase, 'home'),
      workdir: path.join(emptyBase, 'work'),
    });
    expect(m).toEqual({ totalCalls: 0, editCalls: 0, editErrors: 0, rateLimitRetries: 0 });
    await fs.rm(emptyBase, { recursive: true, force: true });
  });
});
