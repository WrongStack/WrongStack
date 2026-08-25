/**
 * Behavioural snapshots for the project mailbox store (`SqliteMailbox`).
 *
 * These assertions were originally written against the JSONL `GlobalMailbox`.
 * The store is SQLite now, so anything that reached into the file format —
 * partial-line recovery, the optimistic read cache and its desync counters,
 * `_mailbox.registry.json` rewrites — is gone. What survives is the contract
 * every surface depends on: addressing, filters, receipts, the agent and
 * client registries, and the one-shot import of a legacy JSONL mailbox.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveProjectDir } from '../../src/coordination/global-mailbox-paths.js';
import { SqliteMailbox } from '../../src/coordination/sqlite-mailbox.js';
import type { EventBus } from '../../src/kernel/events.js';

let dir: string;
let mb: SqliteMailbox;
let events: { emitCustom: ReturnType<typeof vi.fn> };
const extraStores: SqliteMailbox[] = [];
const extraDirs: string[] = [];

/** SQLite keeps `-wal`/`-shm` mapped for a moment after close. */
const RM_OPTIONS = { recursive: true, force: true, maxRetries: 10, retryDelay: 50 } as const;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'global-mailbox-'));
  events = { emitCustom: vi.fn() };
  mb = new SqliteMailbox(dir, events as never as EventBus);
});
afterEach(async () => {
  for (const store of extraStores.splice(0)) await store.close().catch(() => undefined);
  await mb.close().catch(() => undefined);
  for (const extra of extraDirs.splice(0)) await fs.rm(extra, RM_OPTIONS);
  await fs.rm(dir, RM_OPTIONS);
});

const send = (over: Record<string, unknown> = {}) =>
  mb.send({ from: 'a', to: 'b', type: 'info', subject: 's', body: 'hi', ...over } as never);

/**
 * Open a store over a directory seeded with the retired on-disk files.
 *
 * The constructor runs the one-shot legacy import, which is how a test
 * introduces records whose timestamps it controls — `send`, `registerAgent`
 * and `registerClient` all stamp "now".
 */
async function openWithLegacyFiles(files: Record<string, string>): Promise<SqliteMailbox> {
  const legacyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'global-mailbox-legacy-'));
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(legacyDir, name), content);
  }
  const store = new SqliteMailbox(legacyDir, events as never as EventBus);
  extraStores.push(store);
  extraDirs.push(legacyDir);
  return store;
}

