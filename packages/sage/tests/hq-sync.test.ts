import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadRuntimeDatabaseSync as loadTestDatabaseSync } from '@wrongstack/persistence';

const DatabaseSync = loadTestDatabaseSync();
type DatabaseSync = InstanceType<typeof DatabaseSync>;

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chunkHqSageRecords, isHqSageSnapshotPayload } from '../../core/src/hq/protocol/sage.js';
import { HqSageStore } from '../../core/src/hq/sage-store.js';
import { SqliteSageStore } from '../src/sqlite-store.js';

let root: string;
let a: SqliteSageStore;
let b: SqliteSageStore;
let hq: HqSageStore;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'sage-hq-'));
  a = new SqliteSageStore({ projectRoot: path.join(root, 'a') });
  b = new SqliteSageStore({ projectRoot: path.join(root, 'b') });
  hq = new HqSageStore(path.join(root, 'hq'));
});
afterEach(async () => {
  await Promise.all([a.drainMutations(), b.drainMutations(), hq.drain()]);
  a.close();
  b.close();
  await fs.rm(root, { recursive: true, force: true });
});

async function upload(store: SqliteSageStore) {
  const delta = await hq.merge({ projectId: 'shared', records: await store.listHqSync() });
  await Promise.all([a.applyHqSync(delta.records), b.applyHqSync(delta.records)]);
}

