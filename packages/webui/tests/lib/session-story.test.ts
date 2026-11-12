import { describe, expect, it } from 'vitest';
import { buildSessionStory } from '../../src/lib/session-story';
import type { MailboxMessage } from '../../src/stores/mailbox-store';
import type { SubagentView } from '../../src/stores/types';
import type { ChronicleEventView } from '../../src/types';

const base = Date.parse('2026-10-02T12:00:00Z');
const record = (
  eventId: string,
  eventType: string,
  extra: Partial<ChronicleEventView> = {},
): ChronicleEventView => ({
  schemaVersion: 1,
  eventId,
  eventType,
  observedAt: new Date(base).toISOString(),
  persistedAt: new Date(base).toISOString(),
  sequence: 1,
  hash: '',
  previousHash: '',
  scope: { sessionId: 'tab-a', agentId: 'leader-a' },
  correlation: {},
  ...extra,
});
const agent = (id: string, sessionId = 'tab-a'): SubagentView => ({
  id,
  sessionId,
  name: id,
  status: 'completed',
  iteration: 1,
  toolCalls: 2,
  costUsd: 0,
  ctxPct: 0,
  ctxTokens: 0,
  maxContext: 1,
  extensions: 0,
  startedAt: base,
  completedAt: base + 1000,
  toolLog: [],
  sparklineBins: [],
});
const mail = (id: string, extra: Partial<MailboxMessage> = {}): MailboxMessage => ({
  id,
  from: 'worker-a',
  to: 'leader-a',
  type: 'note',
  subject: 'Review done',
  body: 'Details',
  priority: 'normal',
  readBy: {},
  readByCount: 0,
  completed: false,
  timestamp: new Date(base + 100).toISOString(),
  ...extra,
});

