import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionRecovery } from '../../src/storage/session-recovery.js';

let dir: string;
let recovery: SessionRecovery;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-recovery-'));
  recovery = new SessionRecovery(dir);
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function writeLog(sessionId: string, events: unknown[]): Promise<void> {
  const body = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  await fs.writeFile(path.join(dir, `${sessionId}.jsonl`), body, 'utf8');
}

describe('SessionRecovery.detectStale', () => {
  it('returns null when the log does not exist', async () => {
    expect(await recovery.detectStale('missing')).toBeNull();
  });

  it('returns null when the log is empty', async () => {
    await fs.writeFile(path.join(dir, 's1.jsonl'), '', 'utf8');
    expect(await recovery.detectStale('s1')).toBeNull();
  });

  it('returns null when the last event is a clean in_flight_end', async () => {
    await writeLog('s1', [
      { type: 'session_start', ts: '2026-01-01T00:00:00Z', id: 's1', model: 'm', provider: 'p' },
      { type: 'in_flight_start', ts: '2026-01-01T00:00:01Z', context: 'iteration 1' },
      { type: 'in_flight_end', ts: '2026-01-01T00:00:02Z', reason: 'clean' },
    ]);
    expect(await recovery.detectStale('s1')).toBeNull();
  });

  it('flags the session when the last event is in_flight_start (no end)', async () => {
    await writeLog('s2', [
      { type: 'session_start', ts: '2026-01-01T00:00:00Z', id: 's2', model: 'm', provider: 'p' },
      { type: 'checkpoint', ts: '2026-01-01T00:00:01Z', promptIndex: 0, promptPreview: 'hi' },
      { type: 'in_flight_start', ts: '2026-01-01T00:00:02Z', context: 'iteration 5 / tool: read' },
    ]);
    const stale = await recovery.detectStale('s2');
    expect(stale).not.toBeNull();
    expect(stale!.sessionId).toBe('s2');
    expect(stale!.context).toBe('iteration 5 / tool: read');
    expect(stale!.lastEventTs).toBe('2026-01-01T00:00:02Z');
    expect(stale!.eventCount).toBe(3);
  });

  it('flags an open marker even when provider/tool events follow it', async () => {
    await writeLog('s-open-with-tail', [
      { type: 'session_start', ts: '2026-01-01T00:00:00Z', id: 's-open-with-tail', model: 'm', provider: 'p' },
      { type: 'in_flight_start', ts: '2026-01-01T00:00:01Z', context: 'iteration 2' },
      { type: 'llm_response', ts: '2026-01-01T00:00:02Z', content: [{ type: 'text', text: 'partial' }], stopReason: 'tool_use', usage: { input: 1, output: 1 } },
      { type: 'tool_result', ts: '2026-01-01T00:00:03Z', id: 'tu-1', content: 'done', isError: false },
    ]);

    const stale = await recovery.detectStale('s-open-with-tail');
    expect(stale).not.toBeNull();
    expect(stale!.context).toBe('iteration 2');
    expect(stale!.eventCount).toBe(4);
  });

  it('finds an open marker across a tool-result line larger than the old 8KB tail', async () => {
    await writeLog('s-large-tail', [
      { type: 'in_flight_start', ts: '2026-01-01T00:00:00Z', context: 'large result' },
      { type: 'tool_result', ts: '2026-01-01T00:00:01Z', id: 'tu-1', content: 'x'.repeat(80_000), isError: false },
    ]);

    const stale = await recovery.detectStale('s-large-tail');
    expect(stale).not.toBeNull();
    expect(stale!.context).toBe('large result');
    expect(stale!.eventCount).toBe(2);
  });

  it('treats a later clean boundary as authoritative after ordinary events', async () => {
    await writeLog('s-clean-tail', [
      { type: 'in_flight_start', ts: '2026-01-01T00:00:00Z', context: 'iteration 1' },
      { type: 'tool_result', ts: '2026-01-01T00:00:01Z', id: 'tu-1', content: 'done', isError: false },
      { type: 'in_flight_end', ts: '2026-01-01T00:00:02Z', reason: 'clean' },
      { type: 'session_end', ts: '2026-01-01T00:00:03Z', usage: { input: 1, output: 1 } },
    ]);

    expect(await recovery.detectStale('s-clean-tail')).toBeNull();
  });

  it('returns null when the last event is neither in_flight_start nor in_flight_end', async () => {
    // Legacy / pre-marker log: a session that was never annotated.
    await writeLog('s3', [
      { type: 'session_start', ts: '2026-01-01T00:00:00Z', id: 's3', model: 'm', provider: 'p' },
      { type: 'user_input', ts: '2026-01-01T00:00:01Z', text: 'hi' },
    ]);
    expect(await recovery.detectStale('s3')).toBeNull();
  });

  it('treats aborted as a clean shutdown', async () => {
    await writeLog('s4', [
      { type: 'in_flight_start', ts: '2026-01-01T00:00:00Z', context: 'x' },
      { type: 'in_flight_end', ts: '2026-01-01T00:00:01Z', reason: 'aborted' },
    ]);
    expect(await recovery.detectStale('s4')).toBeNull();
  });

  it('skips corrupt JSON lines without crashing', async () => {
    await fs.writeFile(
      path.join(dir, 's5.jsonl'),
      [
        JSON.stringify({ type: 'in_flight_start', ts: '2026-01-01T00:00:00Z', context: 'y' }),
        '{not json',
        '',
      ].join('\n'),
      'utf8',
    );
    const stale = await recovery.detectStale('s5');
    expect(stale).not.toBeNull();
    expect(stale!.context).toBe('y');
  });

  it('rejects path-traversal session ids but accepts date-shard slashes', async () => {
    await expect(recovery.detectStale('../escape')).rejects.toThrow(/invalid sessionid/i);
    await expect(recovery.detectStale('a/../../escape')).rejects.toThrow(/invalid sessionid/i);
    await expect(recovery.detectStale('a\\b')).rejects.toThrow(/invalid sessionid/i);
    // Modern ids are date-sharded ("2026-06-11/<base>") — a forward slash
    // that resolves INSIDE the sessions dir is legitimate, not traversal.
    // No file exists for this id, so the probe resolves null instead of
    // throwing.
    await expect(recovery.detectStale('2026-06-11/no-such')).resolves.toBeNull();
  });
});

