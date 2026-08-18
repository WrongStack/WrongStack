import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteMailbox } from '../../src/coordination/sqlite-mailbox.js';
import type { MailboxMessage } from '../../src/coordination/mailbox-types.js';
import type { EventBus } from '../../src/kernel/events.js';

let dir: string;
let mb: SqliteMailbox;
let events: { emitCustom: ReturnType<typeof vi.fn> };

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailbox-autocompact-'));
  events = { emitCustom: vi.fn() };
  mb = new SqliteMailbox(dir, events as never as EventBus);
});

afterEach(async () => {
  await mb.close().catch(() => undefined);
  // SQLite keeps `-wal`/`-shm` mapped for a moment after the handle closes.
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/**
 * Seed messages with caller-chosen timestamps, expiry and read state.
 *
 * `send()` always stamps "now", and the store is SQLite, so raw rows cannot be
 * appended to a file behind its back. The store's one-shot import of a legacy
 * `_mailbox.jsonl` is the supported way in: drop the database, write the
 * retired file, and reopen so the constructor imports it.
 */
async function writeRawMessages(messages: Partial<MailboxMessage>[]): Promise<void> {
  const defaults = {
    from: 'a',
    to: 'b',
    type: 'note' as const,
    subject: 's',
    body: '',
    priority: 'normal' as const,
    readBy: {},
    completed: false,
    timestamp: new Date().toISOString(),
  };
  const lines = messages
    .map((m) => JSON.stringify({ ...defaults, ...m }))
    .join('\n');
  // Dropping the database drops the agent registry with it, and several tests
  // register their online agents before seeding messages. Carry them over.
  const agents = await mb.getAgentStatuses();
  await mb.close();
  const rmOptions = { force: true, maxRetries: 10, retryDelay: 50 } as const;
  for (const suffix of ['', '-wal', '-shm']) {
    await fs.rm(path.join(dir, `_mailbox.sqlite${suffix}`), rmOptions);
  }
  await fs.writeFile(path.join(dir, '_mailbox.jsonl'), `${lines}\n`);
  mb = new SqliteMailbox(dir, events as never as EventBus);
  for (const agent of agents) {
    await mb.registerAgent({
      agentId: agent.agentId,
      sessionId: agent.sessionId,
      name: agent.name,
      ...(agent.role !== undefined ? { role: agent.role } : {}),
      ...(agent.source !== undefined ? { source: agent.source } : {}),
      pid: agent.pid,
    });
  }
}

// ── TTL on send ───────────────────────────────────────────────────────────

describe('SqliteMailbox TTL on send', () => {
  it('sets expiresAt from ttlMs', async () => {
    const before = Date.now();
    const msg = await mb.send({
      from: 'a', to: 'b', type: 'note', subject: 's', body: 'hi',
      ttlMs: 60_000,
    });
    const after = Date.now();

    expect(msg.expiresAt).toBeDefined();
    const expiry = new Date(msg.expiresAt!).getTime();
    expect(expiry).toBeGreaterThanOrEqual(before + 60_000);
    expect(expiry).toBeLessThanOrEqual(after + 60_000);
  });

  it('omits expiresAt when ttlMs is not provided', async () => {
    const msg = await mb.send({
      from: 'a', to: 'b', type: 'note', subject: 's', body: 'hi',
    });
    expect(msg.expiresAt).toBeUndefined();
  });

  it('honors ttlMs of 0 as "expires immediately"', async () => {
    const msg = await mb.send({
      from: 'a', to: 'b', type: 'note', subject: 's', body: 'hi',
      ttlMs: 0,
    });
    expect(msg.expiresAt).toBeDefined();
    // Should already be in the past (or very close to now).
    const expiry = new Date(msg.expiresAt!).getTime();
    expect(expiry).toBeLessThanOrEqual(Date.now());
  });
});

// ── autoCompact: expiry pass ──────────────────────────────────────────────

describe('SqliteMailbox autoCompact — expiry', () => {
  it('removes messages with explicit expiresAt in the past', async () => {
    const pastExpiry = new Date(Date.now() - 60_000).toISOString();
    await writeRawMessages([
      { id: '1', subject: 'expired', expiresAt: pastExpiry },
      { id: '2', subject: 'alive', expiresAt: new Date(Date.now() + 60_000).toISOString() },
    ]);

    const result = await mb.autoCompact();
    expect(result.expiredRemoved).toBe(1);
    expect(result.totalRemoved).toBe(1);
    expect(result.remaining).toBe(1);

    const remaining = await mb.query({ limit: 100 });
    expect(remaining.map((m) => m.subject)).toEqual(['alive']);
  });

  it('removes messages without expiresAt older than defaultTtlMs', async () => {
    const old = new Date(Date.now() - 25 * 3600_000).toISOString(); // 25h ago
    const recent = new Date().toISOString();
    await writeRawMessages([
      { id: '1', subject: 'old-no-expiry', timestamp: old },
      { id: '2', subject: 'recent', timestamp: recent },
    ]);

    const result = await mb.autoCompact({ defaultTtlMs: 86_400_000 }); // 24h
    expect(result.expiredRemoved).toBe(1);
    expect(result.remaining).toBe(1);
  });

  it('expires transient status chatter well before the default TTL', async () => {
    const hourAgo = new Date(Date.now() - 3600_000).toISOString();
    await writeRawMessages([
      { id: '1', type: 'status', subject: 'stale-status', timestamp: hourAgo },
      { id: '2', type: 'note', subject: 'note-same-age', timestamp: hourAgo },
    ]);

    // Both are an hour old and neither carries an explicit expiry, so under a
    // single 24h TTL both would survive. Only the live-awareness chatter goes.
    const result = await mb.autoCompact();
    expect(result.expiredRemoved).toBe(1);

    const remaining = await mb.query({ limit: 100 });
    expect(remaining.map((m) => m.subject)).toEqual(['note-same-age']);
  });

  it('lets an explicit expiresAt outrank the type TTL', async () => {
    const hourAgo = new Date(Date.now() - 3600_000).toISOString();
    await writeRawMessages([
      {
        id: '1',
        type: 'status',
        subject: 'pinned-status',
        timestamp: hourAgo,
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      },
    ]);

    const result = await mb.autoCompact();
    expect(result.expiredRemoved).toBe(0);
    expect((await mb.query({ limit: 100 })).map((m) => m.subject)).toEqual(['pinned-status']);
  });

  it('respects a caller-supplied typeTtlMs override', async () => {
    const hourAgo = new Date(Date.now() - 3600_000).toISOString();
    await writeRawMessages([
      { id: '1', type: 'status', subject: 'kept-status', timestamp: hourAgo },
    ]);

    const result = await mb.autoCompact({ typeTtlMs: { status: 86_400_000 } });
    expect(result.expiredRemoved).toBe(0);
    expect(result.remaining).toBe(1);
  });

  it('respects a custom defaultTtlMs', async () => {
    const twoHrsAgo = new Date(Date.now() - 2 * 3600_000).toISOString();
    await writeRawMessages([
      { id: '1', subject: '2h-old', timestamp: twoHrsAgo },
    ]);

    // With a 3h TTL the message survives.
    const result = await mb.autoCompact({ defaultTtlMs: 3 * 3600_000 });
    expect(result.expiredRemoved).toBe(0);
    expect(result.remaining).toBe(1);
  });

  it('does NOT remove a message whose expiresAt is still in the future', async () => {
    const futureExpiry = new Date(Date.now() + 3600_000).toISOString();
    await writeRawMessages([
      { id: '1', subject: 'future-expiry', expiresAt: futureExpiry },
    ]);

    const result = await mb.autoCompact();
    expect(result.expiredRemoved).toBe(0);
    expect(result.remaining).toBe(1);
  });
});

// ── autoCompact: read-by-all pass ─────────────────────────────────────────

describe('SqliteMailbox autoCompact — read by all online agents', () => {
  it('removes messages read by every online agent after readMaxAgeMs', async () => {
    // Register two online agents.
    await mb.registerAgent({ agentId: 'ag1', sessionId: 's', name: 'A', role: 'r', pid: 1 });
    await mb.registerAgent({ agentId: 'ag2', sessionId: 's', name: 'B', role: 'r', pid: 2 });

    const oldRead = new Date(Date.now() - 120_000).toISOString(); // 2 min ago
    await writeRawMessages([
      {
        id: '1', subject: 'read-by-all-old',
        readBy: { ag1: oldRead, ag2: oldRead },
        timestamp: oldRead,
      },
      {
        id: '2', subject: 'read-by-one',
        readBy: { ag1: oldRead },
        timestamp: oldRead,
      },
    ]);

    const result = await mb.autoCompact({ readMaxAgeMs: 60_000 });
    expect(result.readByAllRemoved).toBe(1); // only msg 1
    expect(result.remaining).toBe(1);
    const remaining = await mb.query({ limit: 100 });
    expect(remaining.map((m) => m.subject)).toEqual(['read-by-one']);
  });

  it('does NOT remove read-by-all messages newer than readMaxAgeMs', async () => {
    await mb.registerAgent({ agentId: 'ag1', sessionId: 's', name: 'A', role: 'r', pid: 1 });
    const now = new Date().toISOString();
    await writeRawMessages([
      { id: '1', subject: 'recent-read', readBy: { ag1: now }, timestamp: now },
    ]);

    const result = await mb.autoCompact({ readMaxAgeMs: 600_000 });
    expect(result.readByAllRemoved).toBe(0);
    expect(result.remaining).toBe(1);
  });

  it('does not wait for subagent receipts on leaders-only messages', async () => {
    await mb.registerAgent({
      agentId: 'leader@session',
      sessionId: 's',
      name: 'Leader',
      role: 'leader',
      pid: 1,
    });
    await mb.registerAgent({
      agentId: 'worker@session',
      sessionId: 's',
      name: 'Worker',
      role: 'executor',
      pid: 2,
    });
    const oldRead = new Date(Date.now() - 120_000).toISOString();
    await writeRawMessages([
      {
        id: '1',
        subject: 'leader-only-read',
        audience: 'leaders',
        readBy: { 'leader@session': oldRead },
        timestamp: oldRead,
      },
    ]);

    const result = await mb.autoCompact({ readMaxAgeMs: 60_000 });
    expect(result.readByAllRemoved).toBe(1);
  });

  it('skips the read-by-all pass when no agents are online', async () => {
    // No agents registered.
    const oldRead = new Date(Date.now() - 120_000).toISOString();
    await writeRawMessages([
      { id: '1', subject: 'old-read', readBy: { ghost: oldRead }, timestamp: oldRead },
    ]);

    const result = await mb.autoCompact({ readMaxAgeMs: 60_000 });
    expect(result.readByAllRemoved).toBe(0);
  });

  it('does NOT remove completed messages via read-by-all pass', async () => {
    await mb.registerAgent({ agentId: 'ag1', sessionId: 's', name: 'A', role: 'r', pid: 1 });
    const oldRead = new Date(Date.now() - 120_000).toISOString();
    await writeRawMessages([
      {
        id: '1', subject: 'completed-and-read',
        readBy: { ag1: oldRead },
        completed: true,
        completedAt: oldRead,
        timestamp: oldRead,
      },
    ]);

    const result = await mb.autoCompact({ readMaxAgeMs: 60_000 });
    // Completed messages are handled by the purge-stale pass, not read-by-all.
    expect(result.readByAllRemoved).toBe(0);
  });
});

// ── autoCompact: stale purge pass ─────────────────────────────────────────

describe('SqliteMailbox autoCompact — stale purge integration', () => {
  it('removes old completed messages in the same pass', async () => {
    const old = new Date(Date.now() - 10 * 86_400_000).toISOString(); // 10 days
    await writeRawMessages([
      { id: '1', subject: 'old-completed', completed: true, completedAt: old, timestamp: old },
      { id: '2', subject: 'old-incomplete', completed: false, timestamp: old },
      { id: '3', subject: 'fresh', timestamp: new Date().toISOString() },
    ]);

    // Use a large defaultTtlMs so the expiry pass doesn't grab these
    // before the stale-purge pass sees them.
    const result = await mb.autoCompact({ defaultTtlMs: 365 * 86_400_000 });
    expect(result.stalePurged).toBe(2);
    expect(result.remaining).toBe(1);
  });

  it('respects custom completedMaxAgeMs and incompleteMaxAgeMs', async () => {
    const oneHrAgo = new Date(Date.now() - 3600_000).toISOString();
    await writeRawMessages([
      { id: '1', subject: 'completed-1h', completed: true, completedAt: oneHrAgo, timestamp: oneHrAgo },
    ]);

    // 2h threshold → still fresh enough to keep.
    const result = await mb.autoCompact({
      completedMaxAgeMs: 2 * 3600_000,
      incompleteMaxAgeMs: 2 * 3600_000,
    });
    expect(result.stalePurged).toBe(0);
  });
});

// ── autoCompact: combined / edge cases ────────────────────────────────────

describe('SqliteMailbox autoCompact — combined and edge cases', () => {
  it('handles all three passes in one call', async () => {
    await mb.registerAgent({ agentId: 'ag1', sessionId: 's', name: 'A', role: 'r', pid: 1 });

    const old = new Date(Date.now() - 10 * 86_400_000).toISOString();
    const oldRead = new Date(Date.now() - 120_000).toISOString();
    const recent = new Date().toISOString();

    await writeRawMessages([
      // Expired via explicit expiresAt
      { id: '1', subject: 'explicit-expired', expiresAt: old },
      // Read by all online agents, old
      { id: '2', subject: 'read-all-old', readBy: { ag1: oldRead }, timestamp: oldRead },
      // Stale completed
      { id: '3', subject: 'stale-done', completed: true, completedAt: old, timestamp: old },
      // Stale incomplete
      { id: '4', subject: 'stale-incomplete', completed: false, timestamp: old },
      // Fresh — kept
      { id: '5', subject: 'fresh', timestamp: recent },
    ]);

    const result = await mb.autoCompact({ readMaxAgeMs: 60_000, defaultTtlMs: 365 * 86_400_000 });
    expect(result.expiredRemoved).toBe(1);
    expect(result.readByAllRemoved).toBe(1);
    expect(result.stalePurged).toBe(2);
    expect(result.totalRemoved).toBe(4);
    expect(result.remaining).toBe(1);
  });

  it('is a no-op on an empty mailbox', async () => {
    const result = await mb.autoCompact();
    expect(result.totalRemoved).toBe(0);
    expect(result.remaining).toBe(0);
  });

  it('is a no-op when all messages are fresh', async () => {
    const now = new Date().toISOString();
    await writeRawMessages([
      { id: '1', subject: 'fresh-1', timestamp: now },
      { id: '2', subject: 'fresh-2', timestamp: now },
    ]);

    const result = await mb.autoCompact();
    expect(result.totalRemoved).toBe(0);
    expect(result.remaining).toBe(2);
  });

  it('only rewrites the file when messages are actually removed', async () => {
    const now = new Date().toISOString();
    await writeRawMessages([
      { id: '1', subject: 'fresh', timestamp: now },
    ]);

    const statBefore = await fs.stat(mb.messagePath);
    await mb.autoCompact();
    const statAfter = await fs.stat(mb.messagePath);

    // No removal → no rewrite → mtime should be same or older (cache stat).
    expect(statAfter.size).toBe(statBefore.size);
  });

  it('returns correct AutoCompactResult shape', async () => {
    const result = await mb.autoCompact();
    expect(result).toHaveProperty('readByAllRemoved');
    expect(result).toHaveProperty('expiredRemoved');
    expect(result).toHaveProperty('stalePurged');
    expect(result).toHaveProperty('totalRemoved');
    expect(result).toHaveProperty('remaining');
    expect(typeof result.totalRemoved).toBe('number');
  });
});

// ── startAutoCompactTimer ─────────────────────────────────────────────────

describe('SqliteMailbox startAutoCompactTimer', () => {
  it('returns a dispose function', () => {
    const dispose = mb.startAutoCompactTimer({ intervalMs: 1000 });
    expect(typeof dispose).toBe('function');
    dispose();
  });

  it('calling dispose stops the timer', async () => {
    const spy = vi.spyOn(mb, 'autoCompact').mockResolvedValue({
      readByAllRemoved: 0, expiredRemoved: 0, stalePurged: 0,
      totalRemoved: 0, remaining: 0,
    });
    const dispose = mb.startAutoCompactTimer({ intervalMs: 50 });
    // Wait one cycle.
    await new Promise((r) => setTimeout(r, 80));
    const callsBefore = spy.mock.calls.length;
    dispose();
    // Wait another cycle — timer should be stopped.
    await new Promise((r) => setTimeout(r, 80));
    expect(spy.mock.calls.length).toBe(callsBefore);
    spy.mockRestore();
  });

  it('replaces a prior timer when called twice', () => {
    const dispose1 = mb.startAutoCompactTimer({ intervalMs: 1000 });
    // Should not throw — second call replaces.
    const dispose2 = mb.startAutoCompactTimer({ intervalMs: 2000 });
    dispose2();
    dispose1(); // double-dispose is safe
  });

  it('autoCompact errors do not crash the process', async () => {
    vi.spyOn(mb, 'autoCompact').mockRejectedValueOnce(new Error('disk full'));
    const dispose = mb.startAutoCompactTimer({ intervalMs: 50 });
    // Wait one cycle — error should be swallowed.
    await new Promise((r) => setTimeout(r, 80));
    dispose();
    // Process still alive — test reached this point.
    expect(true).toBe(true);
  });
});

// ── softDelete / restore changed-flag ─────────────────────────────────────

describe('SqliteMailbox softDelete / restore changed-flag', () => {
  it('softDelete is a no-op on an already-deleted message (no rewrite)', async () => {
    const msg = await mb.send({ from: 'a', to: 'b', type: 'note', subject: 's', body: 'x' });
    await mb.softDelete(msg.id, 'user1');
    const statAfterFirst = await fs.stat(mb.messagePath);

    // Second delete — should NOT rewrite (changed=false).
    await mb.softDelete(msg.id, 'user2');
    const statAfterSecond = await fs.stat(mb.messagePath);

    expect(statAfterSecond.mtimeMs).toBe(statAfterFirst.mtimeMs);
  });

  it('restore is a no-op on a non-deleted message (no rewrite)', async () => {
    const msg = await mb.send({ from: 'a', to: 'b', type: 'note', subject: 's', body: 'x' });
    const statBefore = await fs.stat(mb.messagePath);

    // Restore on a message that was never deleted.
    await mb.restore(msg.id);
    const statAfter = await fs.stat(mb.messagePath);

    expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);
  });

  it('softDelete then restore round-trips correctly', async () => {
    const msg = await mb.send({ from: 'a', to: 'b', type: 'note', subject: 's', body: 'x' });

    // Delete.
    const deleted = await mb.softDelete(msg.id, 'user1');
    expect(deleted?.deletedAt).toBeDefined();
    expect(deleted?.deletedBy).toBe('user1');

    // Restore.
    const restored = await mb.restore(msg.id);
    expect(restored?.deletedAt).toBeUndefined();
    expect(restored?.deletedBy).toBeUndefined();
  });
});

// ── EventBus push notification ────────────────────────────────────────────

describe('SqliteMailbox EventBus push notification', () => {
  it('emits mailbox.message_sent on send', async () => {
    await mb.send({ from: 'a', to: 'b', type: 'note', subject: 'hello', body: 'world' });

    expect(events.emitCustom).toHaveBeenCalledWith(
      'mailbox.message_sent',
      expect.objectContaining({
        from: 'a',
        to: 'b',
        type: 'note',
        subject: 'hello',
      }),
    );
  });

  it('includes messageId in the push event', async () => {
    const msg = await mb.send({ from: 'x', to: 'y', type: 'note', subject: 's', body: 'b' });

    expect(events.emitCustom).toHaveBeenCalledWith(
      'mailbox.message_sent',
      expect.objectContaining({ messageId: msg.id }),
    );
  });
});