describe('session story projection', () => {
  it('counts successful file operations with paired inputs and normalizes Windows paths', () => {
    const story = buildSessionStory(
      'tab-a',
      [
        record('start', 'tool.started', {
          correlation: { toolCallId: 'read1' },
          attributes: { toolName: 'read', input: JSON.stringify({ path: 'D:\\repo\\src\\a.ts' }) },
        }),
        record('done', 'tool.executed', {
          correlation: { toolCallId: 'read1' },
          outcome: 'success',
        }),
        record('again', 'file.observed', {
          resource: { kind: 'file', id: 'a', path: 'd:/REPO/src/A.ts' },
        }),
        record('bad-start', 'tool.started', {
          correlation: { toolCallId: 'read2' },
          attributes: { toolName: 'read', input: { path: 'D:/repo/missing.ts' } },
        }),
        record('bad-end', 'tool.executed', {
          correlation: { toolCallId: 'read2' },
          outcome: 'failure',
        }),
      ],
      [],
      [],
      [],
      'D:/repo',
    );
    expect(story.files).toEqual(['src/a.ts']);
    expect(story.events.find((event) => event.id === 'bad-end')?.path).toBeUndefined();
  });
  it('pairs tool.started and tool.executed input paths when correlated via attributes.toolUseId (F788)', () => {
    const story = buildSessionStory(
      'tab-a',
      [
        record('start-tu', 'tool.started', {
          attributes: {
            toolUseId: 'tu-1',
            toolName: 'read',
            input: { path: 'D:/repo/src/via-tool-use-id.ts' },
          },
        }),
        record('done-tu', 'tool.executed', {
          outcome: 'success',
          attributes: { toolUseId: 'tu-1', toolName: 'read' },
        }),
      ],
      [],
      [],
      [],
      'D:/repo',
    );
    expect(story.toolCalls).toBe(1);
    expect(story.files).toEqual(['src/via-tool-use-id.ts']);
    expect(story.events.find((event) => event.id === 'done-tu')?.path).toBe(
      'D:/repo/src/via-tool-use-id.ts',
    );
  });
  it('counts unique recorded injected IDs and separates memory write events', () => {
    const story = buildSessionStory('tab-a', [
      record('injected', 'memory.injector_run', {
        attributes: { injected: [{ id: 'm1' }, { id: 'm1' }, { id: 'm2' }] },
      }),
      record('saved', 'tool.executed', {
        outcome: 'success',
        attributes: { toolName: 'remember' },
      }),
      record('failed-save', 'tool.executed', {
        outcome: 'failure',
        attributes: { toolName: 'remember' },
      }),
      record('foreign', 'memory.injector_run', {
        scope: { sessionId: 'tab-b' },
        attributes: { injected: [{ id: 'other' }] },
      }),
    ]);
    expect(story.observedInjectedMemories).toBe(2);
    expect(story.memoryWrites).toBe(1);
  });
  it('includes all owned subagents and excludes other tabs and untagged actors', () => {
    const story = buildSessionStory(
      'tab-a',
      [
        record('a', 'subagent.spawned', {
          attributes: { subagentId: 'worker-a', name: 'Worker A', parentAgentId: 'leader-a' },
        }),
        record('b', 'tool.executed', { scope: { sessionId: 'tab-b', agentId: 'worker-b' } }),
        record('c', 'tool.executed', { scope: {} }),
      ],
      [
        agent('worker-a'),
        agent('worker-b', 'tab-b'),
        { ...agent('untagged'), sessionId: undefined },
      ],
    );
    expect(story.events.map((event) => event.id)).toEqual(['a']);
    expect(story.actors.map((actor) => actor.id)).toEqual(['worker-a']);
    expect(story.actors[0]?.parent).toBe('leader-a');
  });
  it('pairs tool IDs, preserves recorded durations, and rejects invalid dates', () => {
    const story = buildSessionStory('tab-a', [
      record('start', 'tool.started', { correlation: { toolCallId: 't1' } }),
      record('end', 'tool.executed', {
        correlation: { toolCallId: 't1' },
        durationNs: '500000000',
      }),
      record('bad', 'tool.executed', { observedAt: 'bad' }),
    ]);
    expect(story.toolCalls).toBe(1);
    expect(story.events).toHaveLength(2);
    expect(story.events.find((event) => event.id === 'end')?.durationMs).toBe(500);
    expect(story.start).toBe(base - 500);
  });
  it('uses only explicitly owned incoming/outgoing mail and deduplicates cached IDs', () => {
    const own = mail('own');
    const story = buildSessionStory(
      'tab-a',
      [],
      [agent('worker-a')],
      [
        own,
        own,
        mail('other', { from: 'worker-b', to: 'leader-b', senderSessionId: 'tab-b' }),
        mail('incoming', { from: 'outside', to: '@session:tab-a' }),
        mail('unscoped', { from: 'session', to: '*' }),
      ],
    );
    expect(story.events.map((event) => event.id).sort()).toEqual(['mail:incoming', 'mail:own']);
    expect(story.counts.mail).toBe(2);
  });
  it('does not call ordinary activity drift and does not invent missing durations or parents', () => {
    const story = buildSessionStory('tab-a', [
      record('drift', 'brain.drift_detected'),
      record('file', 'file.event', { resource: { kind: 'file', id: 'f', path: 'src/a.ts' } }),
      record('tool', 'tool.executed'),
    ]);
    expect(story.counts.alert).toBe(1);
    expect(story.files).toEqual(['src/a.ts']);
    expect(story.events.find((event) => event.id === 'tool')?.durationMs).toBeUndefined();
    expect(story.actors.every((actor) => actor.parent === undefined)).toBe(true);
  });
  it('never projects an empty session ID', () => {
    expect(
      buildSessionStory(
        '',
        [record('empty', 'tool.executed', { scope: { sessionId: '' } })],
        [agent('empty', '')],
        [mail('empty', { senderSessionId: '' })],
      ).events,
    ).toEqual([]);
  });

  it('projects non-main session branches as child actor lanes and formats branch DAG milestones', () => {
    const story = buildSessionStory('tab-a', [
      record('b-create', 'branch_created', {
        observedAt: new Date(base + 100).toISOString(),
        scope: { sessionId: 'tab-a' },
        attributes: {
          parentBranchId: 'main',
          newBranchId: 'br_redis',
          name: 'try-redis',
        },
      }),
      record('b-tool', 'tool.executed', {
        observedAt: new Date(base + 200).toISOString(),
        scope: { sessionId: 'tab-a' },
        attributes: {
          toolName: 'bash',
          branchId: 'br_redis',
          branchName: 'try-redis',
        },
      }),
      record('b-fold', 'branch_folded', {
        observedAt: new Date(base + 300).toISOString(),
        scope: { sessionId: 'tab-a' },
        attributes: {
          sourceBranchId: 'br_redis',
          targetBranchId: 'main',
          summary: 'Redis latency 0.4ms',
        },
      }),
    ]);

    const branchLane = story.actors.find((a) => a.id === 'branch:br_redis');
    expect(branchLane).toBeDefined();
    expect(branchLane?.name).toBe('⎇ try-redis');
    expect(branchLane?.parent).toBe('session');
    expect(branchLane?.status).toBe('completed');
    expect(story.events.find((e) => e.id === 'b-create')?.title).toContain('try-redis');
    expect(story.events.find((e) => e.id === 'b-fold')?.title).toBe('⎇ Folded try-redis → main');
  });

  it('preserves hierarchical parent-branch DAG lineage across nested exploratory branches', () => {
    const story = buildSessionStory('tab-a', [
      record('b1', 'branch_created', {
        observedAt: new Date(base + 50).toISOString(),
        scope: { sessionId: 'tab-a' },
        attributes: {
          parentBranchId: 'main',
          branchId: 'br_l1',
          name: 'exp-storage',
        },
      }),
      record('b2', 'branch_created', {
        observedAt: new Date(base + 100).toISOString(),
        scope: { sessionId: 'tab-a' },
        attributes: {
          parentBranchId: 'br_l1',
          branchId: 'br_l2',
          name: 'exp-wal-tuning',
        },
      }),
      record('b2-tool', 'tool.executed', {
        observedAt: new Date(base + 150).toISOString(),
        scope: { sessionId: 'tab-a' },
        attributes: {
          toolName: 'edit',
          branchId: 'br_l2',
          branchName: 'exp-wal-tuning',
        },
      }),
    ]);

    const l1 = story.actors.find((a) => a.id === 'branch:br_l1');
    const l2 = story.actors.find((a) => a.id === 'branch:br_l2');
    expect(l1?.parent).toBe('session');
    expect(l1?.name).toBe('⎇ exp-storage');
    expect(l2?.parent).toBe('branch:br_l1');
    expect(l2?.name).toBe('⎇ exp-wal-tuning');
  });
});