describe('SessionRecovery.listResumable', () => {
  it('returns an empty array when the dir does not exist', async () => {
    const empty = await recovery.listResumable();
    expect(empty).toEqual([]);
  });

  it('returns only sessions with stale in-flight markers', async () => {
    // s-clean: clean shutdown — not resumable
    await writeLog('s-clean', [
      { type: 'in_flight_start', ts: '2026-01-01T00:00:00Z', context: 'a' },
      { type: 'in_flight_end', ts: '2026-01-01T00:00:01Z', reason: 'clean' },
    ]);
    // s-stale-1: stale, older
    await writeLog('s-stale-1', [
      { type: 'in_flight_start', ts: '2026-01-01T00:00:00Z', context: 'old crash' },
    ]);
    // s-stale-2: stale, newer
    await writeLog('s-stale-2', [
      { type: 'in_flight_start', ts: '2026-01-02T00:00:00Z', context: 'recent crash' },
    ]);
    // s-legacy: no markers
    await writeLog('s-legacy', [
      { type: 'session_start', ts: '2026-01-01T00:00:00Z', id: 's-legacy', model: 'm', provider: 'p' },
    ]);
    const resumable = await recovery.listResumable();
    expect(resumable.map((s) => s.sessionId).sort()).toEqual(['s-stale-1', 's-stale-2']);
    // Sorted by lastEventTs descending — newer crash first.
    expect(resumable[0]!.sessionId).toBe('s-stale-2');
  });

  it('skips sidecar files (annotations / replay logs)', async () => {
    await writeLog('s-stale', [
      { type: 'in_flight_start', ts: '2026-01-01T00:00:00Z', context: 'x' },
    ]);
    // These are NOT session logs; the recovery scanner should ignore them.
    await fs.writeFile(path.join(dir, 's-stale.annotations.json'), '{}', 'utf8');
    await fs.writeFile(path.join(dir, 's-stale.replay.jsonl'), '', 'utf8');
    const resumable = await recovery.listResumable();
    expect(resumable).toHaveLength(1);
    expect(resumable[0]!.sessionId).toBe('s-stale');
  });

  it('handles a dir with many sessions efficiently', async () => {
    // 50 stale + 50 clean. Spot-check that we get exactly 50.
    for (let i = 0; i < 50; i++) {
      await writeLog(`s-stale-${i}`, [
        { type: 'in_flight_start', ts: '2026-01-01T00:00:00Z', context: `${i}` },
      ]);
      await writeLog(`s-clean-${i}`, [
        { type: 'in_flight_start', ts: '2026-01-01T00:00:00Z', context: `${i}` },
        { type: 'in_flight_end', ts: '2026-01-01T00:00:01Z', reason: 'clean' },
      ]);
    }
    const resumable = await recovery.listResumable();
    expect(resumable).toHaveLength(50);
    expect(resumable.every((s) => s.sessionId.startsWith('s-stale-'))).toBe(true);
  });
});

// ── SessionRecovery.recover ───────────────────────────────────────────────