describe('resolveProjectDir', () => {
  it('joins globalRoot/projects/<slug>', () => {
    const p = resolveProjectDir('/some/project', '/root');
    expect(p.replace(/\\/g, '/')).toMatch(/\/root\/projects\//);
  });
});

describe('SqliteMailbox messages', () => {
  it('sends a message, normalizing the broadcast recipient', async () => {
    const msg = await send({ to: 'all' });
    expect(msg.to).toBe('*');
    expect(msg.priority).toBe('normal');
    expect(msg.id).toBeTruthy();
  });

  it('canonicalizes @session and isolates delivery to that session address', async () => {
    const sessionMessage = await send({
      to: '@session',
      senderSessionId: 'session-a',
      subject: 'same-session',
    });
    await send({ to: '@session', senderSessionId: 'session-b', subject: 'other-session' });
    await send({ to: '*', senderSessionId: 'session-b', subject: 'project-wide' });

    expect(sessionMessage.to).toBe('@session:session-a');
    expect(sessionMessage.senderSessionId).toBe('session-a');
    expect((await mb.query({ to: '@session:session-a' })).map((m) => m.subject)).toEqual(
      expect.arrayContaining(['same-session', 'project-wide']),
    );
    expect((await mb.query({ to: '@session:session-a' })).map((m) => m.subject)).not.toContain(
      'other-session',
    );
    expect(await mb.unreadCount('agent-a', 'session-a')).toBe(2);
  });

  it('filters messages by sender session id', async () => {
    await send({ senderSessionId: 'session-a', subject: 'from-a' });
    await send({ senderSessionId: 'session-b', subject: 'from-b' });

    expect((await mb.query({ sessionId: 'session-a' })).map((m) => m.subject)).toEqual(['from-a']);
  });

  it('rejects @session when the sender session id is missing', async () => {
    await expect(send({ to: '@session' })).rejects.toThrow(/sessionId is required/);
  });

  it('queries with every filter', async () => {
    await send({ from: 'x', to: 'y', type: 'assign', priority: 'high', subject: 'one' });
    await send({ from: 'z', to: 'y', type: 'info', priority: 'low', subject: 'two' });
    await send({ to: '*', subject: 'broadcast' });

    expect((await mb.query({ to: 'y' })).length).toBe(3); // 2 direct + the '*' broadcast (matches any `to`)
    expect((await mb.query({ from: 'x' })).map((m) => m.subject)).toEqual(['one']);
    expect((await mb.query({ type: 'assign' })).length).toBe(1);
    expect((await mb.query({ minPriority: 'high' })).length).toBe(1);
    expect((await mb.query({ incompleteOnly: true })).length).toBeGreaterThan(0);
    const limited = await mb.query({ limit: 1 });
    expect(limited.length).toBe(1);
  });

  it('filters by unreadBy and since', async () => {
    const m1 = await send({ subject: 'first' });
    await send({ subject: 'second' });
    await mb.ack({ messageId: m1.id, readerId: 'b' } as never);
    const unread = await mb.query({ unreadBy: 'b' });
    expect(unread.map((m) => m.subject)).not.toContain('first');
    const since = await mb.query({ since: m1.timestamp });
    expect(since.length).toBeGreaterThanOrEqual(0);
  });

  it('applies unread filtering and the result limit before materializing message bodies', async () => {
    const messages = [];
    for (let i = 0; i < 80; i++) {
      messages.push(await send({ subject: `message-${i}`, body: 'x'.repeat(8_192) }));
    }
    for (const message of messages.slice(5)) {
      await mb.ack({ messageId: message.id, readerId: 'b', read: true } as never);
    }

    type Materialize = (rows: readonly unknown[]) => unknown[];
    const instrumented = mb as unknown as { materializeMessageRows: Materialize };
    const original = instrumented.materializeMessageRows.bind(mb);
    const materializedRowCounts: number[] = [];
    instrumented.materializeMessageRows = (rows) => {
      materializedRowCounts.push(rows.length);
      return original(rows);
    };

    const unread = await mb.query({ to: 'b', unreadBy: 'b', limit: 3 });

    expect(unread).toHaveLength(3);
    expect(materializedRowCounts).toEqual([3]);
  });

  it('loads receipts in bounded targeted chunks for a query larger than 500 rows', async () => {
    for (let i = 0; i < 501; i++) {
      await send({ subject: `receipt-chunk-${i}` });
    }

    const database = (mb as unknown as { db: { prepare: (sql: string) => unknown } }).db;
    const prepare = database.prepare.bind(database);
    const receiptQueries: string[] = [];
    database.prepare = ((sql: string) => {
      if (sql.includes('FROM message_receipts')) receiptQueries.push(sql);
      return prepare(sql);
    }) as typeof database.prepare;

    const messages = await mb.query({
      incompleteOnly: true,
      includeReceiptState: true,
      limit: 600,
    });

    expect(messages).toHaveLength(501);
    expect(receiptQueries).toHaveLength(2);
    expect(receiptQueries.every((sql) => /WHERE message_id IN/i.test(sql))).toBe(true);
  });

  it('bounds heartbeat throttle bookkeeping even during a fresh-id burst', () => {
    const map = new Map<string, number>();
    const now = Date.now();
    for (let i = 0; i < 700; i++) map.set(`agent-${i}`, now);

    (
      mb as unknown as {
        pruneHeartbeats: (entries: Map<string, number>, nowMs: number) => void;
      }
    ).pruneHeartbeats(map, now);

    expect(map.size).toBeLessThanOrEqual(512);
    expect(map.has('agent-0')).toBe(false);
    expect(map.has('agent-699')).toBe(true);
  });

  it('coalesces overlapping auto-compaction calls', async () => {
    let releaseStatuses: (() => void) | undefined;
    let statusReads = 0;
    (mb as unknown as { compactionCtx: () => unknown }).compactionCtx = () => ({
      getAgentStatuses: async () => {
        statusReads++;
        await new Promise<void>((resolve) => {
          releaseStatuses = resolve;
        });
        return [];
      },
      readMessages: () => [],
      deleteMessages: () => {},
    });

    const first = mb.autoCompact();
    const second = mb.autoCompact();
    await Promise.resolve();
    expect(statusReads).toBe(1);
    releaseStatuses?.();
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ totalRemoved: 0 }),
      expect.objectContaining({ totalRemoved: 0 }),
    ]);
  });

  it('acks read receipts, completion, and outcome; returns null for unknown ids', async () => {
    const msg = await send({ to: 'b@sess-1' });
    const acked = await mb.ack({
      messageId: msg.id,
      readerId: 'b@sess-1',
      completed: true,
      outcome: 'done',
    } as never);
    expect(acked?.completed).toBe(true);
    expect(acked?.completedBy).toBe('b@sess-1');
    expect(acked?.outcome).toBe('done');
    expect(await mb.ack({ messageId: 'nope', readerId: 'b' } as never)).toBeNull();
  });

  it('ack with read:false does not record a read receipt', async () => {
    const msg = await send({ to: 'b' });
    const acked = await mb.ack({ messageId: msg.id, readerId: 'b', read: false } as never);
    expect(acked?.readBy?.b).toBeUndefined();
  });

  it('counts unread messages addressed to an agent or broadcast', async () => {
    await send({ to: 'b' });
    await send({ to: '*' });
    await send({ to: 'other' });
    expect(await mb.unreadCount('b')).toBe(2); // direct + broadcast
  });

  it('sees a write committed by another connection to the same store', async () => {
    await send({ subject: 'seed' });
    const other = new SqliteMailbox(dir);
    extraStores.push(other);
    await other.send({
      from: 'external',
      to: 'b',
      type: 'note',
      subject: 'cross-process',
      body: 'arrived after the first read',
    });

    const all = await mb.query({ limit: 100 });
    expect(all.map((message) => message.subject)).toEqual(['cross-process', 'seed']);
  });

  it('migrates legacy read/readAt to readBy and skips malformed lines', async () => {
    const legacy = JSON.stringify({
      id: '1',
      from: 'a',
      to: 'b',
      type: 'info',
      subject: 's',
      body: 'x',
      read: true,
      readAt: '2026-01-01T00:00:00Z',
      timestamp: '2026-01-01T00:00:00Z',
      priority: 'normal',
      completed: false,
    });
    const store = await openWithLegacyFiles({ '_mailbox.jsonl': `${legacy}\nnot-json-line\n` });
    const all = await store.query({});
    expect(all.length).toBe(1);
    expect(all[0]?.readBy?.b).toBe('2026-01-01T00:00:00Z');
  });
});

