/**
 * Behavioural coverage for the server-owned SQLite mailbox store.
 *
 * The suite this replaced was written against the JSONL implementation and
 * asserted on that file format's internals — `_mailbox.jsonl` paths, the
 * bounded in-memory `_messageCache`, the incremental "file only grew" read
 * path, and half-written-append recovery. None of those exist behind SQLite,
 * so the assertions here are about observable mailbox semantics instead:
 * what `send`/`query`/`ack`/`purgeStale` do, and what the one-shot import of
 * a legacy `_mailbox.jsonl` produces.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteMailbox } from '../../src/coordination/sqlite-mailbox.js';

let dir: string;
let mb: SqliteMailbox;
const extraStores: SqliteMailbox[] = [];

/** `fs.rm` retries: SQLite keeps `-wal`/`-shm` mapped briefly after close. */
const RM_OPTIONS = { recursive: true, force: true, maxRetries: 10, retryDelay: 50 } as const;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'default-mailbox-'));
  mb = new SqliteMailbox(dir);
});
afterEach(async () => {
  for (const store of extraStores.splice(0)) await store.close().catch(() => undefined);
  await mb.close().catch(() => undefined);
  await fs.rm(dir, RM_OPTIONS);
});

const send = (over: Record<string, unknown> = {}) =>
  mb.send({ from: 'a', to: 'b', type: 'info', subject: 's', body: 'hi', ...over } as never);

/**
 * Seed a legacy `_mailbox.jsonl` and open a store over it. The constructor
 * runs the one-shot import, so this is the only way to introduce messages
 * with timestamps the caller controls (`send` always stamps "now").
 */
async function openWithLegacyMessages(lines: readonly unknown[]): Promise<SqliteMailbox> {
  const legacyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'legacy-mailbox-'));
  await fs.writeFile(
    path.join(legacyDir, '_mailbox.jsonl'),
    `${lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n')}\n`,
  );
  const store = new SqliteMailbox(legacyDir);
  extraStores.push(store);
  return store;
}

function legacyMessage(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '1',
    from: 'a',
    to: 'b',
    type: 'info',
    subject: 's',
    body: 'x',
    priority: 'normal',
    readBy: {},
    completed: false,
    timestamp: new Date().toISOString(),
    ...over,
  };
}

describe('SqliteMailbox basics', () => {
  it('exposes the store path', () => {
    expect(mb.databasePath).toBe(path.join(dir, '_mailbox.sqlite'));
    // Compatibility alias the project-server health/status consumers read.
    expect(mb.messagePath).toBe(mb.databasePath);
  });

  it('sends, normalizing the broadcast recipient', async () => {
    const msg = await send({ to: 'all' });
    expect(msg.to).toBe('*');
    expect(msg.priority).toBe('normal');
  });

  it('applies every query filter', async () => {
    await send({ from: 'x', to: 'y', type: 'task', priority: 'high', subject: 'one' });
    await send({ from: 'z', to: 'y', type: 'info', priority: 'low', subject: 'two' });
    await send({ to: '*', subject: 'broadcast' });
    expect((await mb.query({ from: 'x' })).map((m) => m.subject)).toEqual(['one']);
    expect((await mb.query({ type: 'task' })).length).toBe(1);
    expect((await mb.query({ minPriority: 'high' })).length).toBe(1);
    expect((await mb.query({ incompleteOnly: true })).length).toBe(3);
    expect((await mb.query({ to: 'y' })).length).toBe(3); // 2 direct + broadcast
    expect((await mb.query({ limit: 1 })).length).toBe(1);
  });

  it('filters by unreadBy and since', async () => {
    const m1 = await send({ subject: 'first' });
    await send({ subject: 'second' });
    await mb.ack({ messageId: m1.id, readerId: 'b' } as never);
    expect((await mb.query({ unreadBy: 'b' })).map((m) => m.subject)).not.toContain('first');
    expect((await mb.query({ since: '1970-01-01T00:00:00Z' })).length).toBe(2);
  });

  it('acks read/complete/outcome and returns null for unknown ids', async () => {
    const msg = await send({ to: 'b' });
    const acked = await mb.ack({
      messageId: msg.id,
      readerId: 'b',
      completed: true,
      outcome: 'ok',
    } as never);
    expect(acked).toMatchObject({ completed: true, completedBy: 'b', outcome: 'ok' });
    expect(await mb.ack({ messageId: 'nope', readerId: 'b' } as never)).toBeNull();
  });

  it('ack with read:false skips the receipt', async () => {
    const msg = await send({ to: 'b' });
    const acked = await mb.ack({ messageId: msg.id, readerId: 'b', read: false } as never);
    expect(acked?.readBy?.b).toBeUndefined();
  });

  it('counts unread messages for an agent or broadcast', async () => {
    await send({ to: 'b' });
    await send({ to: '*' });
    await send({ to: 'other' });
    expect(await mb.unreadCount('b')).toBe(2);
  });

  it('returns [] for a freshly created store', async () => {
    expect(await mb.query({})).toEqual([]);
  });
});

