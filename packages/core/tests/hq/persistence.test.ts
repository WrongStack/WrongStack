import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createHqPersistence,
  HqEventLog,
  HqSnapshotStore,
  HqTimeseriesStore,
} from '../../src/hq/persistence.js';
import {
  HQ_EVENT_LOG_PRESETS,
  hqEventLogPresetFields,
  type HqEventLogPreset,
} from '../../src/hq/persistence/event-log.js';
import type { HqEventEnvelope, HqSnapshot } from '../../src/hq/protocol.js';

let dataDir: string;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-persist-'));
});

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

function makeEvent(seq: number, type = 'session.usage'): HqEventEnvelope {
  return {
    id: `evt-${seq}`,
    type,
    schemaVersion: 1,
    timestamp: new Date().toISOString(),
    clientId: 'c1',
    projectId: 'p1',
    seq,
    payload: { costUsd: 0.01 * seq },
  };
}

describe('HqEventLog', () => {
  it('appends events and reads them back newest-first', async () => {
    const log = new HqEventLog({ dataDir });
    log.append(makeEvent(1));
    log.append(makeEvent(2));
    log.append(makeEvent(3));
    await log.drain();
    const recent = await log.recent(10);
    expect(recent).toHaveLength(3);
    expect(recent[0]!.seq).toBe(3); // newest first
    expect(recent[2]!.seq).toBe(1);
  });

  it('drain waits for a batch queued while an earlier batch is starting', async () => {
    const log = new HqEventLog({ dataDir });
    log.append(makeEvent(1));
    await Promise.resolve();
    log.append(makeEvent(2));
    await log.drain();
    expect((await log.recent(10)).map((event) => event.seq)).toEqual([2, 1]);
  });

  it('filters by event type', async () => {
    const log = new HqEventLog({ dataDir });
    log.append(makeEvent(1, 'session.usage'));
    log.append(makeEvent(2, 'brain.event'));
    log.append(makeEvent(3, 'session.usage'));
    await log.drain();
    const usage = await log.recent(10, 'session.usage');
    expect(usage).toHaveLength(2);
    expect(usage.every((e) => e.type === 'session.usage')).toBe(true);
  });

  it('reads long UTF-8 lines across tail blocks and skips malformed records', async () => {
    const log = new HqEventLog({ dataDir });
    log.append(makeEvent(1));
    log.append({
      ...makeEvent(2),
      payload: { text: `${'x'.repeat(70_000)}🧪` },
    });
    log.append(makeEvent(3));
    await log.drain();
    await fs.appendFile(path.join(dataDir, 'events.jsonl'), '{malformed\n', 'utf8');

    const recent = await log.recent(3);

    expect(recent.map((event) => event.seq)).toEqual([3, 2, 1]);
    expect((recent[1]!.payload as { text: string }).text.endsWith('🧪')).toBe(true);
  });

  it('rotates when exceeding maxLines', async () => {
    const log = new HqEventLog({ dataDir, maxLines: 5, rotateKeep: 2 });
    // Append exactly maxLines events — rotation fires on the last append.
    for (let i = 1; i <= 5; i++) log.append(makeEvent(i));
    await log.drain();
    const recent = await log.recent(10);
    // After rotation only the last rotateKeep (2) are retained.
    expect(recent.length).toBeLessThanOrEqual(2);
    expect(recent[0]!.seq).toBe(5);
  });

  it('preserves long UTF-8 records while compacting the tail', async () => {
    const log = new HqEventLog({ dataDir, maxLines: 3, rotateKeep: 2 });
    log.append(makeEvent(1));
    log.append({ ...makeEvent(2), payload: { text: `${'x'.repeat(70_000)}🧪` } });
    log.append(makeEvent(3));
    await log.drain();

    const recent = await log.recent(10);

    expect(recent.map((event) => event.seq)).toEqual([3, 2]);
    expect((recent[1]!.payload as { text: string }).text.endsWith('🧪')).toBe(true);
  });

  it('hydrate seeds the line count from disk', async () => {
    const log = new HqEventLog({ dataDir });
    log.append(makeEvent(1));
    log.append(makeEvent(2));
    await log.drain();
    const log2 = new HqEventLog({ dataDir });
    await log2.hydrate();
    const recent = await log2.recent(10);
    expect(recent).toHaveLength(2);
  });

  it('never rejects — a failed append resolves the chain', async () => {
    // Point at a path inside a file (not a dir) to force append failure.
    const blocker = path.join(dataDir, 'blocker');
    await fs.writeFile(blocker, 'x');
    const log = new HqEventLog({ dataDir: blocker });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      log.append(makeEvent(1));
      log.append(makeEvent(2)); // must not throw synchronously
      await log.drain();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('HqSnapshotStore', () => {
  it('saves and loads a snapshot', async () => {
    const store = new HqSnapshotStore({ dataDir });
    const snap = {
      generatedAt: '2026-07-02T00:00:00Z',
      clients: [],
      projects: [],
      sessions: [],
      fleets: [],
      mailboxes: [],
      totals: { activeProjects: 0, activeClients: 0, activeSessions: 0, activeSubagents: 0, unreadMailboxMessages: 0, incompleteMailboxMessages: 0, totalCostUsd: 0 },
    } as HqSnapshot;
    store.save(snap);
    await store.drain();
    const loaded = await store.load();
    expect(loaded).not.toBeNull();
    expect(loaded!.generatedAt).toBe('2026-07-02T00:00:00Z');
  });

  it('load returns null when no snapshot exists', async () => {
    const store = new HqSnapshotStore({ dataDir });
    expect(await store.load()).toBeNull();
  });
});

describe('HqTimeseriesStore', () => {
  it('records signals into time buckets', async () => {
    const store = new HqTimeseriesStore({ dataDir, bucketMs: 1000 });
    const now = 10_000;
    store.record({ ts: now, costUsd: 0.01, inputTokens: 100 });
    store.record({ ts: now + 100, costUsd: 0.02, outputTokens: 50 });
    store.record({ ts: now + 2000, costUsd: 0.05, toolCalls: 3 });
    const samples = await store.read();
    expect(samples).toHaveLength(2); // two distinct buckets
    const first = samples.find((s) => s.ts === Math.floor(now / 1000) * 1000);
    expect(first!.costUsd).toBeCloseTo(0.03, 5);
    expect(first!.inputTokens).toBe(100);
    expect(first!.outputTokens).toBe(50);
    const second = samples.find((s) => s.ts === Math.floor((now + 2000) / 1000) * 1000);
    expect(second!.toolCalls).toBe(3);
  });

  it('flush persists and load rehydrates', async () => {
    const store = new HqTimeseriesStore({ dataDir, bucketMs: 1000 });
    store.record({ ts: 10_000, costUsd: 0.5 });
    store.record({ ts: 11_000, costUsd: 0.3 });
    store.flush();
    await store.drain();
    const store2 = new HqTimeseriesStore({ dataDir, bucketMs: 1000 });
    await store2.load();
    const samples = await store2.read();
    expect(samples.length).toBeGreaterThanOrEqual(2);
  });

  it('flushes only buckets changed since the previous successful write', async () => {
    const store = new HqTimeseriesStore({ dataDir, bucketMs: 1000 });
    const file = path.join(dataDir, 'timeseries.jsonl');
    store.record({ ts: 10_000, costUsd: 1 });
    store.flush();
    await store.drain();
    store.flush();
    await store.drain();
    expect((await fs.readFile(file, 'utf8')).trim().split('\n')).toHaveLength(1);

    store.record({ ts: 10_100, costUsd: 2 });
    store.flush();
    await store.drain();
    expect((await fs.readFile(file, 'utf8')).trim().split('\n')).toHaveLength(2);
  });

  it('compacts persisted bucket revisions to a bounded log', async () => {
    const store = new HqTimeseriesStore({ dataDir, bucketMs: 1000, maxBuckets: 2 });
    const file = path.join(dataDir, 'timeseries.jsonl');
    for (let index = 0; index < 9; index++) {
      store.record({ ts: (index % 2) * 1000, costUsd: 1 });
      store.flush();
      await store.drain();
    }

    expect((await fs.readFile(file, 'utf8')).trim().split('\n').length).toBeLessThanOrEqual(3);
    const reloaded = new HqTimeseriesStore({ dataDir, bucketMs: 1000, maxBuckets: 2 });
    await reloaded.load();
    expect((await reloaded.read()).map((sample) => sample.costUsd)).toEqual([5, 4]);
  });

  it('prunes to maxBuckets on record', async () => {
    const store = new HqTimeseriesStore({ dataDir, bucketMs: 1, maxBuckets: 3 });
    for (let i = 0; i < 10; i++) store.record({ ts: i * 10, costUsd: 0.01 });
    // record() prunes in-memory as it goes, so the map never exceeds maxBuckets.
    expect((store as unknown as { buckets: Map<number, unknown> }).buckets.size).toBeLessThanOrEqual(3);
  });
});

describe('createHqPersistence facade', () => {
  it('wires all three stores to the same dataDir', () => {
    const p = createHqPersistence(dataDir);
    expect(p.eventLog).toBeInstanceOf(HqEventLog);
    expect(p.snapshotStore).toBeInstanceOf(HqSnapshotStore);
    expect(p.timeseries).toBeInstanceOf(HqTimeseriesStore);
  });
});

// ── D1 — HQ hardening: log-cap default lowered per HQ Evolution §10.3 ────

describe('HqEventLog byte cap (D1)', () => {
  it('defaults maxBytes to 32 MB and rotateKeepBytes to 16 MB', () => {
    const log = new HqEventLog({ dataDir });
    const opts = log as unknown as {
      maxBytes: number;
      rotateKeepBytes: number;
    };
    expect(opts.maxBytes).toBe(32 * 1024 * 1024);
    expect(opts.rotateKeepBytes).toBe(16 * 1024 * 1024);
  });

  it('still allows an explicit override for VPS-deployed instances', () => {
    const log = new HqEventLog({
      dataDir,
      maxBytes: 8 * 1024 * 1024,
      rotateKeepBytes: 2 * 1024 * 1024,
    });
    const opts = log as unknown as {
      maxBytes: number;
      rotateKeepBytes: number;
    };
    expect(opts.maxBytes).toBe(8 * 1024 * 1024);
    expect(opts.rotateKeepBytes).toBe(2 * 1024 * 1024);
  });
});

describe('HqEventLog presets (D1 follow-up)', () => {
  it('exposes vps8 / vps32 / desktop presets', () => {
    expect(HQ_EVENT_LOG_PRESETS.vps8).toEqual({ maxBytes: 8 * 1024 * 1024, rotateKeepBytes: 2 * 1024 * 1024 });
    expect(HQ_EVENT_LOG_PRESETS.vps32).toEqual({ maxBytes: 32 * 1024 * 1024, rotateKeepBytes: 16 * 1024 * 1024 });
    expect(HQ_EVENT_LOG_PRESETS.desktop).toEqual({ maxBytes: 64 * 1024 * 1024, rotateKeepBytes: 24 * 1024 * 1024 });
  });

  it('hqEventLogPresetFields returns the same numbers the preset declares', () => {
    expect(hqEventLogPresetFields('vps8').maxBytes).toBe(8 * 1024 * 1024);
    expect(hqEventLogPresetFields('vps32').rotateKeepBytes).toBe(16 * 1024 * 1024);
    expect(hqEventLogPresetFields('desktop').maxBytes).toBe(64 * 1024 * 1024);
  });

  it('throws on unknown preset names so the call site fails loudly', () => {
    expect(() =>
      hqEventLogPresetFields('vps128' as unknown as HqEventLogPreset),
    ).toThrow(/Unknown HqEventLogPreset/);
  });

  it('a HqEventLog built with a preset matches the preset numbers', () => {
    const fields = hqEventLogPresetFields('vps8');
    const log = new HqEventLog({
      dataDir,
      maxBytes: fields.maxBytes,
      rotateKeepBytes: fields.rotateKeepBytes,
    });
    const opts = log as unknown as {
      maxBytes: number;
      rotateKeepBytes: number;
    };
    expect(opts.maxBytes).toBe(8 * 1024 * 1024);
    expect(opts.rotateKeepBytes).toBe(2 * 1024 * 1024);
  });
});
