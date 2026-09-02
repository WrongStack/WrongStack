/**
 * Unit tests for the pure live-feed helper used by the "Live" mode of
 * `MailboxView`. The helper wraps `groupMailboxEvents` and applies
 * filters + a single chronologically-sorted timeline.
 *
 * These mirror the contract `mailbox-grouping.test.ts` established:
 *   - Pure-function tests (no jsdom, no live `useHqStore`).
 *   - Each test reuses the `messageSummary`, `mailboxEvent`,
 *     `mailboxSnapshot` and `mailboxSummaryRecord` factories so the
 *     fixtures stay consistent across the two test files.
 */

import type {
  HqEventEnvelope,
  HqMailboxEventPayload,
  HqMailboxMessageSummary,
  HqMailboxSnapshotPayload,
  HqMailboxSummary,
} from '@wrongstack/core/hq';
import { describe, expect, it } from 'vitest';
import type { FlatMessage } from '../src/domain/mailbox-grouping.js';
import { buildLiveFeed, buildLiveFeedFromHq } from '../src/domain/mailbox-live.js';

/** Shorthand to build a FlatMessage fixture for the live feed. */
function flatOf(
  message: HqMailboxMessageSummary,
  source: 'event' | 'snapshot' = 'event',
): FlatMessage {
  return { message, source, key: `${source}:${message.mailId}` };
}

function messageSummary(overrides: Partial<HqMailboxMessageSummary>): HqMailboxMessageSummary {
  return {
    mailId: 'mail-default',
    messageId: 'm-default',
    from: 'leader',
    to: '*',
    type: 'note',
    subject: 'default',
    priority: 'normal',
    timestamp: '2026-07-03T08:00:00.000Z',
    completed: false,
    hasBody: false,
    ...overrides,
    scope: overrides.scope ?? 'project',
  };
}

function mailboxEvent(
  mailId: string,
  message: HqMailboxMessageSummary | undefined,
  projectId = 'demo',
  seq = 1,
): HqEventEnvelope<HqMailboxEventPayload> {
  return {
    id: `evt-${mailId}-${seq}`,
    type: 'mailbox.event',
    schemaVersion: 1,
    timestamp: '2026-07-03T08:00:00.000Z',
    clientId: 'client',
    projectId,
    seq,
    payload: {
      mailboxId: `${projectId}:mailbox`,
      action: 'message.sent',
      ...(message !== undefined ? { message } : {}),
    },
  };
}

function mailboxSnapshot(
  projectId: string,
  messages: readonly HqMailboxMessageSummary[],
): HqEventEnvelope<HqMailboxSnapshotPayload> {
  return {
    id: `snap-${projectId}`,
    type: 'mailbox.snapshot',
    schemaVersion: 1,
    timestamp: '2026-07-03T08:00:00.000Z',
    clientId: 'client',
    projectId,
    seq: 0,
    payload: {
      mailboxId: `${projectId}:mailbox`,
      scope: 'project',
      messages,
      agents: [],
      totals: {
        messages: messages.length,
        unread: 0,
        incomplete: messages.length,
        highPriority: 0,
        onlineAgents: 0,
      },
    },
  };
}

function mailboxSummaryRecord(
  projectId: string,
  overrides: Partial<HqMailboxSummary>,
): HqMailboxSummary {
  return {
    mailboxId: `${projectId}:mailbox`,
    projectId,
    scope: 'project',
    messageCount: 0,
    unreadCount: 0,
    incompleteCount: 0,
    highPriorityCount: 0,
    onlineAgentCount: 0,
    lastActivityAt: '2026-07-03T08:00:00.000Z',
    ...overrides,
  };
}

