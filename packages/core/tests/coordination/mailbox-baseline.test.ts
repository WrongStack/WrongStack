/**
 * GM-P0.0 — Baseline mailbox contract fixtures and migration invariants.
 *
 * This test file locks the CURRENT supported mailbox behavior before the
 * P0 contract-repair changes. When GM-P0.1 through GM-P0.5A change the
 * contracts, these tests prove the migration preserves observable behavior.
 *
 * It uses the reusable fixture builders from `fixtures/mailbox/index.ts`
 * so downstream migration/parity/matrix test files (GM-P0.11, GM-P0.12)
 * share the same deterministic data.
 *
 * @module mailbox-baseline
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteMailbox } from '../../src/coordination/sqlite-mailbox.js';
import { resolveSendType } from '../../src/coordination/mailbox-message-codec.js';
import {
  MAILBOX_TYPE_PROPERTIES,
  isMailboxMessageVisibleTo,
} from '../../src/coordination/mailbox-types.js';
import type { EventBus } from '../../src/kernel/events.js';
import {
  FIXTURE_TIME,
  buildAllPriorities,
  buildAllRecipientForms,
  buildAllSendInputs,
  buildAllTypeMessages,
  buildCompletedMessage,
  buildCorruptLineFixture,
  buildDeletedMessage,
  buildInvalidSendInputs,
  buildLeadersOnlyMessage,
  buildMailboxJsonl,
  buildMixedV1Fixture,
  buildOrphanAckFixture,
  buildReplyThread,
  buildV1Message,
} from './fixtures/mailbox/index.js';

let dir: string;
let mb: SqliteMailbox;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailbox-baseline-'));
  mb = new SqliteMailbox(dir, undefined as unknown as EventBus);
});

afterEach(async () => {
  await mb.close().catch(() => undefined);
  // SQLite keeps `-wal`/`-shm` mapped for a moment after the handle closes.
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/**
 * Reopen the store over a legacy `_mailbox.jsonl` holding `jsonl`.
 *
 * The fixtures are v1 JSONL. There is no file to append to any more, so they
 * go in through the store's one-shot legacy import: drop the database, write
 * the retired file, reopen.
 */
async function loadLegacyFixture(jsonl: string): Promise<void> {
  await mb.close();
  const rmOptions = { force: true, maxRetries: 10, retryDelay: 50 } as const;
  for (const suffix of ['', '-wal', '-shm']) {
    await fs.rm(path.join(dir, `_mailbox.sqlite${suffix}`), rmOptions);
  }
  await fs.writeFile(path.join(dir, '_mailbox.jsonl'), jsonl);
  mb = new SqliteMailbox(dir, undefined as unknown as EventBus);
}

// ── Fixture validity ───────────────────────────────────────────────────