describe('SessionRecovery.recover', () => {
  it('returns null when the log does not exist', async () => {
    expect(await recovery.recover('missing')).toBeNull();
  });

  it('returns null when the log is empty', async () => {
    await fs.writeFile(path.join(dir, 's1.jsonl'), '', 'utf8');
    expect(await recovery.recover('s1')).toBeNull();
  });

  it('returns a plan with no checkpoint and all events as pending (legacy log)', async () => {
    await writeLog('s1', [
      { type: 'session_start', ts: '2026-01-01T00:00:00Z', id: 's1', model: 'm', provider: 'p' },
      { type: 'user_input', ts: '2026-01-01T00:00:01Z', text: 'hi' },
      { type: 'in_flight_end', ts: '2026-01-01T00:00:02Z', reason: 'clean' },
    ]);
    const plan = await recovery.recover('s1');
    expect(plan).not.toBeNull();
    expect(plan!.stale).toBe(false);
    expect(plan!.lastCheckpoint).toBeNull();
    expect(plan!.pendingEvents).toHaveLength(3);
    expect(plan!.context).toBeNull();
  });

  it('returns a plan with the last checkpoint and events after it', async () => {
    await writeLog('s2', [
      { type: 'session_start', ts: '2026-01-01T00:00:00Z', id: 's2', model: 'm', provider: 'p' },
      { type: 'user_input', ts: '2026-01-01T00:00:01Z', text: 'first' },
      { type: 'checkpoint', ts: '2026-01-01T00:00:02Z', promptIndex: 0, promptPreview: 'first' },
      { type: 'user_input', ts: '2026-01-01T00:00:03Z', text: 'second' },
      { type: 'llm_response', ts: '2026-01-01T00:00:04Z', content: [], stopReason: 'end_turn', usage: { input: 10, output: 5 } },
    ]);
    const plan = await recovery.recover('s2');
    expect(plan).not.toBeNull();
    expect(plan!.stale).toBe(false);
    expect(plan!.lastCheckpoint).not.toBeNull();
    expect(plan!.pendingEvents).toHaveLength(2);
    expect(plan!.pendingEvents[0]!.type).toBe('user_input');
    expect(plan!.pendingEvents[1]!.type).toBe('llm_response');
    expect(plan!.context).toBeNull();
  });

  it('marks the plan as stale when the last event is in_flight_start', async () => {
    await writeLog('s3', [
      { type: 'session_start', ts: '2026-01-01T00:00:00Z', id: 's3', model: 'm', provider: 'p' },
      { type: 'checkpoint', ts: '2026-01-01T00:00:01Z', promptIndex: 0, promptPreview: 'x' },
      { type: 'in_flight_start', ts: '2026-01-01T00:00:02Z', context: 'iteration 5 / tool: bash' },
    ]);
    const plan = await recovery.recover('s3');
    expect(plan).not.toBeNull();
    expect(plan!.stale).toBe(true);
    expect(plan!.context).toBe('iteration 5 / tool: bash');
    expect(plan!.inFlightStart).not.toBeNull();
    // Pending = events after the checkpoint, including the marker.
    expect(plan!.pendingEvents).toHaveLength(1);
    expect(plan!.pendingEvents[0]!.type).toBe('in_flight_start');
  });

  it('marks the plan stale when ordinary events follow the open marker', async () => {
    await writeLog('s3-tail', [
      { type: 'checkpoint', ts: '2026-01-01T00:00:00Z', promptIndex: 0, promptPreview: 'x' },
      { type: 'in_flight_start', ts: '2026-01-01T00:00:01Z', context: 'iteration 6' },
      { type: 'llm_response', ts: '2026-01-01T00:00:02Z', content: [], stopReason: 'tool_use', usage: { input: 1, output: 1 } },
      { type: 'tool_result', ts: '2026-01-01T00:00:03Z', id: 'tu-1', content: 'done', isError: false },
    ]);

    const plan = await recovery.recover('s3-tail');
    expect(plan).not.toBeNull();
    expect(plan!.stale).toBe(true);
    expect(plan!.context).toBe('iteration 6');
    expect(plan!.pendingEvents).toHaveLength(3);
  });

  it('uses the LAST checkpoint, not the first one', async () => {
    await writeLog('s4', [
      { type: 'checkpoint', ts: '2026-01-01T00:00:00Z', promptIndex: 0, promptPreview: 'old' },
      { type: 'checkpoint', ts: '2026-01-01T00:00:01Z', promptIndex: 1, promptPreview: 'middle' },
      { type: 'checkpoint', ts: '2026-01-01T00:00:02Z', promptIndex: 2, promptPreview: 'newest' },
      { type: 'user_input', ts: '2026-01-01T00:00:03Z', text: 'x' },
    ]);
    const plan = await recovery.recover('s4');
    expect(plan).not.toBeNull();
    expect(plan!.lastCheckpoint).not.toBeNull();
    const cp = plan!.lastCheckpoint as { type: string; promptIndex: number; promptPreview: string };
    expect(cp.promptIndex).toBe(2);
    expect(cp.promptPreview).toBe('newest');
    expect(plan!.pendingEvents).toHaveLength(1);
  });

  it('skips corrupt JSON lines without crashing', async () => {
    await fs.writeFile(
      path.join(dir, 's5.jsonl'),
      [
        JSON.stringify({ type: 'session_start', ts: '2026-01-01T00:00:00Z', id: 's5', model: 'm', provider: 'p' }),
        JSON.stringify({ type: 'checkpoint', ts: '2026-01-01T00:00:01Z', promptIndex: 0, promptPreview: 'x' }),
        '{not json',
        JSON.stringify({ type: 'in_flight_start', ts: '2026-01-01T00:00:02Z', context: 'crash' }),
      ].join('\n'),
      'utf8',
    );
    const plan = await recovery.recover('s5');
    expect(plan).not.toBeNull();
    expect(plan!.stale).toBe(true);
  });

  it('skips non-object events parsed from JSON (numbers, null, strings)', async () => {
    await fs.writeFile(
      path.join(dir, 's-nonobj.jsonl'),
      [
        JSON.stringify({ type: 'checkpoint', ts: '2026-01-01T00:00:00Z', promptIndex: 0, promptPreview: 'x' }),
        '42',
        'null',
        '"a plain string"',
      ].join('\n') + '\n',
      'utf8',
    );
    const plan = await recovery.recover('s-nonobj');
    expect(plan).not.toBeNull();
    expect(plan!.pendingEvents).toHaveLength(0);
  });

  it('skips oversized events that exceed MAX_PENDING_BYTES', async () => {
    const big = 'x'.repeat(17 * 1024 * 1024);
    await writeLog('s-oversized', [
      { type: 'checkpoint', ts: '2026-01-01T00:00:00Z', promptIndex: 0, promptPreview: 'x' },
      { type: 'user_input', ts: '2026-01-01T00:00:01Z', text: big },
      { type: 'in_flight_start', ts: '2026-01-01T00:00:02Z', context: 'after big' },
    ]);
    const plan = await recovery.recover('s-oversized');
    expect(plan).not.toBeNull();
    expect(plan!.pendingEvents).toHaveLength(1);
  });

  it('evicts oldest post-checkpoint events when the log exceeds MAX_PENDING_EVENTS', async () => {
    const events: unknown[] = [
      { type: 'checkpoint', ts: '2026-01-01T00:00:00Z', promptIndex: 0, promptPreview: 'x' },
    ];
    for (let i = 0; i < 10_002; i++) {
      events.push({ type: 'user_input', ts: '2026-01-01T00:00:01Z', text: `ev${i}` });
    }
    await writeLog('s-evict', events);
    const plan = await recovery.recover('s-evict');
    expect(plan).not.toBeNull();
    expect(plan!.pendingEvents.length).toBeLessThanOrEqual(10_000);
  });
});