describe('project SAGE replication through durable HQ state', () => {
  it('upgrades installed triggers, ignores corrupt writes, and replicates a repaired row', async () => {
    const m = await a.rememberSage({ text: 'Memory before corruption', kind: 'fact' });
    const before = await a.listHqSync();
    const db = (a as unknown as { db: DatabaseSync }).db;
    db.exec(`
      DROP TRIGGER sage_hq_update;
      CREATE TRIGGER sage_hq_update AFTER UPDATE ON memories
        WHEN json_remove(new.data, '$.injectionCount') != json_remove(old.data, '$.injectionCount') BEGIN
        UPDATE hq_memory_sync SET revision = revision + 1 WHERE id = new.id;
      END;
      UPDATE schema_meta SET value = 1 WHERE key = 'hq_memory_sync_schema';
    `);
    a.close();
    a = new SqliteSageStore({ projectRoot: path.join(root, 'a') });
    await a.initialize();
    const migrated = (a as unknown as { db: DatabaseSync }).db;
    migrated.exec('DROP TRIGGER IF EXISTS memories_au');
    const version = await a.getHqSyncVersion();
    migrated.prepare('UPDATE memories SET data = ? WHERE id = ?').run('{broken', m.id);
    expect(await a.listHqSync()).toEqual(before);
    expect(await a.getHqSyncVersion()).toBe(version);
    migrated
      .prepare('UPDATE memories SET data = ? WHERE id = ?')
      .run(JSON.stringify({ ...m, text: 'Repaired project memory' }), m.id);
    expect((await a.listHqSync())[0]?.revision).toBeGreaterThan(before[0]!.revision);
    await upload(a);
    expect((await b.getSage(m.id))?.text).toBe('Repaired project memory');
  });
  it('replicates creation, updates, deletion, restart and a late client without resurrection or echo', async () => {
    const m = await a.rememberSage({ text: 'Use pnpm for this repository', kind: 'convention' });
    const initial = await a.listHqSync();
    await upload(a);
    expect((await b.getSage(m.id))?.text).toBe(m.text);
    expect(await b.listHqSync()).toEqual(initial);
    await b.updateSage(m.id, { text: 'Use pnpm.cmd on Windows' });
    await upload(b);
    expect((await a.getSage(m.id))?.text).toBe('Use pnpm.cmd on Windows');
    await a.deleteSage(m.id, 'Explicitly removed', { force: true });
    await upload(a);
    const deleted = await a.listHqSync();
    expect(deleted[0]?.memory?.status).toBe('deleted');
    const stale = await hq.merge({ projectId: 'shared', records: initial });
    expect(stale.records).toEqual(deleted);
    hq = new HqSageStore(path.join(root, 'hq'));
    const late = new SqliteSageStore({ projectRoot: path.join(root, 'late') });
    try {
      await late.applyHqSync((await hq.load('shared')).records);
      expect(await late.listHqSync()).toEqual(deleted);
      expect(await late.listSage(['active'])).toEqual([]);
    } finally {
      late.close();
    }
  });

  it('converges deterministic offline forks regardless of upload order', async () => {
    const m = await a.rememberSage({ text: 'Initial project rule', kind: 'fact' });
    await upload(a);
    await a.updateSage(m.id, { text: 'Offline change A' });
    await b.updateSage(m.id, { text: 'Offline change B' });
    const ar = await a.listHqSync();
    const br = await b.listHqSync();
    await hq.merge({ projectId: 'forward', records: ar });
    await hq.merge({ projectId: 'forward', records: br });
    await hq.merge({ projectId: 'reverse', records: br });
    await hq.merge({ projectId: 'reverse', records: ar });
    expect((await hq.load('forward')).records).toEqual((await hq.load('reverse')).records);
    const winner = (await hq.load('forward')).records;
    await a.applyHqSync(winner);
    await b.applyHqSync(winner);
    expect((await a.getSage(m.id))?.text).toBe((await b.getSage(m.id))?.text);
  });

  it('keeps user/session memories and recall counters local', async () => {
    const m = await a.rememberSage({ text: 'Shared project rule', kind: 'fact' });
    await a.rememberSage({ text: 'Personal preference', kind: 'preference', scope: 'user' });
    await a.rememberSage({
      text: 'Session detail',
      kind: 'summary',
      scope: 'session',
      ownerSessionId: 's1',
    });
    const before = await a.listHqSync();
    const beforeVersion = await a.getHqSyncVersion();
    await a.recordInjection([m.id], 'test');
    await a.recordUse([m.id], 'test');
    expect(await a.listHqSync()).toEqual(before);
    expect(await a.getHqSyncVersion()).toBe(beforeVersion);
    expect(before.map((r) => r.id)).toEqual([m.id]);
    await upload(a);
    expect((await b.listSage()).map((r) => r.id)).toEqual([m.id]);
    expect((await hq.load('other-project')).records).toEqual([]);
    await a.updateSage(m.id, { text: 'Changed shared project rule' });
    expect(await a.getHqSyncVersion()).not.toBe(beforeVersion);
  });

  it('retains hard-delete tombstones and persists the imported version across daemon restart', async () => {
    const m = await a.rememberSage({ text: 'Hard removal case', kind: 'fact' });
    const initial = await a.listHqSync();
    a.close();
    const db = new DatabaseSync(path.join(root, 'a', '.wrongstack', 'memories', 'sage.db'));
    db.prepare('DELETE FROM memories WHERE id = ?').run(m.id);
    db.close();
    a = new SqliteSageStore({ projectRoot: path.join(root, 'a') });
    const removed = await a.listHqSync();
    expect(removed[0]?.memory).toBeNull();
    await b.applyHqSync(removed);
    b.close();
    b = new SqliteSageStore({ projectRoot: path.join(root, 'b') });
    await b.applyHqSync(initial);
    expect(await b.listHqSync()).toEqual(removed);
    expect(await b.getSage(m.id)).toBeNull();
  });

  it('chunks UTF-8 payloads and rejects malformed records atomically', async () => {
    await a.rememberSage({ text: 'Valid rule', kind: 'fact' });
    const [record] = await a.listHqSync();
    const large = Array.from({ length: 20 }, (_, i) => ({
      ...record!,
      id: `m${i}`,
      memory: { ...record!.memory, id: `m${i}`, text: '界'.repeat(50_000) },
    }));
    const chunks = [...chunkHqSageRecords('shared', large)];
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every(isHqSageSnapshotPayload)).toBe(true);
    const bad = { ...record!, memory: { ...record!.memory, scope: 'user' } };
    await expect(b.applyHqSync([record!, bad])).rejects.toThrow('Invalid');
    expect(await b.listHqSync()).toEqual([]);
  });
});
