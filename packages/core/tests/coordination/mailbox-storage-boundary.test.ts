/**
 * GM-P0.5 + GM-P0.5A — Tests for storage-boundary enforcement and actor-bearing APIs.
 *
 * Verifies:
 *   - validateSendType() is called inside GlobalMailbox.send() (storage boundary)
 *   - Actor-bearing methods (sendFor, ackFor, queryFor, softDeleteFor, restoreFor)
 *     stamp identity from the actor context, not from the input
 *   - Visibility checks prevent actors from acking/deleting invisible messages
 *   - Invalid type/recipient combos are rejected even through direct calls
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GlobalMailbox } from '../../src/coordination/global-mailbox.js';
import type { EventBus } from '../../src/kernel/events.js';
import type { MailboxActorContext } from '../../src/coordination/mailbox-types.js';

let dir: string;
let mb: GlobalMailbox;
const events = { emitCustom: () => {} };

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailbox-storage-'));
  mb = new GlobalMailbox(dir, events as never as EventBus);
});

afterEach(async () => {
  await mb.close();
  await fs.rm(dir, { recursive: true, force: true });
});

function actor(overrides: Partial<MailboxActorContext> = {}): MailboxActorContext {
  return {
    actorId: 'leader@sess-1',
    projectId: 'test',
    kind: 'agent',
    capabilities: new Set([
      'mail.send.informational',
      'mail.send.actionable',
      'mail.read.self',
      'mail.ack.self',
    ]),
    authMode: 'identity-token',
    recipientAliases: new Set(['leader']),
    sessionId: 'sess-1',
    role: 'leader',
    ...overrides,
  };
}

// ── Storage-boundary enforcement ─────────────────────────────────────

describe('GM-P0.5A: storage-boundary enforcement', () => {
  it('rejects control type at the storage boundary (direct send)', async () => {
    await expect(
      mb.send({ from: 'a', to: 'b', type: 'control', subject: 's', body: 'b' }),
    ).rejects.toThrow('control');
  });

  it('rejects assign to broadcast at the storage boundary', async () => {
    await expect(
      mb.send({ from: 'a', to: '*', type: 'assign', subject: 's', body: 'b' }),
    ).rejects.toThrow('assign');
  });

  it('rejects steer to broadcast at the storage boundary', async () => {
    await expect(
      mb.send({ from: 'a', to: '*', type: 'steer', subject: 's', body: 'b' }),
    ).rejects.toThrow('steer');
  });

  it('rejects assign to session broadcast at the storage boundary', async () => {
    await expect(
      mb.send({
        from: 'a', to: '@session:s1', type: 'assign',
        subject: 's', body: 'b', senderSessionId: 's1',
      }),
    ).rejects.toThrow('assign');
  });

  it('accepts valid type/recipient at the storage boundary', async () => {
    const msg = await mb.send({
      from: 'a', to: 'b', type: 'note', subject: 's', body: 'b',
    });
    expect(msg.type).toBe('note');
  });

  it('accepts broadcast type for multi-recipient', async () => {
    const msg = await mb.send({
      from: 'a', to: '*', type: 'broadcast', subject: 's', body: 'b',
    });
    expect(msg.type).toBe('broadcast');
  });
});

// ── sendFor: actor stamps from/senderSessionId ────────────────────────

describe('GM-P0.5A: sendFor stamps identity from actor', () => {
  it('stamps from from actor.actorId', async () => {
    const msg = await mb.sendFor(actor(), {
      to: 'worker', type: 'note', subject: 's', body: 'b',
    });
    expect(msg.from).toBe('leader@sess-1');
  });

  it('stamps senderSessionId from actor.sessionId', async () => {
    const msg = await mb.sendFor(actor({ sessionId: 'sess-99' }), {
      to: '@session', type: 'broadcast', subject: 's', body: 'b',
    });
    expect(msg.to).toBe('@session:sess-99');
    expect(msg.senderSessionId).toBe('sess-99');
  });

  it('ignores body-supplied from (actor wins)', async () => {
    const msg = await mb.sendFor(actor({ actorId: 'real@a1' }), {
      // @ts-expect-error — from is omitted from the input type
      from: 'attacker',
      to: 'worker', type: 'note', subject: 's', body: 'b',
    });
    expect(msg.from).toBe('real@a1');
  });

  it('still enforces validateSendType at the boundary', async () => {
    await expect(
      mb.sendFor(actor(), { to: '*', type: 'control', subject: 's', body: 'b' }),
    ).rejects.toThrow('control');
  });
});

// ── ackFor: visibility check + readerId from actor ───────────────────

describe('GM-P0.5A: ackFor checks visibility and stamps readerId', () => {
  it('stamps readerId from actor', async () => {
    const msg = await mb.send({
      from: 'a', to: 'leader@sess-1', type: 'note', subject: 's', body: 'b',
    });
    const acked = await mb.ackFor(actor(), { messageId: msg.id, read: true });
    expect(acked).not.toBeNull();
    expect(acked!.readBy['leader@sess-1']).toBeDefined();
  });

  it('returns null for non-existent message', async () => {
    const result = await mb.ackFor(actor(), { messageId: 'no-such-id' });
    expect(result).toBeNull();
  });

  it('returns null (NOT_FOUND) for leaders-only message from non-leader', async () => {
    const msg = await mb.send({
      from: 'a', to: '*', type: 'broadcast', subject: 'secret',
      body: 'b', audience: 'leaders',
    });
    const nonLeader = actor({
      actorId: 'worker@s2', role: 'worker',
      recipientAliases: new Set(['worker']),
    });
    const result = await mb.ackFor(nonLeader, { messageId: msg.id, read: true });
    expect(result).toBeNull();
  });

  it('allows leader to ack leaders-only message', async () => {
    const msg = await mb.send({
      from: 'a', to: '*', type: 'broadcast', subject: 'secret',
      body: 'b', audience: 'leaders',
    });
    const result = await mb.ackFor(actor(), { messageId: msg.id, read: true });
    expect(result).not.toBeNull();
  });
});

// ── queryFor: derives readerRole from actor ──────────────────────────

describe('GM-P0.5A: queryFor derives readerRole from actor', () => {
  it('returns messages visible to the actor', async () => {
    await mb.send({
      from: 'a', to: 'leader@sess-1', type: 'note', subject: 's', body: 'b',
    });
    const results = await mb.queryFor(actor());
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it('filters leaders-only messages for non-leader actors', async () => {
    await mb.send({
      from: 'a', to: '*', type: 'broadcast', subject: 'secret',
      body: 'b', audience: 'leaders',
    });
    await mb.send({
      from: 'a', to: '*', type: 'broadcast', subject: 'public', body: 'b',
    });
    const nonLeader = actor({
      actorId: 'worker@s2', role: 'worker',
      recipientAliases: new Set(['worker']),
    });
    const results = await mb.queryFor(nonLeader);
    expect(results.map((m) => m.subject)).not.toContain('secret');
    expect(results.map((m) => m.subject)).toContain('public');
  });
});

// ── softDeleteFor / restoreFor: visibility check ─────────────────────

describe('GM-P0.5A: softDeleteFor checks visibility', () => {
  it('soft-deletes a visible message', async () => {
    const msg = await mb.send({
      from: 'a', to: 'leader@sess-1', type: 'note', subject: 's', body: 'b',
    });
    const result = await mb.softDeleteFor(actor(), msg.id);
    expect(result).not.toBeNull();
    expect(result!.deletedAt).toBeDefined();
  });

  it('returns null for invisible message', async () => {
    const msg = await mb.send({
      from: 'a', to: '*', type: 'broadcast', subject: 'secret',
      body: 'b', audience: 'leaders',
    });
    const nonLeader = actor({
      actorId: 'worker@s2', role: 'worker',
      recipientAliases: new Set(['worker']),
    });
    const result = await mb.softDeleteFor(nonLeader, msg.id);
    expect(result).toBeNull();
  });
});

describe('GM-P0.5A: restoreFor checks visibility', () => {
  it('restores a visible message', async () => {
    const msg = await mb.send({
      from: 'a', to: 'leader@sess-1', type: 'note', subject: 's', body: 'b',
    });
    await mb.softDelete(msg.id, 'leader@sess-1');
    const result = await mb.restoreFor(actor(), msg.id);
    expect(result).not.toBeNull();
    expect(result!.deletedAt).toBeUndefined();
  });

  it('returns null for invisible message', async () => {
    const msg = await mb.send({
      from: 'a', to: '*', type: 'broadcast', subject: 'secret',
      body: 'b', audience: 'leaders',
    });
    await mb.softDelete(msg.id, 'leader@sess-1');
    const nonLeader = actor({
      actorId: 'worker@s2', role: 'worker',
      recipientAliases: new Set(['worker']),
    });
    const result = await mb.restoreFor(nonLeader, msg.id);
    expect(result).toBeNull();
  });
});

// ── Regression: existing methods still work ──────────────────────────

describe('GM-P0.5A regression: legacy methods still work', () => {
  it('send (legacy) still works for valid input', async () => {
    const msg = await mb.send({
      from: 'a', to: 'b', type: 'note', subject: 's', body: 'b',
    });
    expect(msg.id).toBeDefined();
  });

  it('ack (legacy) still works', async () => {
    const msg = await mb.send({
      from: 'a', to: 'b', type: 'note', subject: 's', body: 'b',
    });
    const result = await mb.ack({
      messageId: msg.id, readerId: 'b', read: true,
    });
    expect(result).not.toBeNull();
  });

  it('query (legacy) still works', async () => {
    await mb.send({ from: 'a', to: 'b', type: 'note', subject: 's', body: 'b' });
    const results = await mb.query({ to: 'b' });
    expect(results.length).toBeGreaterThanOrEqual(1);
  });
});