describe('buildLiveFeed', () => {
  it('returns an empty timeline when the input is empty', () => {
    const result = buildLiveFeed([], {});
    expect(result.entries).toEqual([]);
    expect(result.totalMatched).toBe(0);
    expect(result.returned).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it('sorts messages newest-first', () => {
    const a = messageSummary({
      mailId: 'a',
      messageId: 'a',
      timestamp: '2026-07-03T08:00:00.000Z',
      subject: 'a',
    });
    const b = messageSummary({
      mailId: 'b',
      messageId: 'b',
      timestamp: '2026-07-03T09:00:00.000Z',
      subject: 'b',
    });
    const c = messageSummary({
      mailId: 'c',
      messageId: 'c',
      timestamp: '2026-07-03T10:00:00.000Z',
      subject: 'c',
    });
    // Feed deliberately unsorted.
    const flat = [flatOf(a), flatOf(c), flatOf(b)];
    const { entries } = buildLiveFeed(flat, {});
    expect(entries.map((e) => e.flat.message.subject)).toEqual(['c', 'b', 'a']);
  });

  it('breaks ties on equal timestamps by mailId (deterministic order)', () => {
    const a = messageSummary({
      mailId: 'z',
      messageId: 'm-z',
      timestamp: '2026-07-03T08:00:00.000Z',
      subject: 'z',
    });
    const b = messageSummary({
      mailId: 'a',
      messageId: 'm-a',
      timestamp: '2026-07-03T08:00:00.000Z',
      subject: 'a',
    });
    const flat = [flatOf(a), flatOf(b)];
    const { entries } = buildLiveFeed(flat, {});
    // 'a' < 'z' lexicographically → 'a' first.
    expect(entries.map((e) => e.flat.message.mailId)).toEqual(['a', 'z']);
  });

  it('filters by type', () => {
    const note = messageSummary({ mailId: 'n', messageId: 'n', type: 'note' });
    const ask = messageSummary({ mailId: 'a', messageId: 'a', type: 'ask' });
    const result = messageSummary({ mailId: 'r', messageId: 'r', type: 'result' });
    const flat = [flatOf(note), flatOf(ask), flatOf(result)];
    const { entries } = buildLiveFeed(flat, { types: ['ask', 'result'] });
    expect(entries.map((e) => e.flat.message.mailId).sort()).toEqual(['a', 'r']);
  });

  it('filters by priority', () => {
    const high = messageSummary({ mailId: 'h', messageId: 'h', priority: 'high' });
    const low = messageSummary({ mailId: 'l', messageId: 'l', priority: 'low' });
    const normal = messageSummary({
      mailId: 'n',
      messageId: 'n',
      priority: 'normal',
    });
    const flat = [flatOf(high), flatOf(low), flatOf(normal)];
    const { entries } = buildLiveFeed(flat, { priorities: ['high'] });
    expect(entries.map((e) => e.flat.message.mailId)).toEqual(['h']);
  });

  it('hides completed messages when includeCompleted=false', () => {
    const open = messageSummary({
      mailId: 'o',
      messageId: 'o',
      completed: false,
    });
    const done = messageSummary({
      mailId: 'd',
      messageId: 'd',
      completed: true,
    });
    const flat = [flatOf(open), flatOf(done)];
    expect(buildLiveFeed(flat, {}).entries.map((e) => e.flat.message.mailId)).toEqual(['d', 'o']);
    expect(
      buildLiveFeed(flat, { includeCompleted: false }).entries.map((e) => e.flat.message.mailId),
    ).toEqual(['o']);
  });

  it('applies a case-insensitive substring filter across subject/from/to/bodyPreview', () => {
    const s1 = messageSummary({
      mailId: 's1',
      messageId: 's1',
      subject: 'Deploy failed',
      from: 'agent-1',
      to: 'leader',
      bodyPreview: 'stack trace attached',
    });
    const s2 = messageSummary({
      mailId: 's2',
      messageId: 's2',
      subject: 'Build OK',
      from: 'agent-2',
      to: '*',
      bodyPreview: 'no issues',
    });
    const flat = [flatOf(s1), flatOf(s2)];
    // Subject match.
    expect(
      buildLiveFeed(flat, { query: 'deploy' }).entries.map((e) => e.flat.message.mailId),
    ).toEqual(['s1']);
    // From-field match.
    expect(
      buildLiveFeed(flat, { query: 'AGENT-2' }).entries.map((e) => e.flat.message.mailId),
    ).toEqual(['s2']);
    // Body preview match.
    expect(
      buildLiveFeed(flat, { query: 'stack' }).entries.map((e) => e.flat.message.mailId),
    ).toEqual(['s1']);
    // No match.
    expect(buildLiveFeed(flat, { query: 'xyz' }).entries).toEqual([]);
  });

  it('truncates to `limit` and reports totalMatched + truncated=true', () => {
    const flat = Array.from({ length: 50 }, (_, i) => {
      const m = messageSummary({
        mailId: `m${i}`,
        messageId: `m${i}`,
        timestamp: `2026-07-03T08:${i.toString().padStart(2, '0')}:00.000Z`,
      });
      return flatOf(m);
    });
    const r = buildLiveFeed(flat, { limit: 10 });
    expect(r.totalMatched).toBe(50);
    expect(r.returned).toBe(10);
    expect(r.truncated).toBe(true);
    expect(r.entries).toHaveLength(10);
  });

  it('returns `truncated=false` when result is within limit', () => {
    const flat = [flatOf(messageSummary({ mailId: 'x', messageId: 'x' }))];
    const r = buildLiveFeed(flat, { limit: 10 });
    expect(r.truncated).toBe(false);
  });

  it('filters by projectIds — all messages are skipped (line 111 continue)', () => {
    // buildLiveFeed does not have projectId on the message itself; when
    // projectIds is set, every message is skipped and the result is empty.
    const a = messageSummary({ mailId: 'a', messageId: 'a' });
    const b = messageSummary({ mailId: 'b', messageId: 'b' });
    const flat = [flatOf(a), flatOf(b)];
    const { entries, totalMatched } = buildLiveFeed(flat, { projectIds: ['proj-x'] });
    expect(entries).toHaveLength(0);
    expect(totalMatched).toBe(0);
  });

  it('combines multiple filters with AND semantics', () => {
    const matches = messageSummary({
      mailId: 'matches',
      messageId: 'matches',
      type: 'ask',
      priority: 'high',
      completed: false,
      subject: 'review please',
    });
    const wrongType = messageSummary({
      mailId: 'wrong-type',
      messageId: 'wrong-type',
      type: 'note',
      priority: 'high',
      completed: false,
    });
    const wrongPriority = messageSummary({
      mailId: 'wrong-prio',
      messageId: 'wrong-prio',
      type: 'ask',
      priority: 'low',
      completed: false,
    });
    const wrongCompleted = messageSummary({
      mailId: 'wrong-done',
      messageId: 'wrong-done',
      type: 'ask',
      priority: 'high',
      completed: true,
    });
    const wrongQuery = messageSummary({
      mailId: 'wrong-q',
      messageId: 'wrong-q',
      type: 'ask',
      priority: 'high',
      completed: false,
      subject: 'unrelated',
    });
    const flat = [matches, wrongType, wrongPriority, wrongCompleted, wrongQuery].map((m) =>
      flatOf(m),
    );
    const r = buildLiveFeed(flat, {
      types: ['ask'],
      priorities: ['high'],
      includeCompleted: false,
      query: 'review',
    });
    expect(r.entries.map((e) => e.flat.message.mailId)).toEqual(['matches']);
  });
});

describe('buildLiveFeedFromHq', () => {
  it('flattens across projects by default', () => {
    const events: HqEventEnvelope[] = [
      mailboxEvent(
        'a',
        messageSummary({
          mailId: 'a',
          messageId: 'a',
          from: 'x',
          subject: 'A',
          timestamp: '2026-07-03T09:00:00.000Z',
        }),
        'proj-a',
      ),
      mailboxEvent(
        'b',
        messageSummary({
          mailId: 'b',
          messageId: 'b',
          from: 'y',
          subject: 'B',
          timestamp: '2026-07-03T10:00:00.000Z',
        }),
        'proj-b',
      ),
    ];
    const r = buildLiveFeedFromHq(null, events, {});
    expect(r.entries).toHaveLength(2);
    // Newest first.
    expect(r.entries.map((e) => e.flat.message.mailId)).toEqual(['b', 'a']);
  });

  it('restricts to projectIds when provided', () => {
    const events: HqEventEnvelope[] = [
      mailboxEvent('a', messageSummary({ mailId: 'a', messageId: 'a' }), 'proj-a'),
      mailboxEvent('b', messageSummary({ mailId: 'b', messageId: 'b' }), 'proj-b'),
      mailboxEvent('c', messageSummary({ mailId: 'c', messageId: 'c' }), 'proj-a'),
    ];
    const r = buildLiveFeedFromHq(null, events, { projectIds: ['proj-a'] });
    expect(r.entries.map((e) => e.flat.message.mailId).sort()).toEqual(['a', 'c']);
  });

  it('uses the same dedup+counter resolution as the grouped view', () => {
    // Same scenario as mailbox-grouping.test.ts "dedupes by mailId":
    // snapshot has mailId=dup, event has fresh mailId=dup with later
    // timestamp. The live feed must show ONE entry (the fresh event).
    const m = messageSummary({
      mailId: 'dup',
      messageId: 'dup',
      timestamp: '2026-07-03T08:00:00.000Z',
    });
    const fresh = messageSummary({
      mailId: 'dup',
      messageId: 'dup',
      timestamp: '2026-07-03T09:00:00.000Z',
    });
    const events: HqEventEnvelope[] = [
      mailboxSnapshot('demo', [m]),
      mailboxEvent('dup', fresh, 'demo'),
    ];
    const r = buildLiveFeedFromHq(null, events, {});
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]?.flat.message.timestamp).toBe('2026-07-03T09:00:00.000Z');
    expect(r.entries[0]?.flat.source).toBe('event');
  });

  it('respects snapshot seed counter even when only one event streamed', () => {
    // Mirror of mailbox-grouping's "keeps snapshot counters authoritative":
    // the live feed's underlying `groupMailboxEvents` honours the
    // snapshot's totals, so the live feed derives the same set of
    // unique messages. We assert the entry count here, not the
    // counters, because the live feed doesn't surface per-project
    // counters in this minimal contract.
    const snapshot = {
      mailboxes: [mailboxSummaryRecord('demo', { messageCount: 5, incompleteCount: 4 })],
    };
    const events: HqEventEnvelope[] = [
      mailboxEvent('one', messageSummary({ mailId: 'one', messageId: 'one' }), 'demo'),
    ];
    const r = buildLiveFeedFromHq(snapshot, events, {});
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]?.flat.message.mailId).toBe('one');
  });
});