describe('SqliteMailbox agent + client registries', () => {
  it('persists registered agents and reports them as online', async () => {
    await mb.registerAgent({
      agentId: 'ag1',
      sessionId: 's1',
      name: 'Neo',
      role: 'executor',
    } as never);
    await mb.heartbeat({ agentId: 'ag1', status: 'running', currentTask: 'task-a' } as never);

    const statuses = await mb.getAgentStatuses();
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatchObject({
      agentId: 'ag1',
      name: 'Neo',
      role: 'executor',
      status: 'running',
      currentTask: 'task-a',
      online: true,
    });
    expect(await mb.getOnlineAgents()).toHaveLength(1);
  });

  it('deregisters an agent', async () => {
    await mb.registerAgent({ agentId: 'ag1', sessionId: 's1', name: 'Neo' } as never);
    await mb.deregisterAgent('ag1');
    expect(await mb.getAgentStatuses()).toEqual([]);
  });

  it('persists registered clients and drops them on deregister', async () => {
    await mb.registerClient({
      clientId: 'c1',
      sessionId: 's1',
      name: 'TUI',
      source: 'tui',
    } as never);
    const clients = await mb.getClientStatuses();
    expect(clients).toHaveLength(1);
    expect(clients[0]).toMatchObject({ clientId: 'c1', name: 'TUI', source: 'tui' });

    await mb.clientHeartbeat({ clientId: 'c1' } as never);
    await mb.deregisterClient('c1');
    expect(await mb.getClientStatuses()).toEqual([]);
  });
});

describe('SqliteMailbox query edge cases', () => {
  it('treats an unrecognized priority as normal for minPriority', async () => {
    await send({ priority: 'weird' as never, subject: 'odd' });
    // weird priority → order lookup falls back to 1 (normal) → passes minPriority:'normal'
    expect((await mb.query({ minPriority: 'normal' })).some((m) => m.subject === 'odd')).toBe(true);
  });
});

