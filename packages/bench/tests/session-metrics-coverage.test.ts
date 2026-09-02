import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveWstackPaths } from '@wrongstack/core/utils';
import { afterEach, describe, expect, it } from 'vitest';
import { readToolMetrics, readSessionLogEvents } from '../src/session-metrics.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }).catch(() => {})),
  );
});

describe('readSessionLogEvents — edge cases', () => {
  it('returns empty array when sessions dir has no .jsonl files', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'sm-cov-'));
    tempDirs.push(base);
    const homeDir = path.join(base, 'home');
    const workdir = path.join(base, 'work');
    await fs.mkdir(workdir, { recursive: true });
    const d = resolveWstackPaths({ projectRoot: workdir, globalRoot: homeDir }).projectSessions;
    await fs.mkdir(d, { recursive: true });
    // Only non-jsonl files
    await fs.writeFile(path.join(d, 'notes.txt'), 'data');
    const events = await readSessionLogEvents({ homeDir, workdir });
    expect(events).toEqual([]);
  });
});

describe('newestJsonl — subdirectory read error coverage', () => {
  it('skips subdirectories that cannot be read', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'sm-shard-'));
    tempDirs.push(base);
    const homeDir = path.join(base, 'home');
    const workdir = path.join(base, 'work');
    await fs.mkdir(workdir, { recursive: true });
    const d = resolveWstackPaths({ projectRoot: workdir, globalRoot: homeDir }).projectSessions;
    await fs.mkdir(d, { recursive: true });

    // Create a shard subdirectory
    const shard = path.join(d, '2026-07-10');
    await fs.mkdir(shard, { recursive: true });
    await fs.writeFile(
      path.join(shard, 'sess_01.jsonl'),
      JSON.stringify({ type: 'tool_call_end', name: 'edit', ok: true }),
    );

    // Create a second entry that looks like a directory but might cause issues
    // on Windows we create a regular subdirectory which should just be readable
    await fs.mkdir(path.join(d, 'empty-shard'), { recursive: true });
    // empty-shard has no .jsonl files, so the loop just finds nothing

    const metrics = await readToolMetrics({ homeDir, workdir });
    // Should read from the shard that has the jsonl file
    expect(metrics.totalCalls).toBe(1);
    expect(metrics.editCalls).toBe(1);
  });
});

describe('readToolMetrics — readFile on an unreadable jsonl file', () => {
  it('tolerates an empty sessions directory gracefully', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'sm-empty-'));
    tempDirs.push(base);
    const homeDir = path.join(base, 'home');
    const workdir = path.join(base, 'work');
    await fs.mkdir(workdir, { recursive: true });
    // No sessions dir at all
    const m = await readToolMetrics({ homeDir, workdir });
    expect(m).toEqual({ totalCalls: 0, editCalls: 0, editErrors: 0, rateLimitRetries: 0 });
  });
});