describe('SqliteMailbox agent registry', () => {
  const reg = (over: Record<string, unknown> = {}) =>
    mb.registerAgent({
      agentId: 'ag1',
      sessionId: 's1',
      name: 'Neo',
      role: 'executor',
      ...over,
    } as never);

  it('registers an agent and reports it as online', async () => {
    await reg();
    expect(events.emitCustom).toHaveBeenCalledWith('mailbox.agent_registered', expect.any(Object));
    const statuses = await mb.getAgentStatuses();
    expect(statuses[0]).toMatchObject({ agentId: 'ag1', online: true });
    expect((await mb.getOnlineAgents()).length).toBe(1);
  });

  it('applies a heartbeat and updates status fields', async () => {
    await reg();
    await mb.heartbeat({
      agentId: 'ag1',
      status: 'busy',
      currentTool: 'bash',
      currentTask: 'build',
      iterations: 3,
      toolCalls: 5,
    } as never);
    const s = (await mb.getAgentStatuses())[0];
    expect(s).toMatchObject({ status: 'busy', currentTool: 'bash', iterations: 3, toolCalls: 5 });
  });

  it('throttles repeated heartbeats within the window', async () => {
    await reg();
    await mb.heartbeat({ agentId: 'ag1', status: 'busy' } as never);
    events.emitCustom.mockClear();
    await mb.heartbeat({ agentId: 'ag1', status: 'idle' } as never); // throttled → early return
    expect(events.emitCustom).not.toHaveBeenCalled();
  });

  it('silently ignores a heartbeat for an unregistered agent', async () => {
    await expect(mb.heartbeat({ agentId: 'ghost' } as never)).resolves.toBeUndefined();
  });

  /**
   * Presence rows are deleted once older than AGENT_STALE_MS (60s) — by this
   * store's own prune, by registerAgent, or by ANY observer calling
   * getAgentStatuses(). A live agent never calls registerAgent twice, so before
   * the heartbeat rebuild branch existed, one >60s gap (sleep, event-loop
   * starvation, a blocking call) removed a working agent from the registry for
   * the rest of its life.
   */
  it('rebuilds a pruned row when a live agent heartbeats after a >60s gap', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      await reg();
      expect((await mb.getAgentStatuses()).length).toBe(1);

      // The gap: 90s > AGENT_STALE_MS. The row is now prunable.
      vi.setSystemTime(new Date('2026-01-01T00:01:30.000Z'));

      await mb.heartbeat({
        agentId: 'ag1',
        status: 'running',
        iterations: 7,
        toolCalls: 9,
        // Identity — without these the row cannot be rebuilt truthfully.
        sessionId: 's1',
        name: 'Neo',
        role: 'executor',
        pid: 4242,
        source: 'cli',
      } as never);

      const statuses = await mb.getAgentStatuses();
      expect(statuses.length).toBe(1);
      expect(statuses[0]).toMatchObject({
        agentId: 'ag1',
        sessionId: 's1',
        name: 'Neo',
        role: 'executor',
        status: 'running',
        iterations: 7,
        toolCalls: 9,
        pid: 4242,
        source: 'cli',
        online: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('rebuilds a row that an observer deleted by reading it', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      await reg();

      // getAgentStatuses() prunes before reading, so an observer past the
      // window destroys the very row it was inspecting.
      vi.setSystemTime(new Date('2026-01-01T00:01:30.000Z'));
      expect(await mb.getAgentStatuses()).toEqual([]);

      await mb.heartbeat({ agentId: 'ag1', sessionId: 's1', name: 'Neo' } as never);
      expect((await mb.getAgentStatuses())[0]).toMatchObject({ agentId: 'ag1', online: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves a pruned row absent when the heartbeat carries no identity', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      await reg();

      // Old-style caller: agentId only. Rebuilding would have to invent a name
      // and pid, so the store must keep the previous refresh-only behavior.
      vi.setSystemTime(new Date('2026-01-01T00:01:30.000Z'));
      await mb.heartbeat({ agentId: 'ag1', status: 'running' } as never);
      expect(await mb.getAgentStatuses()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops stale agents imported from the legacy registry', async () => {
    const old = new Date(Date.now() - 120_000).toISOString();
    const store = await openWithLegacyFiles({
      '_mailbox.registry.json': JSON.stringify({
        stale: {
          agentId: 'stale',
          sessionId: 's',
          name: 'Old',
          role: 'r',
          status: 'busy',
          iterations: 0,
          toolCalls: 0,
          registeredAt: old,
          lastSeenAt: old,
        },
      }),
    });

    expect(await store.getAgentStatuses()).toEqual([]);
  });

  it('drops agents whose heartbeat timestamp is malformed', async () => {
    const store = await openWithLegacyFiles({
      '_mailbox.registry.json': JSON.stringify({
        ghost: {
          agentId: 'ghost',
          sessionId: 's',
          name: 'Ghost',
          status: 'busy',
          iterations: 0,
          toolCalls: 0,
          registeredAt: 'invalid',
          lastSeenAt: 'invalid',
        },
      }),
    });

    expect(await store.getAgentStatuses()).toEqual([]);
  });

  it('returns no agents for a store nothing has registered with', async () => {
    expect(await mb.getAgentStatuses()).toEqual([]);
  });

  it('sorts multiple agents by last-seen', async () => {
    await mb.registerAgent({ agentId: 'a1', sessionId: 's', name: 'A', role: 'r' } as never);
    await mb.registerAgent({ agentId: 'a2', sessionId: 's', name: 'B', role: 'r' } as never);
    expect((await mb.getAgentStatuses()).length).toBe(2); // sort comparator invoked
  });

  it('deregisters an agent', async () => {
    await reg();
    await mb.deregisterAgent('ag1');
    expect(await mb.getAgentStatuses()).toEqual([]);
    expect(events.emitCustom).toHaveBeenCalledWith('mailbox.agent_deregistered', {
      agentId: 'ag1',
    });
  });
});

describe('SqliteMailbox client registry', () => {
  const reg = (over: Record<string, unknown> = {}) =>
    mb.registerClient({
      clientId: 'c1',
      sessionId: 's1',
      name: 'TUI',
      source: 'tui',
      ...over,
    } as never);

  it('registers a client and reports it online', async () => {
    await reg();
    expect(events.emitCustom).toHaveBeenCalledWith('mailbox.client_registered', expect.any(Object));
    const statuses = await mb.getClientStatuses();
    expect(statuses[0]).toMatchObject({ clientId: 'c1', online: true });
  });

  it('applies and throttles client heartbeats', async () => {
    await reg();
    await mb.clientHeartbeat({ clientId: 'c1' } as never);
    events.emitCustom.mockClear();
    await mb.clientHeartbeat({ clientId: 'c1' } as never); // throttled
    expect(events.emitCustom).not.toHaveBeenCalled();
  });

  it('updates client session id on heartbeat when provided', async () => {
    await reg();
    await mb.clientHeartbeat({ clientId: 'c1', sessionId: 's2' });
    const statuses = await mb.getClientStatuses();
    expect(statuses[0]).toMatchObject({ clientId: 'c1', sessionId: 's2' });
    expect(events.emitCustom).toHaveBeenCalledWith(
      'mailbox.client_heartbeat',
      expect.objectContaining({ clientId: 'c1', sessionId: 's2' }),
    );
  });

  it('sorts multiple clients by last-seen', async () => {
    await reg({ clientId: 'c1' });
    await reg({ clientId: 'c2' });
    expect((await mb.getClientStatuses()).length).toBe(2); // sort comparator invoked
  });

  it('deregisters a client immediately on clean shutdown', async () => {
    await reg();
    await mb.deregisterClient('c1');

    expect(await mb.getClientStatuses()).toEqual([]);
    expect(events.emitCustom).toHaveBeenCalledWith('mailbox.client_deregistered', {
      clientId: 'c1',
    });
  });

  it('prunes stale clients imported from the legacy registry', async () => {
    const old = new Date(Date.now() - 120_000).toISOString();
    const store = await openWithLegacyFiles({
      '_mailbox.clients.json': JSON.stringify({
        c1: {
          clientId: 'c1',
          sessionId: 's',
          name: 'Old',
          source: 'tui',
          registeredAt: old,
          lastSeenAt: old,
        },
      }),
    });
    // Clients past CLIENT_STALE_MS (60s) are pruned entirely, so the
    // registry returns empty instead of a client with online:false.
    expect(await store.getClientStatuses()).toEqual([]);
  });
});

describe('SqliteMailbox lifecycle', () => {
  it('close is idempotent', async () => {
    await mb.registerAgent({ agentId: 'a', sessionId: 's', name: 'n', role: 'r' } as never);
    await expect(mb.close()).resolves.toBeUndefined();
    await expect(mb.close()).resolves.toBeUndefined();
  });

  it('clearAll drops every message', async () => {
    await send();
    await mb.clearAll();
    expect(await mb.query({})).toEqual([]);
  });

  it('purgeStale drops old completed and incomplete messages', async () => {
    const oldTs = new Date(Date.now() - 10 * 86_400_000).toISOString(); // 10 days old
    const recentTs = new Date().toISOString();
    const lines = [
      {
        id: '1',
        from: 'a',
        to: 'b',
        type: 'info',
        subject: 'old-done',
        body: '',
        priority: 'normal',
        readBy: {},
        completed: true,
        completedAt: oldTs,
        timestamp: oldTs,
      },
      {
        id: '2',
        from: 'a',
        to: 'b',
        type: 'info',
        subject: 'old-incomplete',
        body: '',
        priority: 'normal',
        readBy: {},
        completed: false,
        timestamp: oldTs,
      },
      {
        id: '3',
        from: 'a',
        to: 'b',
        type: 'info',
        subject: 'recent',
        body: '',
        priority: 'normal',
        readBy: {},
        completed: false,
        timestamp: recentTs,
      },
    ]
      .map((m) => JSON.stringify(m))
      .join('\n');
    const store = await openWithLegacyFiles({ '_mailbox.jsonl': `${lines}\n` });

    const result = await store.purgeStale();
    expect(result.completedPurged).toBe(1);
    expect(result.incompletePurged).toBe(1);
    expect(result.totalPurged).toBe(2);
    expect(result.remaining).toBe(1);
  });

  it('purgeStale on an empty mailbox is a no-op', async () => {
    const result = await mb.purgeStale();
    expect(result.totalPurged).toBe(0);
  });
});

describe('SqliteMailbox session-affinity read-path filtering', () => {
  const sendAffinity = (over: Record<string, unknown> = {}) =>
    mb.send({
      from: 'leader-a',
      to: 'leader-a',
      type: 'result',
      subject: 'chimera report',
      body: 'review',
      ...over,
    } as never);

  it('query drops messages whose affinity token targets a different session', async () => {
    await sendAffinity({
      subject: 'same-session',
      sessionAffinity: { kind: 'chimera.review', sessionId: 'session-cur' },
    } as never);
    await sendAffinity({
      subject: 'cross-session',
      sessionAffinity: { kind: 'chimera.review', sessionId: 'session-other' },
    } as never);
    await sendAffinity({ subject: 'no-token' } as never);

    const visible = await mb.query({ to: 'leader-a', currentSessionId: 'session-cur' });
    expect(visible.map((m) => m.subject)).toEqual(
      expect.arrayContaining(['same-session', 'no-token']),
    );
    expect(visible.map((m) => m.subject)).not.toContain('cross-session');
  });

  it('query keeps same-session affinity mail and honors allowUnscoped without a session', async () => {
    await sendAffinity({
      subject: 'same-session',
      sessionAffinity: { kind: 'chimera.review', sessionId: 'session-cur' },
    } as never);

    const sameSession = await mb.query({
      to: 'leader-a',
      currentSessionId: 'session-cur',
    });
    expect(sameSession.map((m) => m.subject)).toContain('same-session');

    // With an affinity ctx but no reader session, allowUnscoped governs.
    const unscoped = await mb.query({
      to: 'leader-a',
      sessionAffinityCtx: { allowUnscoped: true },
    });
    expect(unscoped.map((m) => m.subject)).toContain('same-session');

    // No reader context at all → the filter is skipped (matches the inbox
    // checker, which always supplies a session), so the mail is returned.
    const noContext = await mb.query({ to: 'leader-a' });
    expect(noContext.map((m) => m.subject)).toContain('same-session');
  });

  it('explicit mismatched sessionId is dropped even when allowUnscoped is true', async () => {
    await sendAffinity({
      subject: 'mismatch',
      sessionAffinity: { kind: 'chimera.review', sessionId: 'session-other' },
    } as never);

    const visible = await mb.query({
      to: 'leader-a',
      currentSessionId: 'session-cur',
      sessionAffinityCtx: { allowUnscoped: true },
    });
    expect(visible.map((m) => m.subject)).not.toContain('mismatch');
  });

  it('unreadCount excludes cross-session affinity mail (badge agrees with inbox)', async () => {
    await sendAffinity({
      subject: 'same-session',
      sessionAffinity: { kind: 'chimera.review', sessionId: 'session-cur' },
    } as never);
    await sendAffinity({
      subject: 'cross-session',
      sessionAffinity: { kind: 'chimera.review', sessionId: 'session-other' },
    } as never);

    expect(await mb.unreadCount('leader-a', 'session-cur')).toBe(1);
    expect(await mb.unreadCount('leader-a', 'session-other')).toBe(1);
  });

  it('malformed persisted affinity tokens fail closed on both read paths', async () => {
    // Persist malformed tokens via send() (cast): the JSONL import path rejects
    // them at the codec and drops the line before it reaches the store, so the
    // read-path guard would never be exercised. send() stores `data` verbatim,
    // letting the null/Array fail-closed branches in acceptMailboxMessageForSession
    // actually run against persisted rows.
    await mb.send({
      from: 'leader-a',
      to: 'leader-a',
      type: 'result',
      subject: 'null-token',
      body: '',
      sessionAffinity: null,
    } as never);
    await mb.send({
      from: 'leader-a',
      to: 'leader-a',
      type: 'result',
      subject: 'array-token',
      body: '',
      sessionAffinity: [],
    } as never);
    await sendAffinity({ subject: 'no-token' } as never);

    const visible = await mb.query({ to: 'leader-a', currentSessionId: 'session-cur' });
    expect(visible.map((m) => m.subject)).toEqual(['no-token']);
    expect(await mb.unreadCount('leader-a', 'session-cur')).toBe(1);
  });
});