describe('GM-P0.0 fixture builders', () => {
  it('builds messages for every declared MailboxMessageType', () => {
    const msgs = buildAllTypeMessages({ from: 'a', to: 'b' });
    const expectedTypes = Object.keys(MAILBOX_TYPE_PROPERTIES).filter((t) => t !== 'control');
    expect(msgs.map((m) => m.type).sort()).toEqual([...expectedTypes].sort());
    expect(msgs).toHaveLength(9);
  });

  it('builds messages for every recipient form', () => {
    const forms = buildAllRecipientForms();
    expect(forms.map((f) => f.to)).toContain('agent-a');
    expect(forms.map((f) => f.to)).toContain('leader');
    expect(forms.map((f) => f.to)).toContain('@session:sess-123');
    expect(forms.map((f) => f.to)).toContain('*');
  });

  it('builds messages for every priority', () => {
    const pris = buildAllPriorities();
    expect(pris.map((p) => p.priority).sort()).toEqual(['high', 'low', 'normal']);
  });

  it('builds a reply thread with correct parent/child relationships', () => {
    const { parent, replies } = buildReplyThread('parent-1', 3);
    expect(parent.id).toBe('parent-1');
    expect(replies).toHaveLength(3);
    expect(replies.every((r) => r.replyTo === 'parent-1')).toBe(true);
  });

  it('builds leaders-only message with correct audience', () => {
    const msg = buildLeadersOnlyMessage();
    expect(msg.audience).toBe('leaders');
  });

  it('builds completed message with all completion fields', () => {
    const msg = buildCompletedMessage('agent-a');
    expect(msg.completed).toBe(true);
    expect(msg.completedBy).toBe('agent-a');
    expect(msg.completedAt).toBeDefined();
    expect(msg.outcome).toBe('resolved');
  });

  it('builds deleted message with delete fields', () => {
    const msg = buildDeletedMessage('op');
    expect(msg.deletedAt).toBeDefined();
    expect(msg.deletedBy).toBe('op');
  });

  it('serializes messages and acks to valid JSONL', () => {
    const { messages, acks, jsonl } = buildMixedV1Fixture();
    expect(messages.length).toBeGreaterThan(0);
    expect(acks.length).toBeGreaterThan(0);
    const lines = jsonl.trim().split('\n');
    expect(lines.length).toBe(messages.length + acks.length);
    // Every line is valid JSON.
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('builds corrupt-line fixture with interspersed bad JSON', () => {
    const fixture = buildCorruptLineFixture();
    const lines = fixture.trim().split('\n');
    expect(lines.length).toBe(4);
    // Lines 0 and 3 are valid JSON; lines 1 and 2 are not.
    expect(() => JSON.parse(lines[0]!)).not.toThrow();
    expect(() => JSON.parse(lines[1]!)).toThrow();
    expect(() => JSON.parse(lines[2]!)).not.toThrow(); // valid JSON object but not a valid message
    expect(() => JSON.parse(lines[3]!)).not.toThrow();
  });

  it('builds orphan-ack fixture with a dangling reference', () => {
    const fixture = buildOrphanAckFixture();
    const lines = fixture.trim().split('\n');
    expect(lines.length).toBe(2); // 1 message + 1 orphan ack
  });
});

// ── Send-input coverage ────────────────────────────────────────────────

describe('GM-P0.0 send-input fixture coverage', () => {
  it('covers every valid type × recipient-form combination', () => {
    const inputs = buildAllSendInputs();
    // 9 types × 4 recipients = 36, minus invalid combos (assign/steer to */@session = 4)
    // = 32 valid combinations.
    expect(inputs.length).toBe(32);
  });

  it('every valid input passes resolveSendType without throwing', () => {
    const inputs = buildAllSendInputs();
    for (const { label, input } of inputs) {
      expect(() => resolveSendType(input.type, input.to), `case: ${label}`).not.toThrow();
    }
  });

  it('covers every documented invalid combination', () => {
    const invalids = buildInvalidSendInputs();
    expect(invalids.length).toBe(4); // control, assign→*, steer→*, assign→@session
    for (const { label, input, errorContains } of invalids) {
      try {
        resolveSendType(input.type, input.to);
        expect.unreachable(`case "${label}" should have thrown`);
      } catch (err) {
        expect((err as Error).message.toLowerCase()).toContain(errorContains);
      }
    }
  });
});

// ── Behavioral baseline (current contract, pre-change) ─────────────────

describe('GM-P0.0 baseline: SqliteMailbox send/query/ack', () => {
  it('sends and queries a direct message', async () => {
    const msg = await mb.send({
      from: 'a',
      to: 'b',
      type: 'note',
      subject: 'direct',
      body: 'body',
    });
    const result = await mb.query({ to: 'b' });
    expect(result.map((m) => m.id)).toContain(msg.id);
    expect(result[0]!.subject).toBe('direct');
  });

  it('sends and queries a broadcast', async () => {
    await mb.send({ from: 'a', to: '*', type: 'broadcast', subject: 'broadcast', body: 'body' });
    // Broadcasts match any `to` query because `m.to === '*'` always passes.
    const forB = await mb.query({ to: 'b' });
    expect(forB.length).toBe(1);
    expect(forB[0]!.to).toBe('*');
  });

  it('sends and queries a session-scoped message', async () => {
    await mb.send({
      from: 'a',
      to: '@session',
      type: 'broadcast',
      subject: 'sess',
      body: 'body',
      senderSessionId: 'sess-1',
    });
    const scoped = await mb.query({ to: '@session:sess-1' });
    expect(scoped.length).toBe(1);
    expect(scoped[0]!.to).toBe('@session:sess-1');
  });

  it('acks a read receipt', async () => {
    const msg = await mb.send({ from: 'a', to: 'b', type: 'note', subject: 's', body: 'b' });
    await mb.ack({ messageId: msg.id, readerId: 'b', read: true });
    const unread = await mb.query({ unreadBy: 'b' });
    expect(unread.map((m) => m.id)).not.toContain(msg.id);
  });

  it('acks a completion', async () => {
    const msg = await mb.send({ from: 'a', to: 'b', type: 'note', subject: 's', body: 'b' });
    const acked = await mb.ack({
      messageId: msg.id,
      readerId: 'b',
      completed: true,
      outcome: 'done',
    });
    expect(acked?.completed).toBe(true);
    expect(acked?.completedBy).toBe('b');
    expect(acked?.outcome).toBe('done');
  });

  it('soft-deletes and restores a message', async () => {
    const msg = await mb.send({ from: 'a', to: 'b', type: 'note', subject: 's', body: 'b' });
    await mb.softDelete(msg.id, 'operator');
    const visible = await mb.query({ limit: 10 });
    expect(visible.map((m) => m.id)).not.toContain(msg.id);

    const trash = await mb.query({ includeDeleted: true, limit: 10 });
    expect(trash.map((m) => m.id)).toContain(msg.id);

    await mb.restore(msg.id);
    const restored = await mb.query({ limit: 10 });
    expect(restored.map((m) => m.id)).toContain(msg.id);
  });

  it('counts unread for direct + broadcast + session recipients', async () => {
    await mb.send({ from: 'a', to: 'agent-a', type: 'note', subject: 'direct', body: 'b' });
    await mb.send({ from: 'a', to: '*', type: 'broadcast', subject: 'broadcast', body: 'b' });
    await mb.send({
      from: 'a',
      to: '@session',
      type: 'broadcast',
      subject: 'session',
      body: 'b',
      senderSessionId: 'sess-1',
    });

    const direct = await mb.unreadCount('agent-a');
    expect(direct).toBe(2); // direct + broadcast

    const session = await mb.unreadCount('agent-a', 'sess-1');
    expect(session).toBe(3); // direct + broadcast + session
  });

  // `unreadCount` is served by a COUNT(*) predicate rather than by filtering
  // every materialized message (the pre-tool hook asks for it once a second).
  // These pin the four exclusions that predicate has to reproduce, because a
  // drift between it and `isMessageCompletedForActor` /
  // `isMailboxMessageVisibleTo` is silent — the caller only sees a number.
  it('excludes read, per-actor-completed, soft-deleted and leaders-only mail', async () => {
    const read = await mb.send({
      from: 'a',
      to: 'agent-a',
      type: 'note',
      subject: 'read',
      body: 'b',
    });
    const done = await mb.send({
      from: 'a',
      to: 'agent-a',
      type: 'ask',
      subject: 'done',
      body: 'b',
    });
    const trashed = await mb.send({
      from: 'a',
      to: 'agent-a',
      type: 'note',
      subject: 'trash',
      body: 'b',
    });
    await mb.send({
      from: 'a',
      to: 'agent-a',
      type: 'note',
      subject: 'leaders',
      body: 'b',
      audience: 'leaders',
    });
    await mb.send({ from: 'a', to: 'agent-a', type: 'note', subject: 'fresh', body: 'b' });

    await mb.ack({ messageId: read.id, readerId: 'agent-a', read: true });
    await mb.ack({ messageId: done.id, readerId: 'agent-a', completed: true });
    await mb.softDelete(trashed.id, 'agent-a');

    // Only "fresh" survives: read/completed/deleted are excluded, and
    // `agent-a` is not a leader identity so leaders-only mail is invisible.
    expect(await mb.unreadCount('agent-a')).toBe(1);
    // The recipient filter still applies to a leader: none of the five are
    // addressed to it or broadcast, so being a leader buys it nothing here.
    expect(await mb.unreadCount('leader@abc')).toBe(0);
  });

  it('counts a fan-out message another actor completed as still unread', async () => {
    const msg = await mb.send({ from: 'a', to: '*', type: 'broadcast', subject: 's', body: 'b' });
    await mb.ack({ messageId: msg.id, readerId: 'agent-b', read: true, completed: true });

    // Per-actor receipts: agent-b finishing a broadcast must not finish it for
    // agent-a. The aggregate `completed` column is not authoritative once any
    // receipt exists, which is the subtlest clause of the count predicate.
    expect(await mb.unreadCount('agent-a')).toBe(1);
    expect(await mb.unreadCount('agent-b')).toBe(0);
  });

  it('shows leaders-only mail to a leader identity', async () => {
    await mb.send({
      from: 'a',
      to: 'leader',
      type: 'note',
      subject: 'leaders',
      body: 'b',
      audience: 'leaders',
    });
    expect(await mb.unreadCount('leader@abc')).toBe(0); // addressed to the bare alias
    expect(await mb.unreadCount('leader')).toBe(1);
    expect(await mb.unreadCount('worker')).toBe(0);
  });

  it('query results are defensive copies (mutating does not affect cache)', async () => {
    await mb.send({ from: 'a', to: 'b', type: 'note', subject: 's', body: 'b' });
    const first = await mb.query({ to: 'b' });
    first[0]!.readBy['mutator'] = 'now';
    const second = await mb.query({ to: 'b' });
    expect(second[0]!.readBy).not.toHaveProperty('mutator');
  });

  it('query applies since, minPriority, incompleteOnly, and type filters', async () => {
    await mb.send({ from: 'a', to: 'b', type: 'note', subject: 's1', body: 'b', priority: 'high' });
    await mb.send({ from: 'a', to: 'b', type: 'ask', subject: 's2', body: 'b', priority: 'low' });

    expect((await mb.query({ type: 'note' })).length).toBe(1);
    expect((await mb.query({ minPriority: 'high' })).length).toBe(1);
    expect((await mb.query({ incompleteOnly: true })).length).toBe(2);
  });

  it('batch ack via ackMany marks all messages read in one operation', async () => {
    const m1 = await mb.send({ from: 'a', to: 'b', type: 'note', subject: '1', body: 'b' });
    const m2 = await mb.send({ from: 'a', to: 'b', type: 'note', subject: '2', body: 'b' });
    const updated = await mb.ackMany({
      acks: [
        { messageId: m1.id, readerId: 'b', read: true },
        { messageId: m2.id, readerId: 'b', read: true },
      ],
    });
    expect(updated.length).toBe(2);
    expect(updated.every((m) => 'b' in m.readBy)).toBe(true);
  });

  it('audience leaders filtering works', async () => {
    await mb.send({ from: 'a', to: 'leader', type: 'note', subject: 'public', body: 'b' });
    await mb.send({
      from: 'a',
      to: 'leader',
      type: 'note',
      subject: 'private',
      body: 'b',
      audience: 'leaders',
    });

    await mb.query({ unreadBy: 'worker@x' });
    // Subagent should NOT see the leaders-only message.
    expect(isMailboxMessageVisibleTo({ audience: 'leaders' }, 'worker@x')).toBe(false);
    expect(isMailboxMessageVisibleTo({ audience: 'leaders' }, 'leader')).toBe(true);
  });
});

// ── replyTo baseline (documents the BUG for GM-P0.3 to fix) ─────────────

describe('GM-P0.0 baseline: replyTo (documents current gap)', () => {
  it('persists replyTo on send', async () => {
    const parent = await mb.send({
      from: 'a',
      to: 'b',
      type: 'ask',
      subject: 'question',
      body: 'what?',
    });
    const reply = await mb.send({
      from: 'b',
      to: 'a',
      type: 'note',
      subject: 'answer',
      body: '42',
      replyTo: parent.id,
    });
    expect(reply.replyTo).toBe(parent.id);
  });

  it('query with replyTo filter returns only replies to the specified parent (GM-P0.3 fixed)', async () => {
    const parent1 = await mb.send({ from: 'a', to: 'b', type: 'ask', subject: 'q1', body: '?' });
    const parent2 = await mb.send({ from: 'a', to: 'b', type: 'ask', subject: 'q2', body: '?' });

    await mb.send({
      from: 'b',
      to: 'a',
      type: 'note',
      subject: 'r1',
      body: 'a1',
      replyTo: parent1.id,
    });
    await mb.send({
      from: 'b',
      to: 'a',
      type: 'note',
      subject: 'r2',
      body: 'a2',
      replyTo: parent2.id,
    });

    const withFilter = await mb.query({ replyTo: parent1.id });
    // Now correctly returns ONLY the reply to parent1.
    expect(withFilter).toHaveLength(1);
    expect(withFilter[0]!.subject).toBe('r1');

    const withFilter2 = await mb.query({ replyTo: parent2.id });
    expect(withFilter2).toHaveLength(1);
    expect(withFilter2[0]!.subject).toBe('r2');

    // Non-existent parent returns empty.
    const noMatch = await mb.query({ replyTo: 'nonexistent-id' });
    expect(noMatch).toHaveLength(0);
  });
});

// ── Migration fixture baseline ──────────────────────────────────────────

describe('GM-P0.0 baseline: migration fixture loads correctly', () => {
  it('loads the mixed v1 fixture into a SqliteMailbox and reads it back', async () => {
    const { jsonl } = buildMixedV1Fixture();
    await loadLegacyFixture(jsonl);

    const messages = await mb.query({ limit: 100 });
    expect(messages.length).toBeGreaterThanOrEqual(5);

    // The completed broadcast should exist and be completed (v1 behavior).
    const broadcastCompleted = messages.find((m) => m.subject === 'broadcast completed');
    expect(broadcastCompleted).toBeDefined();
    expect(broadcastCompleted!.completed).toBe(true);

    // The completed direct message should exist and be completed.
    const directCompleted = messages.find((m) => m.subject === 'direct completed');
    expect(directCompleted).toBeDefined();
    expect(directCompleted!.completed).toBe(true);
  });

  it('loads corrupt-line fixture without dropping valid messages', async () => {
    await loadLegacyFixture(buildCorruptLineFixture());
    const messages = await mb.query({ limit: 100 });
    // 2 valid messages should survive; 2 corrupt lines should be skipped.
    expect(messages.length).toBe(2);
    expect(messages.map((m) => m.subject)).toContain('before corrupt');
    expect(messages.map((m) => m.subject)).toContain('after corrupt');
  });

  it('loads orphan-ack fixture without error', async () => {
    await loadLegacyFixture(buildOrphanAckFixture());
    const messages = await mb.query({ limit: 100 });
    expect(messages.length).toBe(1);
    expect(messages[0]!.subject).toBe('has ack');
  });

  it('purgeStale removes old completed and old incomplete messages', async () => {
    const oldCompleted = buildCompletedMessage('a', {
      id: 'old-completed',
      timestamp: FIXTURE_TIME,
      completedAt: FIXTURE_TIME,
    });
    const oldIncomplete = buildV1Message({
      id: 'old-incomplete',
      timestamp: FIXTURE_TIME,
    });
    // Use a timestamp far enough in the future that the 1ms cutoff won't purge it.
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const recent = buildV1Message({ id: 'recent', timestamp: future });

    await loadLegacyFixture(buildMailboxJsonl([oldCompleted, oldIncomplete, recent]));

    const result = await mb.purgeStale({
      completedMaxAgeMs: 1,
      incompleteMaxAgeMs: 1,
    });
    expect(result.totalPurged).toBe(2);
    expect(result.remaining).toBe(1);

    const remaining = await mb.query({ limit: 100 });
    expect(remaining.map((m) => m.id)).toEqual(['recent']);
  });
});

// ── Send-input fixture matrix baseline ─────────────────────────────────

describe('GM-P0.0 baseline: all send-input types are accepted by SqliteMailbox.send()', () => {
  for (const { label, input } of buildAllSendInputs()) {
    it(`accepts ${label}`, async () => {
      const msg = await mb.send(input);
      expect(msg.id).toBeDefined();
      expect(msg.from).toBe(input.from);
    });
  }
});

describe('GM-P0.0 baseline: invalid send-inputs are rejected by resolveSendType', () => {
  for (const { label, input, errorContains } of buildInvalidSendInputs()) {
    it(`rejects ${label}`, () => {
      expect(() => resolveSendType(input.type, input.to)).toThrow(errorContains);
    });
  }
});
