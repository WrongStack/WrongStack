import { afterEach, describe, expect, it } from 'vitest';
import { DelegationTracker } from '../src/delegation/delegation-tracker.js';
import { leaderDeliveryHub } from '../src/delegation/leader-delivery-hub.js';
import { drainLeaderDeliveries } from '../src/leader-delivery-attach.js';

const TS = '2026-01-01T00:00:00.000Z';
const SESSION = 'sess_rehydrate_damaged';

const started = {
  type: 'delegate_started',
  ts: TS,
  target: 'bug-hunter',
  task: 'audit the deploy',
  delegationId: 'd1',
  taskId: 'task-1',
  mode: 'background',
};
const completed = {
  type: 'delegate_completed',
  ts: TS,
  target: 'bug-hunter',
  task: 'audit the deploy',
  ok: true,
  summary: 'audit finished',
  delegationId: 'd1',
  taskId: 'task-1',
  mode: 'background',
  resultExcerpt: 'audit finished: 3 findings',
};

const agent = () => ({
  ctx: { agentId: 'leader' },
  logger: { debug: () => {}, warn: () => {} },
});

async function drain(events: unknown[]): Promise<{ queued: number; blocks: string[] }> {
  const tracker = new DelegationTracker({});
  try {
    const queued = tracker.rehydrate(SESSION, events as never);
    const blocks: string[] = [];
    await drainLeaderDeliveries(agent() as never, [SESSION], (block) => {
      blocks.push(String((block as { text?: string }).text ?? ''));
    });
    return { queued, blocks };
  } finally {
    tracker.dispose();
  }
}

/**
 * F2606: `rehydrate` copied journal fields into the delivery payload unchecked.
 * A damaged line (`task: null`) then threw inside
 * `renderLeaderDeliveryBlock` — called by `LeaderDeliveryHub.take` while it
 * measures the block, before removing it — and `drainLeaderDeliveries` is
 * awaited unguarded by the agent loop, so every later iteration threw too.
 * Journal-sourced fields must be type-checked at the boundary.
 */
describe('delegation rehydrate tolerates damaged journal fields (F2606)', () => {
  afterEach(() => {
    leaderDeliveryHub.reset();
  });

  it('delivers a clean rehydrated result', async () => {
    leaderDeliveryHub.reset();
    const { queued, blocks } = await drain([started, completed]);

    expect(queued).toBe(1);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain('[DELEGATION RESULT]');
    expect(blocks[0]).toContain('task: audit the deploy');
    expect(leaderDeliveryHub.pending(SESSION)).toBe(0);
  });

  it('delivers a completed result whose journal fields are the wrong type', async () => {
    leaderDeliveryHub.reset();
    const { queued, blocks } = await drain([
      started,
      {
        ...completed,
        task: null,
        target: 42,
        summary: null,
        status: 7,
        stopReason: {},
        taskId: 12,
        subagentId: null,
        resultExcerpt: 99,
      },
    ]);

    expect(queued).toBe(1);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain('[DELEGATION RESULT] delegationId=d1');
    expect(blocks[0]).toContain('task:');
    expect(leaderDeliveryHub.pending(SESSION)).toBe(0);
  });

  it('delivers the lost-on-restart item when the start line is damaged', async () => {
    leaderDeliveryHub.reset();
    const { queued, blocks } = await drain([
      { ...started, target: null, task: 5, taskId: {}, subagentId: [] },
      // no completion: the worker died with the old process
    ]);

    expect(queued).toBe(1);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain('lost on restart');
    expect(leaderDeliveryHub.pending(SESSION)).toBe(0);
  });

  it('ignores events whose delegation id is not a string', async () => {
    leaderDeliveryHub.reset();
    const { queued } = await drain([
      { ...started, delegationId: 42 },
      { ...completed, delegationId: 42 },
    ]);

    expect(queued).toBe(0);
  });
});