describe('SqliteMailbox lifecycle', () => {
  it('clearAll drops every message', async () => {
    await send();
    await mb.clearAll();
    expect(await mb.query({})).toEqual([]);
  });

  it('purgeStale drops old completed and incomplete messages', async () => {
    const oldTs = new Date(Date.now() - 10 * 86_400_000).toISOString();
    const store = await openWithLegacyMessages([
      legacyMessage({
        id: '1',
        subject: 'old-done',
        completed: true,
        completedAt: oldTs,
        timestamp: oldTs,
      }),
      legacyMessage({ id: '2', subject: 'old-incomplete', timestamp: oldTs }),
      legacyMessage({ id: '3', subject: 'recent' }),
    ]);
    const r = await store.purgeStale();
    expect(r).toMatchObject({
      completedPurged: 1,
      incompletePurged: 1,
      totalPurged: 2,
      remaining: 1,
    });
  });

  it('purgeStale on an empty mailbox is a no-op', async () => {
    expect((await mb.purgeStale()).totalPurged).toBe(0);
  });

  it('send + ackMany + send + query does not duplicate messages', async () => {
    const sent: string[] = [];
    for (let i = 0; i < 5; i++) {
      const m = await send({ subject: `m${i}` });
      sent.push(m.id);
    }
    await mb.ackMany({ acks: [{ messageId: sent[0]!, readerId: 'b' }] });
    for (let i = 5; i < 10; i++) {
      const m = await send({ subject: `m${i}` });
      sent.push(m.id);
    }
    const all = await mb.query({ limit: 100 });
    expect(all.length).toBe(10);
    const ids = new Set(all.map((m) => m.id));
    expect(ids.size).toBe(10);
    for (const id of sent) expect(ids.has(id)).toBe(true);
    // The first message must reflect the ack we issued.
    expect(all.find((m) => m.id === sent[0])?.readBy?.b).toBeTruthy();
  });

  it('send + clearAll + send + query returns only the post-clear messages', async () => {
    await send({ subject: 'will-be-cleared' });
    await send({ subject: 'will-be-cleared' });
    await mb.clearAll();
    await send({ subject: 'fresh-1' });
    await send({ subject: 'fresh-2' });
    const subjects = new Set((await mb.query({ limit: 100 })).map((m) => m.subject));
    expect(subjects).toEqual(new Set(['fresh-1', 'fresh-2']));
  });

  it('send + purgeStale + send + query keeps the recent and the new message', async () => {
    const oldTs = new Date(Date.now() - 10 * 86_400_000).toISOString();
    const store = await openWithLegacyMessages([
      legacyMessage({ id: 'stale-1', subject: 'stale', timestamp: oldTs }),
      legacyMessage({ id: 'recent-1', subject: 'recent' }),
    ]);
    await store.purgeStale();
    await store.send({ from: 'a', to: 'b', type: 'note', subject: 'after-purge', body: 'hi' });
    const all = await store.query({ limit: 100 });
    const ids = new Set(all.map((m) => m.id));
    expect(ids.has('stale-1')).toBe(false);
    expect(ids.has('recent-1')).toBe(true);
    expect(ids.size).toBe(2);
    expect(all.some((m) => m.subject === 'after-purge')).toBe(true);
  });
});

describe('SqliteMailbox legacy JSONL import', () => {
  it('migrates legacy read/readAt and skips malformed lines', async () => {
    // `read`/`readAt` only migrate when the record predates `readBy`.
    const legacy = legacyMessage({ read: true, readAt: '2026-01-01T00:00:00Z' });
    delete legacy['readBy'];
    const store = await openWithLegacyMessages([legacy, 'not-json']);
    const all = await store.query({});
    expect(all.length).toBe(1);
    expect(all[0]?.readBy?.b).toBe('2026-01-01T00:00:00Z');
  });

  it('uses "unknown" as the read key when a legacy message has no recipient', async () => {
    const legacy = legacyMessage({ read: true, readAt: '2026-01-01T00:00:00Z' });
    delete legacy['readBy'];
    delete legacy['to'];
    const store = await openWithLegacyMessages([legacy]);
    const all = await store.query({});
    expect(all[0]?.readBy?.unknown).toBe('2026-01-01T00:00:00Z');
  });

  it('runs the import exactly once per store', async () => {
    const legacyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'legacy-mailbox-once-'));
    await fs.writeFile(
      path.join(legacyDir, '_mailbox.jsonl'),
      `${JSON.stringify(legacyMessage({ id: 'once-1', subject: 'imported' }))}\n`,
    );
    const first = new SqliteMailbox(legacyDir);
    extraStores.push(first);
    expect(await first.query({})).toHaveLength(1);
    await first.close();

    // Re-opening the same directory must not import the retired file again.
    const second = new SqliteMailbox(legacyDir);
    extraStores.push(second);
    expect(await second.query({})).toHaveLength(1);
  });
});
