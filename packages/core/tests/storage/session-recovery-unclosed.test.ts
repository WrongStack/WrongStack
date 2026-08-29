import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionRecovery } from '../../src/storage/session-recovery.js';

/**
 * "Recovery" as a user means it: which conversations did a crash leave hanging?
 *
 * `listResumable` answers a narrower question — did a process die *inside* an
 * iteration — and that made the ordinary crash invisible. A host killed while
 * the agent was waiting for the next prompt has already closed its last turn
 * with `in_flight_end`; it then simply stops writing, and no `session_end`
 * ever lands. `listUnclosed` is the question that matches the symptom: is there
 * a trailing `session_end` or not.
 */

let dir: string;
let recovery: SessionRecovery;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-unclosed-'));
  recovery = new SessionRecovery(dir);
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function writeLog(sessionId: string, events: unknown[], mtimeMs?: number): Promise<void> {
  const file = path.join(dir, `${sessionId}.jsonl`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${events.map((e) => JSON.stringify(e)).join('\n')}\n`, 'utf8');
  if (mtimeMs !== undefined) await fs.utimes(file, mtimeMs / 1000, mtimeMs / 1000);
}

const started = (id: string) => ({
  type: 'session_start',
  ts: '2026-01-01T00:00:00Z',
  id,
  model: 'm',
  provider: 'p',
});

describe('SessionRecovery.listUnclosed', () => {
  it('ignores a session that wrote its session_end', async () => {
    await writeLog('clean', [
      started('clean'),
      { type: 'in_flight_start', ts: '2026-01-01T00:00:01Z', context: 'iteration 1' },
      { type: 'in_flight_end', ts: '2026-01-01T00:00:02Z', reason: 'clean' },
      { type: 'session_end', ts: '2026-01-01T00:00:03Z' },
    ]);
    expect(await recovery.listUnclosed()).toEqual([]);
  });

  it('reports a session killed BETWEEN turns — the case listResumable cannot see', async () => {
    await writeLog('idle-kill', [
      started('idle-kill'),
      { type: 'in_flight_start', ts: '2026-01-01T00:00:01Z', context: 'iteration 1' },
      { type: 'in_flight_end', ts: '2026-01-01T00:00:02Z', reason: 'clean' },
    ]);

    // The old question says everything ended cleanly...
    expect(await recovery.listResumable()).toEqual([]);
    // ...while the log plainly has no end.
    const unclosed = await recovery.listUnclosed();
    expect(unclosed).toHaveLength(1);
    expect(unclosed[0]).toMatchObject({
      sessionId: 'idle-kill',
      lastBoundary: 'in_flight_end',
      stale: false,
      lastEventTs: '2026-01-01T00:00:02Z',
    });
  });

  it('reports a session killed mid-iteration and marks it stale', async () => {
    await writeLog('mid-kill', [
      started('mid-kill'),
      { type: 'in_flight_start', ts: '2026-01-01T00:00:05Z', context: 'iteration 5 / tool: read' },
    ]);
    const unclosed = await recovery.listUnclosed();
    expect(unclosed).toHaveLength(1);
    expect(unclosed[0]).toMatchObject({ sessionId: 'mid-kill', stale: true });
  });

  it('reports a journal that never reached a lifecycle boundary, dated by its file', async () => {
    await writeLog('no-boundary', [started('no-boundary')], Date.UTC(2026, 0, 2, 3, 4, 5));
    const unclosed = await recovery.listUnclosed();
    expect(unclosed).toHaveLength(1);
    expect(unclosed[0]).toMatchObject({ sessionId: 'no-boundary', lastBoundary: null });
    // No boundary means no timestamp of its own; the file's mtime is the only
    // key such a candidate has, and it has to be a real one for the ordering
    // below to work.
    expect(unclosed[0]!.lastEventTs).toBe(new Date(Date.UTC(2026, 0, 2, 3, 4, 5)).toISOString());
  });

  it('skips an empty file', async () => {
    await fs.writeFile(path.join(dir, 'empty.jsonl'), '', 'utf8');
    expect(await recovery.listUnclosed()).toEqual([]);
  });

  it('finds sessions inside date shards, not just the root', async () => {
    await fs.mkdir(path.join(dir, '2026-01-01'), { recursive: true });
    await writeLog('2026-01-01/sess_sharded', [
      started('2026-01-01/sess_sharded'),
      { type: 'in_flight_end', ts: '2026-01-01T00:00:02Z', reason: 'clean' },
    ]);
    const unclosed = await recovery.listUnclosed();
    // Every modern session lives one shard down; a root-only scan reports a
    // project full of crashes as clean.
    expect(unclosed.map((s) => s.sessionId)).toEqual(['2026-01-01/sess_sharded']);
  });

  it('returns newest file first and honours the limit', async () => {
    const unfinished = (id: string) => [
      started(id),
      { type: 'in_flight_end', ts: '2026-01-01T00:00:02Z', reason: 'clean' },
    ];
    await writeLog('old', unfinished('old'), Date.UTC(2026, 0, 1));
    await writeLog('middle', unfinished('middle'), Date.UTC(2026, 0, 2));
    await writeLog('newest', unfinished('newest'), Date.UTC(2026, 0, 3));

    expect((await recovery.listUnclosed()).map((s) => s.sessionId)).toEqual([
      'newest',
      'middle',
      'old',
    ]);
    // The limit exists so "give me the last one" is two tail reads, not a scan
    // of every transcript the project ever wrote — so it must cut from the
    // OLD end, which only holds if the ordering above is applied first.
    expect((await recovery.listUnclosed({ limit: 1 })).map((s) => s.sessionId)).toEqual(['newest']);
    expect(await recovery.listUnclosed({ limit: 0 })).toEqual([]);
  });
});
