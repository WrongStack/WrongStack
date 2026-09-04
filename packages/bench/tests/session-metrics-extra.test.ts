import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveWstackPaths } from '@wrongstack/core/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readToolMetrics } from '../src/session-metrics.js';

let base: string;
let homeDir: string;
let workdir: string;

const EMPTY = { totalCalls: 0, editCalls: 0, editErrors: 0, rateLimitRetries: 0 };

async function sessionsDir(): Promise<string> {
  return resolveWstackPaths({ projectRoot: workdir, globalRoot: homeDir }).projectSessions;
}

beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'sm-extra-'));
  homeDir = path.join(base, 'home');
  workdir = path.join(base, 'work');
  await fs.mkdir(workdir, { recursive: true });
});
afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

describe('readToolMetrics edge cases', () => {
  it('returns empty metrics when the sessions dir is absent', async () => {
    expect(await readToolMetrics({ homeDir, workdir })).toEqual(EMPTY);
  });

  it('returns empty metrics when the sessions dir has no .jsonl files', async () => {
    const d = await sessionsDir();
    await fs.mkdir(d, { recursive: true });
    await fs.writeFile(path.join(d, 'notes.txt'), 'not a session');
    expect(await readToolMetrics({ homeDir, workdir })).toEqual(EMPTY);
  });

  it('returns empty metrics when the newest .jsonl path is unreadable', async () => {
    const d = await sessionsDir();
    await fs.mkdir(d, { recursive: true });
    // A *directory* named like a session file: newestJsonl picks it, but the
    // subsequent readFile fails (EISDIR) → the catch returns empty.
    await fs.mkdir(path.join(d, 'session.jsonl'), { recursive: true });
    expect(await readToolMetrics({ homeDir, workdir })).toEqual(EMPTY);
  });

  it('counts tool calls, edit errors and retries, tolerating corrupt lines', async () => {
    const d = await sessionsDir();
    await fs.mkdir(d, { recursive: true });
    const lines = [
      JSON.stringify({ type: 'tool_call_end', name: 'read', ok: true }),
      JSON.stringify({ type: 'tool_call_end', name: 'edit', ok: true }),
      JSON.stringify({ type: 'tool_call_end', name: 'write', ok: false }),
      JSON.stringify({ type: 'tool_call_end' }), // no name
      JSON.stringify({ type: 'provider_retry', status: 429 }),
      JSON.stringify({ type: 'provider_error', status: 429 }),
      JSON.stringify({ type: 'something_else' }),
      '{ corrupt line',
      '',
    ].join('\n');
    await fs.writeFile(path.join(d, 'a.jsonl'), lines);
    const m = await readToolMetrics({ homeDir, workdir });
    expect(m).toEqual({ totalCalls: 4, editCalls: 2, editErrors: 1, rateLimitRetries: 2 });
  });

  it('picks the newest of several jsonl files', async () => {
    const d = await sessionsDir();
    await fs.mkdir(d, { recursive: true });
    await fs.writeFile(
      path.join(d, 'old.jsonl'),
      JSON.stringify({ type: 'tool_call_end', name: 'read', ok: true }),
    );
    await new Promise((r) => setTimeout(r, 20));
    await fs.writeFile(
      path.join(d, 'new.jsonl'),
      [
        JSON.stringify({ type: 'tool_call_end', name: 'edit', ok: true }),
        JSON.stringify({ type: 'tool_call_end', name: 'edit', ok: true }),
      ].join('\n'),
    );
    const m = await readToolMetrics({ homeDir, workdir });
    expect(m.totalCalls).toBe(2); // from new.jsonl
    expect(m.editCalls).toBe(2);
  });

  it('reads modern date-sharded session logs', async () => {
    const d = await sessionsDir();
    const shard = path.join(d, '2026-07-06');
    await fs.mkdir(shard, { recursive: true });
    await fs.writeFile(
      path.join(shard, 'sess_01.jsonl'),
      [
        JSON.stringify({ type: 'tool_call_end', name: 'read', ok: true }),
        JSON.stringify({ type: 'tool_call_end', name: 'patch', ok: false }),
        JSON.stringify({ type: 'provider_retry', status: 429 }),
      ].join('\n'),
    );

    const m = await readToolMetrics({ homeDir, workdir });
    expect(m).toEqual({ totalCalls: 2, editCalls: 1, editErrors: 1, rateLimitRetries: 1 });
  });

  it('chooses the newest log across flat and sharded layouts', async () => {
    const d = await sessionsDir();
    await fs.mkdir(d, { recursive: true });
    await fs.writeFile(
      path.join(d, 'legacy.jsonl'),
      JSON.stringify({ type: 'tool_call_end', name: 'read', ok: true }),
    );

    await new Promise((r) => setTimeout(r, 20));
    const shard = path.join(d, '2026-07-06');
    await fs.mkdir(shard, { recursive: true });
    await fs.writeFile(
      path.join(shard, 'sess_02.jsonl'),
      [
        JSON.stringify({ type: 'tool_call_end', name: 'edit', ok: true }),
        JSON.stringify({ type: 'tool_call_end', name: 'edit', ok: true }),
        JSON.stringify({ type: 'provider_error', status: 429 }),
      ].join('\n'),
    );

    const m = await readToolMetrics({ homeDir, workdir });
    expect(m).toEqual({ totalCalls: 2, editCalls: 2, editErrors: 0, rateLimitRetries: 1 });
  });

  it('does not count non-429 provider failures as rate-limit retries', async () => {
    const d = await sessionsDir();
    await fs.mkdir(d, { recursive: true });
    await fs.writeFile(
      path.join(d, 'provider-errors.jsonl'),
      [
        JSON.stringify({ type: 'provider_retry', status: 500 }),
        JSON.stringify({ type: 'provider_error', status: 503 }),
        JSON.stringify({ type: 'provider_error' }),
        JSON.stringify({ type: 'provider_retry', status: 429 }),
      ].join('\n'),
    );

    const m = await readToolMetrics({ homeDir, workdir });
    expect(m.rateLimitRetries).toBe(1);
  });
});