describe('SessionRecovery.recover — session id resolution', () => {
  it('throws when the session id is ambiguous (multiple matches with the same leaf)', async () => {
    await fs.mkdir(path.join(dir, '2026-01-01'), { recursive: true });
    await fs.mkdir(path.join(dir, '2026-02-02'), { recursive: true });
    await writeLog('2026-01-01/amb', [
      { type: 'in_flight_start', ts: '2026-01-01T00:00:00Z', context: 'a' },
    ]);
    await writeLog('2026-02-02/amb', [
      { type: 'in_flight_start', ts: '2026-01-01T00:00:00Z', context: 'b' },
    ]);
    await expect(recovery.recover('amb')).rejects.toThrow(/Ambiguous/i);
  });

  it('throws when detectStale is called with an ambiguous id', async () => {
    await fs.mkdir(path.join(dir, '2026-01-01'), { recursive: true });
    await fs.mkdir(path.join(dir, '2026-02-02'), { recursive: true });
    await writeLog('2026-01-01/amb2', [
      { type: 'in_flight_start', ts: '2026-01-01T00:00:00Z', context: 'a' },
    ]);
    await writeLog('2026-02-02/amb2', [
      { type: 'in_flight_start', ts: '2026-01-01T00:00:00Z', context: 'b' },
    ]);
    await expect(recovery.detectStale('amb2')).rejects.toThrow(/Ambiguous/i);
  });
});

describe('SessionRecovery.detectStale — whitespace handling', () => {
  it('treats whitespace-only lines as non-events during reverse scan', async () => {
    await fs.writeFile(
      path.join(dir, 's-ws.jsonl'),
      JSON.stringify({ type: 'in_flight_start', ts: '2026-01-01T00:00:00Z', context: 'ws' }) + '\n   \n',
      'utf8',
    );
    const stale = await recovery.detectStale('s-ws');
    expect(stale).not.toBeNull();
    expect(stale!.context).toBe('ws');
  });
});
