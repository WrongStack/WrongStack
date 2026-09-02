/**
 * Unit tests for the pure mailbox-event grouping helper used by
 * `MailboxView`. These cover the behaviors the UI relies on:
 *   - Per-project grouping (snapshot + event stream stay merged)
 *   - Dedupe by mailId, preferring the event copy when both arrive
 *   - Newest-first sort within each project
 *   - Counter source-of-truth (snapshot wins; derive only when absent)
 *   - Graceful handling of unrelated event types (filtered out silently)
 */

import type {
  HqEventEnvelope,
  HqMailboxEventPayload,
  HqMailboxMessageSummary,
  HqMailboxSnapshotPayload,
  HqMailboxSummary,
} from '@wrongstack/core/hq';
import { describe, expect, it } from 'vitest';
import { groupMailboxEvents } from '../src/domain/mailbox-grouping.js';

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

describe('groupMailboxEvents', () => {
  it('returns an empty list when both snapshot and events are empty', () => {
    const result = groupMailboxEvents(null, []);
    expect(result.projects).toEqual([]);
    expect(result.hasAnyActivity).toBe(false);
  });

  it('seeds counters from the snapshot aggregate and renders its message list', () => {
    const snapshot = {
      mailboxes: [
        mailboxSummaryRecord('demo', {
          messageCount: 2,
          unreadCount: 1,
          incompleteCount: 2,
          highPriorityCount: 1,
          onlineAgentCount: 3,
        }),
      ],
    };
    const m1 = messageSummary({
      mailId: 'm1',
      messageId: 'm1',
      priority: 'high',
      subject: 'urgent',
    });
    const m2 = messageSummary({ mailId: 'm2', messageId: 'm2', subject: 'normal' });
    const events: HqEventEnvelope[] = [mailboxSnapshot('demo', [m1, m2])];

    const { projects, hasAnyActivity } = groupMailboxEvents(snapshot, events);
    expect(projects).toHaveLength(1);
    expect(projects[0]?.projectId).toBe('demo');
    expect(projects[0]?.highPriorityCount).toBe(1);
    expect(projects[0]?.unreadCount).toBe(1);
    expect(projects[0]?.incompleteCount).toBe(2);
    expect(projects[0]?.onlineAgentCount).toBe(3);
    expect(projects[0]?.countersFromSnapshot).toBe(true);
    expect(projects[0]?.messages.map((m) => m.message.mailId)).toEqual(['m1', 'm2']);
    expect(hasAnyActivity).toBe(true);
  });

  it('groups messages from multiple projects independently', () => {
    const events: HqEventEnvelope[] = [
      mailboxEvent(
        'a',
        messageSummary({ mailId: 'a', messageId: 'a', from: 'x', subject: 'A' }),
        'proj-a',
        1,
      ),
      mailboxEvent(
        'b',
        messageSummary({ mailId: 'b', messageId: 'b', from: 'y', subject: 'B' }),
        'proj-b',
        1,
      ),
      mailboxEvent(
        'c',
        messageSummary({ mailId: 'c', messageId: 'c', from: 'z', subject: 'C' }),
        'proj-a',
        2,
      ),
    ];
    const { projects } = groupMailboxEvents(null, events);
    expect(projects).toHaveLength(2);
    const projA = projects.find((p) => p.projectId === 'proj-a');
    const projB = projects.find((p) => p.projectId === 'proj-b');
    expect(projA?.messages.map((m) => m.message.mailId).sort()).toEqual(['a', 'c']);
    expect(projB?.messages.map((m) => m.message.mailId)).toEqual(['b']);
  });

  it('dedupes by mailId when the same message arrives via snapshot AND event', () => {
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
      mailboxEvent('dup', fresh, 'demo', 1),
    ];
    const { projects } = groupMailboxEvents(null, events);
    expect(projects[0]?.messages).toHaveLength(1);
    expect(projects[0]?.messages[0]?.source).toBe('event');
    expect(projects[0]?.messages[0]?.message.timestamp).toBe('2026-07-03T09:00:00.000Z');
  });

  it('keeps only the first event when the same mailId arrives twice via events', () => {
    const a = messageSummary({
      mailId: 'same',
      messageId: 'same',
      timestamp: '2026-07-03T08:00:00.000Z',
    });
    const b = messageSummary({
      mailId: 'same',
      messageId: 'same',
      timestamp: '2026-07-03T09:00:00.000Z',
    });
    const events: HqEventEnvelope[] = [
      mailboxEvent('same', a, 'demo', 1),
      mailboxEvent('same', b, 'demo', 2),
    ];
    const { projects } = groupMailboxEvents(null, events);
    expect(projects[0]?.messages).toHaveLength(1);
    // First-seen wins within the event stream (mailIndex dedupe is one-shot).
    expect(projects[0]?.messages[0]?.message.timestamp).toBe('2026-07-03T08:00:00.000Z');
  });

  it('sorts messages newest-first within each project', () => {
    const old = messageSummary({
      mailId: 'old',
      messageId: 'old',
      timestamp: '2026-07-03T07:00:00.000Z',
      subject: 'old',
    });
    const mid = messageSummary({
      mailId: 'mid',
      messageId: 'mid',
      timestamp: '2026-07-03T08:00:00.000Z',
      subject: 'mid',
    });
    const fresh = messageSummary({
      mailId: 'fresh',
      messageId: 'fresh',
      timestamp: '2026-07-03T09:00:00.000Z',
      subject: 'fresh',
    });
    const events: HqEventEnvelope[] = [
      mailboxEvent('old', old, 'demo', 1),
      mailboxEvent('fresh', fresh, 'demo', 2),
      mailboxEvent('mid', mid, 'demo', 3),
    ];
    const { projects } = groupMailboxEvents(null, events);
    expect(projects[0]?.messages.map((m) => m.message.subject)).toEqual(['fresh', 'mid', 'old']);
  });

  it('sorts projects by their newest message timestamp', () => {
    const events: HqEventEnvelope[] = [
      mailboxEvent(
        'a-old',
        messageSummary({
          mailId: 'a-old',
          messageId: 'a-old',
          timestamp: '2026-07-03T07:00:00.000Z',
        }),
        'proj-a',
        1,
      ),
      mailboxEvent(
        'b-new',
        messageSummary({
          mailId: 'b-new',
          messageId: 'b-new',
          timestamp: '2026-07-03T10:00:00.000Z',
        }),
        'proj-b',
        1,
      ),
      mailboxEvent(
        'a-new',
        messageSummary({
          mailId: 'a-new',
          messageId: 'a-new',
          timestamp: '2026-07-03T09:00:00.000Z',
        }),
        'proj-a',
        2,
      ),
    ];
    const { projects } = groupMailboxEvents(null, events);
    expect(projects.map((p) => p.projectId)).toEqual(['proj-b', 'proj-a']);
  });

  it('ignores events of unrelated types', () => {
    const ok = messageSummary({ mailId: 'ok', messageId: 'ok' });
    const events: HqEventEnvelope[] = [
      mailboxEvent('ok', ok, 'demo', 1),
      // Unrelated event types must not pollute the grouping.
      {
        id: 'evt-other-1',
        type: 'brain.event',
        schemaVersion: 1,
        timestamp: '2026-07-03T08:00:00.000Z',
        clientId: 'client',
        projectId: 'demo',
        seq: 2,
        payload: { kind: 'decision_requested', at: Date.now() },
      },
      {
        id: 'evt-other-2',
        type: 'fleet.snapshot',
        schemaVersion: 1,
        timestamp: '2026-07-03T08:00:00.000Z',
        clientId: 'client',
        projectId: 'demo',
        seq: 3,
        payload: {
          runId: 'r1',
          activeSubagents: 0,
          queuedTasks: 0,
          completedTasks: 0,
          failedTasks: 0,
          subagents: [],
        },
      },
    ];
    const { projects, hasAnyActivity } = groupMailboxEvents(null, events);
    expect(projects).toHaveLength(1);
    expect(projects[0]?.messages.map((m) => m.message.mailId)).toEqual(['ok']);
    expect(hasAnyActivity).toBe(true);
  });

  it('skips mailbox.event envelopes with malformed payloads without crashing', () => {
    const good = messageSummary({ mailId: 'good', messageId: 'good' });
    const events: HqEventEnvelope[] = [
      mailboxEvent('good', good, 'demo', 1),
      {
        id: 'evt-malformed',
        type: 'mailbox.event',
        schemaVersion: 1,
        timestamp: '2026-07-03T08:00:00.000Z',
        clientId: 'client',
        projectId: 'demo',
        seq: 2,
        payload: { unrelated: true },
      },
    ];
    const { projects } = groupMailboxEvents(null, events);
    expect(projects[0]?.messages).toHaveLength(1);
    expect(projects[0]?.messages[0]?.message.mailId).toBe('good');
  });

  it('derives counters from messages when no snapshot aggregate is present', () => {
    const events: HqEventEnvelope[] = [
      mailboxEvent(
        'h',
        messageSummary({ mailId: 'h', messageId: 'h', priority: 'high' }),
        'demo',
        1,
      ),
      mailboxEvent('u', messageSummary({ mailId: 'u', messageId: 'u' }), 'demo', 2),
      mailboxEvent(
        'd',
        messageSummary({ mailId: 'd', messageId: 'd', completed: true }),
        'demo',
        3,
      ),
    ];
    const { projects } = groupMailboxEvents(null, events);
    expect(projects[0]?.highPriorityCount).toBe(1);
    // Both 'h' and 'u' are incomplete, 'd' is completed → 2 incomplete.
    expect(projects[0]?.incompleteCount).toBe(2);
    // 'h' and 'u' both have readCount=0 (default) → 2 unread.
    expect(projects[0]?.unreadCount).toBe(2);
    expect(projects[0]?.countersFromSnapshot).toBe(false);
  });

  it('keeps snapshot counters authoritative even when detail messages overlap', () => {
    // Snapshot says: 5 high-priority, 4 incomplete. Only one of those
    // messages has streamed via mailbox.event, but we must NOT derive
    // counters from it and overwrite the snapshot's totals.
    const snapshot = {
      mailboxes: [
        mailboxSummaryRecord('demo', {
          messageCount: 5,
          unreadCount: 2,
          incompleteCount: 4,
          highPriorityCount: 5,
          onlineAgentCount: 1,
        }),
      ],
    };
    const events: HqEventEnvelope[] = [
      mailboxEvent(
        'one',
        messageSummary({ mailId: 'one', messageId: 'one', priority: 'high' }),
        'demo',
        1,
      ),
    ];
    const { projects } = groupMailboxEvents(snapshot, events);
    expect(projects[0]?.highPriorityCount).toBe(5);
    expect(projects[0]?.incompleteCount).toBe(4);
    expect(projects[0]?.unreadCount).toBe(2);
    expect(projects[0]?.countersFromSnapshot).toBe(true);
  });

  it('treats agent.online mailbox events as online-agent count bumps (snapshot absent)', () => {
    const events: HqEventEnvelope[] = [
      {
        id: 'evt-agent-1',
        type: 'mailbox.event',
        schemaVersion: 1,
        timestamp: '2026-07-03T08:00:00.000Z',
        clientId: 'client',
        projectId: 'demo',
        seq: 1,
        payload: {
          mailboxId: 'demo:mailbox',
          action: 'agent.registered',
          agent: {
            agentId: 'a1',
            name: 'worker-1',
            sessionId: 'sess-1',
            status: 'running',
            iterations: 0,
            toolCalls: 0,
            lastActivityAt: '2026-07-03T08:00:00.000Z',
            lastSeenAt: '2026-07-03T08:00:00.000Z',
            online: true,
          },
        },
      },
      {
        id: 'evt-agent-2',
        type: 'mailbox.event',
        schemaVersion: 1,
        timestamp: '2026-07-03T08:00:01.000Z',
        clientId: 'client',
        projectId: 'demo',
        seq: 2,
        payload: {
          mailboxId: 'demo:mailbox',
          action: 'agent.offline',
          agent: {
            agentId: 'a1',
            name: 'worker-1',
            sessionId: 'sess-1',
            status: 'offline',
            iterations: 0,
            toolCalls: 0,
            lastActivityAt: '2026-07-03T08:00:01.000Z',
            lastSeenAt: '2026-07-03T08:00:01.000Z',
            online: false,
          },
        },
      },
    ];
    const { projects } = groupMailboxEvents(null, events);
    // Only the online=true event should bump the count.
    expect(projects[0]?.onlineAgentCount).toBe(1);
  });

  it('returns hasAnyActivity=true only when at least one group has messages', () => {
    // Snapshot tells us about a project, but no detail events have streamed.
    const snapshot = {
      mailboxes: [mailboxSummaryRecord('demo', { messageCount: 5 })],
    };
    const { hasAnyActivity } = groupMailboxEvents(snapshot, []);
    expect(hasAnyActivity).toBe(false);
  });

  it('handles readCount > 0 in derived counters (unread is not incremented)', () => {
    const events: HqEventEnvelope[] = [
      mailboxEvent(
        'read-msg',
        messageSummary({ mailId: 'read-msg', messageId: 'read-msg', completed: false, readCount: 2 }),
        'demo',
        1,
      ),
    ];
    const { projects } = groupMailboxEvents(null, events);
    // Message is incomplete but has readCount > 0 → not unread.
    expect(projects[0]?.incompleteCount).toBe(1);
    expect(projects[0]?.unreadCount).toBe(0);
  });
});
