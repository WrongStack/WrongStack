import { describe, expect, it, vi, beforeEach } from 'vitest';
import { TaskAuctioneer } from '../../src/coordination/task-auctioneer.js';
import type { GoalNode, KnowledgeGraph } from '../../src/coordination/knowledge-graph.js';
import type { FleetBus } from '../../src/coordination/fleet-bus.js';
import type { Mailbox } from '../../src/coordination/mailbox-types.js';

// Controllable dispatcher so bid()/findWork() scores are deterministic.
const { dispatchResult } = vi.hoisted(() => ({
  dispatchResult: { value: { confidence: 0.8, role: 'bug-hunter' } },
}));
vi.mock('../../src/coordination/dispatcher.js', () => ({
  dispatchAgent: vi.fn(async () => ({ ...dispatchResult.value })),
}));

// ── Mock helpers ──────────────────────────────────────────────────────────────

function createMockGraph(): KnowledgeGraph {
  const nodes = new Map<string, GoalNode>();

  return {
    add: vi.fn(async (data: Record<string, unknown>) => {
      const id = `goal_${nodes.size + 1}`;
      const node: GoalNode = {
        id,
        type: 'goal',
        title: String(data.title ?? 'Untitled'),
        description: String(data.description ?? ''),
        status: String(data.status ?? 'pending') as GoalNode['status'],
        priority: String(data.priority ?? 'medium') as GoalNode['priority'],
        assignee: data.assignee as string | undefined,
        blockedBy: (data.blockedBy as string[]) ?? [],
        dependsOn: (data.dependsOn as string[]) ?? [],
        createdBy: String(data.createdBy ?? ''),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tags: (data.tags as string[]) ?? [],
        children: (data.children as string[]) ?? [],
        parentGoal: data.parentGoal as string | undefined,
      } as GoalNode;
      nodes.set(id, node);
      return node;
    }),
    get: vi.fn((id: string) => {
      return nodes.get(id);
    }),
    update: vi.fn(async (id: string, patch: Record<string, unknown>) => {
      const node = nodes.get(id);
      if (!node) return null;
      Object.assign(node, patch as Partial<GoalNode>);
      return node;
    }),
    getGoals: vi.fn(() => Array.from(nodes.values())),
    getOpenGoals: vi.fn(() => Array.from(nodes.values()).filter(g => g.status === 'pending' || g.status === 'in_progress')),
    subscribe: vi.fn(() => () => {}),
    dispose: vi.fn(),
  } as never as KnowledgeGraph;
}

function createMockFleetBus(): FleetBus {
  return {
    emit: vi.fn(),
    filter: vi.fn(() => vi.fn()),
    subscribe: vi.fn(() => () => {}),
    unsubscribe: vi.fn(),
    dispose: vi.fn(),
  } as never as FleetBus;
}

function createMockMailbox(): Mailbox {
  return {
    send: vi.fn(),
    query: vi.fn(),
    broadcast: vi.fn(),
  } as never as Mailbox;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('TaskAuctioneer', () => {
  let graph: KnowledgeGraph;
  let fleet: FleetBus;
  let mailbox: Mailbox;
  let auctioneer: TaskAuctioneer;

  beforeEach(() => {
    graph = createMockGraph();
    fleet = createMockFleetBus();
    mailbox = createMockMailbox();
    auctioneer = new TaskAuctioneer({
      graph,
      fleet,
      mailbox,
      selfAgentId: 'auctioneer-test',
      bidWindowMs: 1000, // 1 second for faster tests
      maxTasksPerAgent: 3,
      minConfidence: 0.3,
    });
  });

  describe('publishTask', () => {
    it('creates a goal node in the graph', async () => {
      const taskId = await auctioneer.publishTask({
        title: 'Fix bug',
        description: 'Fix the null pointer exception',
        priority: 'high',
        tags: ['bug', 'urgent'],
      });

      expect(taskId).toBeDefined();
      expect(graph.add).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'goal',
          title: 'Fix bug',
          description: 'Fix the null pointer exception',
          priority: 'high',
          status: 'pending',
        }),
      );
    });

    it('broadcasts task via fleet bus', async () => {
      await auctioneer.publishTask({
        title: 'New task',
        description: 'Description',
      });

      expect(fleet.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'task:published',
          payload: expect.objectContaining({
            title: 'New task',
          }),
        }),
      );
    });

    it('assigns directly when targetAgent is specified', async () => {
      await auctioneer.publishTask({
        title: 'Assigned task',
        description: 'This will be assigned directly',
        targetAgent: 'agent-1',
      });

      expect(graph.add).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'in_progress',
          assignee: 'agent-1',
        }),
      );
    });

    it('uses default priority when not specified', async () => {
      await auctioneer.publishTask({
        title: 'Task',
        description: 'Desc',
      });

      expect(graph.add).toHaveBeenCalledWith(
        expect.objectContaining({
          priority: 'medium',
        }),
      );
    });

    it('sets parentGoal when specified', async () => {
      await auctioneer.publishTask({
        title: 'Sub-task',
        description: 'Desc',
        parentGoal: 'parent-goal-1',
      });

      expect(graph.add).toHaveBeenCalledWith(
        expect.objectContaining({
          parentGoal: 'parent-goal-1',
        }),
      );
    });
  });

  describe('bid', () => {
    it('rejects bid on non-existent task', async () => {
      const accepted = await auctioneer.bid('nonexistent', {
        agentId: 'agent-1',
        agentName: 'Alice',
        agentRole: 'bug-hunter',
      }, 'Test');

      expect(accepted).toBe(false);
    });

    it('rejects bid on already-claimed task (in_progress)', async () => {
      await auctioneer.publishTask({
        title: 'Already claimed',
        description: 'Desc',
        targetAgent: 'agent-other',
      });

      const accepted = await auctioneer.bid('goal_1', {
        agentId: 'agent-1',
        agentName: 'Alice',
        agentRole: 'bug-hunter',
      }, 'Test');

      expect(accepted).toBe(false);
    });
  });

  describe('claim', () => {
    it('awards task to agent', async () => {
      await auctioneer.publishTask({
        title: 'Task',
        description: 'Desc',
      });

      const result = await auctioneer.claim('goal_1', 'agent-1', 'Alice');

      expect(result).toBe(true);
      expect(graph.update).toHaveBeenCalledWith(
        'goal_1',
        expect.objectContaining({
          status: 'in_progress',
          assignee: 'agent-1',
        }),
      );
    });

    it('rejects claim on non-existent task', async () => {
      const result = await auctioneer.claim('nonexistent', 'agent-1', 'Alice');
      expect(result).toBe(false);
    });

    it('rejects claim on already-claimed task', async () => {
      await auctioneer.publishTask({ title: 'Task', description: 'Desc' });
      await auctioneer.claim('goal_1', 'agent-1', 'Alice');

      const result = await auctioneer.claim('goal_1', 'agent-2', 'Bob');
      expect(result).toBe(false);
    });
  });

  describe('complete', () => {
    it('marks task as done', async () => {
      await auctioneer.publishTask({ title: 'Task', description: 'Desc' });

      await auctioneer.complete('goal_1');

      expect(graph.update).toHaveBeenCalledWith(
        'goal_1',
        expect.objectContaining({
          status: 'done',
        }),
      );
    });

    it('handles non-existent task gracefully', async () => {
      // Should not throw
      await expect(auctioneer.complete('nonexistent')).resolves.not.toThrow();
    });

    // `KnowledgeGraph.update` merges patches without consulting the current
    // state, so a repeated terminal report used to run the whole transition
    // again — including a second decrement of the agent's in-flight count,
    // which floors at zero and so made the agent look idler than it was.
    it('ignores a repeated completion instead of applying it twice', async () => {
      await auctioneer.publishTask({ title: 'Task', description: 'Desc' });
      await auctioneer.complete('goal_1');
      const updatesAfterFirst = (graph.update as unknown as { mock: { calls: unknown[] } }).mock
        .calls.length;

      await auctioneer.complete('goal_1');

      expect(
        (graph.update as unknown as { mock: { calls: unknown[] } }).mock.calls.length,
      ).toBe(updatesAfterFirst);
    });
  });

  describe('fail', () => {
    it('marks task as failed', async () => {
      await auctioneer.publishTask({ title: 'Task', description: 'Desc' });

      await auctioneer.fail('goal_1', 'Timeout error');

      expect(graph.update).toHaveBeenCalledWith(
        'goal_1',
        expect.objectContaining({
          status: 'failed',
          result: 'Timeout error',
        }),
      );
    });

    // A late failure report arriving after a genuine completion used to rewrite
    // the finished task to `failed` and replace its result with the error.
    it('cannot rewrite an already completed task to failed', async () => {
      await auctioneer.publishTask({ title: 'Task', description: 'Desc' });
      await auctioneer.complete('goal_1', 'shipped');

      await auctioneer.fail('goal_1', 'late timeout report');

      const goal = graph.get('goal_1') as GoalNode;
      expect(goal.status).toBe('done');
      expect(goal.result).toBe('shipped');
    });
  });

  describe('getPendingTasks', () => {
    it('returns pending non-blocked tasks', async () => {
      await auctioneer.publishTask({ title: 'Task 1', description: 'D1' });
      await auctioneer.publishTask({ title: 'Task 2', description: 'D2' });

      const pending = auctioneer.getPendingTasks();

      expect(pending.length).toBeGreaterThan(0);
    });
  });

  describe('getTasksForAgent', () => {
    it('returns tasks assigned to specific agent', async () => {
      await auctioneer.publishTask({ title: 'Task', description: 'Desc', targetAgent: 'agent-1' });

      const tasks = auctioneer.getTasksForAgent('agent-1');

      expect(tasks.length).toBe(1);
      expect(tasks[0]!.title).toBe('Task');
    });
  });

  describe('getBidCount', () => {
    it('returns zero for tasks with no bids', () => {
      const count = auctioneer.getBidCount('any-task');
      expect(count).toBe(0);
    });
  });

  describe('getStats', () => {
    it('reports task counts', async () => {
      await auctioneer.publishTask({ title: 'Task 1', description: 'D1' });
      await auctioneer.publishTask({ title: 'Task 2', description: 'D2', targetAgent: 'agent-1' });

      const stats = auctioneer.getStats();

      expect(stats).toHaveProperty('total');
      expect(stats).toHaveProperty('pending');
      expect(stats).toHaveProperty('in_progress');
      expect(stats).toHaveProperty('done');
      expect(stats).toHaveProperty('failed');
    });
  });

  describe('default options', () => {
    it('uses sensible defaults', () => {
      const defaultAuctioneer = new TaskAuctioneer({ graph });
      expect(defaultAuctioneer).toBeDefined();
    });
  });
});

// ── Extended coverage ────────────────────────────────────────────────────────

/** A FleetBus mock that records handlers by event type so tests can fire them. */
function createCapturingFleet(): FleetBus & {
  handlers: Map<string, Array<(e: { payload: unknown }) => void>>;
} {
  const handlers = new Map<string, Array<(e: { payload: unknown }) => void>>();
  return {
    handlers,
    emit: vi.fn(),
    filter: vi.fn(((type: string, handler: (e: { payload: unknown }) => void) => {
      const list = handlers.get(type) ?? [];
      list.push(handler);
      handlers.set(type, list);
      return () => {
        const arr = handlers.get(type);
        if (arr) {
          const i = arr.indexOf(handler);
          if (i >= 0) arr.splice(i, 1);
        }
      };
    }) as never),
    subscribe: vi.fn(() => () => {}),
    unsubscribe: vi.fn(),
    dispose: vi.fn(),
  } as never;
}

describe('TaskAuctioneer (extended coverage)', () => {
  let graph: KnowledgeGraph;
  let fleet: ReturnType<typeof createCapturingFleet>;
  let mailbox: Mailbox;
  let auctioneer: TaskAuctioneer;

  beforeEach(() => {
    dispatchResult.value = { confidence: 0.8, role: 'bug-hunter' };
    graph = createMockGraph();
    fleet = createCapturingFleet();
    mailbox = createMockMailbox();
    auctioneer = new TaskAuctioneer({
      graph,
      fleet,
      mailbox,
      selfAgentId: 'auctioneer-test',
      bidWindowMs: 1000,
      maxTasksPerAgent: 3,
      minConfidence: 0.3,
    });
  });

  describe('bid (success + branches)', () => {
    it('accepts a bid above the confidence threshold (role-match boost)', async () => {
      const id = await auctioneer.publishTask({ title: 'T', description: 'Fix bug' });
      const accepted = await auctioneer.bid(
        id,
        { agentId: 'a1', agentName: 'Alice', agentRole: 'bug-hunter' },
        'I can fix it',
      );
      expect(accepted).toBe(true);
      expect(auctioneer.getBidCount(id)).toBe(1);
      expect(fleet.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'task:bid' }));
    });

    it('accepts a bid without a role match (no boost, still above threshold)', async () => {
      const id = await auctioneer.publishTask({ title: 'T', description: 'Fix bug' });
      const accepted = await auctioneer.bid(
        id,
        { agentId: 'a1', agentName: 'Alice', agentRole: 'reviewer' },
        'I can help',
      );
      expect(accepted).toBe(true);
    });

    it('rejects a bid below the confidence threshold', async () => {
      dispatchResult.value = { confidence: 0.1, role: 'bug-hunter' };
      const id = await auctioneer.publishTask({ title: 'T', description: 'Fix bug' });
      const accepted = await auctioneer.bid(
        id,
        { agentId: 'a1', agentName: 'Alice', agentRole: 'bug-hunter' },
        'maybe',
      );
      expect(accepted).toBe(false);
      expect(auctioneer.getBidCount(id)).toBe(0);
    });

    it('rejects a bid when the agent is at capacity', async () => {
      // Fill agent-1 to capacity (3 claims).
      const t1 = await auctioneer.publishTask({ title: 'T1', description: 'd' });
      const t2 = await auctioneer.publishTask({ title: 'T2', description: 'd' });
      const t3 = await auctioneer.publishTask({ title: 'T3', description: 'd' });
      await auctioneer.claim(t1, 'a1', 'Alice');
      await auctioneer.claim(t2, 'a1', 'Alice');
      await auctioneer.claim(t3, 'a1', 'Alice');
      const id = await auctioneer.publishTask({ title: 'T4', description: 'Fix bug' });
      const accepted = await auctioneer.bid(
        id,
        { agentId: 'a1', agentName: 'Alice', agentRole: 'bug-hunter' },
        'one more',
      );
      expect(accepted).toBe(false);
    });

    it('updates an existing bid from the same agent instead of adding a duplicate', async () => {
      const id = await auctioneer.publishTask({ title: 'T', description: 'Fix bug' });
      await auctioneer.bid(id, { agentId: 'a1', agentName: 'Alice', agentRole: 'bug-hunter' }, 'first');
      await auctioneer.bid(id, { agentId: 'a1', agentName: 'Alice', agentRole: 'bug-hunter' }, 'second');
      expect(auctioneer.getBidCount(id)).toBe(1);
      expect(auctioneer.getBids(id)[0]!.rationale).toBe('second');
    });

    it('rejects a bid on a non-pending (already-assigned) task', async () => {
      const id = await auctioneer.publishTask({ title: 'T', description: 'd', targetAgent: 'x' });
      const accepted = await auctioneer.bid(
        id,
        { agentId: 'a1', agentName: 'Alice', agentRole: 'bug-hunter' },
        'x',
      );
      expect(accepted).toBe(false); // status is in_progress, not pending
    });
  });

  describe('_evaluateBids (bid-window resolution)', () => {
    it('awards the task to the highest-scoring bidder under capacity', async () => {
      const id = await auctioneer.publishTask({ title: 'T', description: 'Fix bug' });
      await auctioneer.bid(id, { agentId: 'a1', agentName: 'Alice', agentRole: 'bug-hunter' }, 'r');
      await (auctioneer as unknown as { _evaluateBids: (t: string) => Promise<void> })._evaluateBids(id);
      expect(graph.update).toHaveBeenCalledWith(id, expect.objectContaining({ status: 'in_progress' }));
      expect(auctioneer.getBidCount(id)).toBe(0);
    });

    it('sorts multiple bids and awards to the highest scorer', async () => {
      const id = await auctioneer.publishTask({ title: 'T', description: 'Fix bug' });
      await auctioneer.bid(id, { agentId: 'a1', agentName: 'Alice', agentRole: 'bug-hunter' }, 'r');
      // Second bid from a different agent (lower confidence via dispatcher override).
      dispatchResult.value = { confidence: 0.4, role: 'bug-hunter' };
      await auctioneer.bid(id, { agentId: 'a2', agentName: 'Bob', agentRole: 'bug-hunter' }, 'r');
      await (auctioneer as unknown as { _evaluateBids: (t: string) => Promise<void> })._evaluateBids(id);
      // a1 scored higher (0.8) than a2 (0.4) → a1 wins.
      expect(graph.update).toHaveBeenCalledWith(id, expect.objectContaining({ assignee: 'a1' }));
    });

    it('handles _evaluateBids on a task whose goal is gone (retry path, no goal)', async () => {
      await expect(
        (auctioneer as unknown as { _evaluateBids: (t: string) => Promise<void> })._evaluateBids('no-such-task'),
      ).resolves.not.toThrow();
    });

    it('republishes when no bids arrive and retries remain', async () => {
      const id = await auctioneer.publishTask({ title: 'T', description: 'Fix bug' });
      const before = (fleet.emit as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[0]?.type === 'task:available').length;
      await (auctioneer as unknown as { _evaluateBids: (t: string) => Promise<void> })._evaluateBids(id);
      const after = (fleet.emit as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[0]?.type === 'task:available').length;
      expect(after).toBeGreaterThan(before); // re-broadcast
    });

    it('marks the task failed after exceeding max bid retries', async () => {
      const a = new TaskAuctioneer({
        graph,
        fleet,
        mailbox,
        selfAgentId: 'auctioneer-test',
        bidWindowMs: 1000,
        maxBidRetries: 1,
        minConfidence: 0.3,
      });
      const id = await a.publishTask({ title: 'T', description: 'Fix bug' });
      await (a as unknown as { _evaluateBids: (t: string) => Promise<void> })._evaluateBids(id);
      expect(graph.update).toHaveBeenCalledWith(
        id,
        expect.objectContaining({ status: 'failed', result: expect.stringContaining('No bids') }),
      );
    });

    it('re-broadcasts when every bidder is now at capacity', async () => {
      const id = await auctioneer.publishTask({ title: 'T', description: 'Fix bug' });
      await auctioneer.bid(id, { agentId: 'a1', agentName: 'Alice', agentRole: 'bug-hunter' }, 'r');
      // Push the sole bidder to capacity AFTER bidding.
      (auctioneer as unknown as { agentTaskCount: (a: string, d: number) => void }).agentTaskCount('a1', +3);
      const before = (fleet.emit as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[0]?.type === 'task:available').length;
      await (auctioneer as unknown as { _evaluateBids: (t: string) => Promise<void> })._evaluateBids(id);
      const after = (fleet.emit as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[0]?.type === 'task:available').length;
      expect(after).toBeGreaterThan(before); // no winner → re-broadcast
      expect(graph.update).not.toHaveBeenCalledWith(id, expect.objectContaining({ status: 'in_progress' }));
    });
  });

  describe('findWork', () => {
    it('scores, sorts, and limits available tasks; skips blocked', async () => {
      dispatchResult.value = { confidence: 0.5, role: 'x' };
      const tagged = await auctioneer.publishTask({ title: 'Tagged', description: 'd', tags: ['bug-hunter'] });
      const critical = await auctioneer.publishTask({ title: 'Critical', description: 'd', priority: 'critical' });
      const blocked = await auctioneer.publishTask({ title: 'Blocked', description: 'd', blockedBy: [tagged] });
      const results = await auctioneer.findWork('a1', 'bug-hunter', 5);
      const ids = results.map((r) => r.task.id);
      expect(ids).not.toContain(blocked); // blocked excluded
      expect(ids).toContain(tagged);
      expect(ids).toContain(critical);
      // Both score boosts apply; ordering is by score desc.
      expect(results[0]!.score).toBeGreaterThanOrEqual(results[1]!.score);
    });

    it('respects the limit', async () => {
      dispatchResult.value = { confidence: 0.5, role: 'x' };
      for (let i = 0; i < 6; i++) await auctioneer.publishTask({ title: `T${i}`, description: 'd' });
      const results = await auctioneer.findWork('a1', '', 2);
      expect(results.length).toBe(2);
    });
  });

  describe('complete (dependent unblocking)', () => {
    it('flips a blocked child to pending once its blocker completes', async () => {
      const blocker = await auctioneer.publishTask({ title: 'Blocker', description: 'd' });
      const child = await auctioneer.publishTask({ title: 'Child', description: 'd', blockedBy: [blocker] });
      // Blocker registered the child on its children list at publish time.
      await auctioneer.complete(blocker);
      expect(graph.update).toHaveBeenCalledWith(child, expect.objectContaining({ status: 'pending' }));
    });

    it('records a result when provided', async () => {
      const id = await auctioneer.publishTask({ title: 'T', description: 'd' });
      await auctioneer.complete(id, 'ship it');
      expect(graph.update).toHaveBeenCalledWith(id, expect.objectContaining({ status: 'done', result: 'ship it' }));
      expect(fleet.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'task:completed' }));
    });
  });

  describe('publishTask (blockedBy registration)', () => {
    it('registers the child on each blocker and starts blocked when blockers are open', async () => {
      const blocker = await auctioneer.publishTask({ title: 'Blocker', description: 'd' });
      await auctioneer.publishTask({ title: 'Child', description: 'd', blockedBy: [blocker] });
      expect(graph.add).toHaveBeenCalledWith(expect.objectContaining({ status: 'blocked' }));
      expect(graph.update).toHaveBeenCalledWith(blocker, expect.objectContaining({ children: expect.arrayContaining([expect.any(String)]) }));
    });

    it('truncates a very long description in the broadcast body', async () => {
      const long = `${'x'.repeat(300)}`;
      await auctioneer.publishTask({ title: 'T', description: long });
      const broadcast = (mailbox.send as ReturnType<typeof vi.fn>).mock.calls.find(
        (c) => c[0]?.type === 'broadcast',
      );
      expect(broadcast?.[0]?.body).toContain('...');
    });
  });

  describe('fleet + lifecycle', () => {
    it('_onClaimedEvent clears local bids and the bid window', async () => {
      const id = await auctioneer.publishTask({ title: 'T', description: 'Fix bug' });
      await auctioneer.bid(id, { agentId: 'a1', agentName: 'Alice', agentRole: 'bug-hunter' }, 'r');
      const handler = fleet.handlers.get('task:claimed')?.[0];
      expect(handler).toBeDefined();
      handler!({ payload: { taskId: id } });
      expect(auctioneer.getBidCount(id)).toBe(0);
    });

    it('dispose detaches fleet subscriptions and clears bid-window timers', async () => {
      await auctioneer.publishTask({ title: 'T', description: 'Fix bug' }); // arms a bid-window timer + 2 filter subs
      expect((fleet.handlers.get('task:claimed') ?? []).length).toBe(1);
      auctioneer.dispose();
      // Disposers spliced the handlers out of the capturing fleet's map.
      expect((fleet.handlers.get('task:claimed') ?? []).length).toBe(0);
      expect((fleet.handlers.get('task:bid') ?? []).length).toBe(0);
    });

    it('getBids returns the bids for a task', async () => {
      const id = await auctioneer.publishTask({ title: 'T', description: 'Fix bug' });
      await auctioneer.bid(id, { agentId: 'a1', agentName: 'Alice', agentRole: 'bug-hunter' }, 'r');
      expect(auctioneer.getBids(id).length).toBe(1);
      expect(auctioneer.getBids('unknown').length).toBe(0);
    });
  });

  describe('no fleet / no mailbox (standalone degradation)', () => {
    it('publishes + bids + claims without a fleet or mailbox (best-effort no-ops)', async () => {
      const a = new TaskAuctioneer({ graph, selfAgentId: 'solo' });
      const id = await a.publishTask({ title: 'T', description: 'Fix bug' });
      expect(id).toBeDefined();
      const accepted = await a.bid(
        id,
        { agentId: 'a1', agentName: 'Alice', agentRole: 'bug-hunter' },
        'r',
      );
      expect(accepted).toBe(true); // _mailboxPublish/_emit no-op, bid still recorded
      // claim reaches _notifyAgent which no-ops without a mailbox.
      const claimed = await a.claim(id, 'a1', 'Alice');
      expect(claimed).toBe(true);
    });
  });

  describe('remaining edges', () => {
    it('updates a real parent goal children list on publish', async () => {
      const parent = await auctioneer.publishTask({ title: 'Parent', description: 'd' });
      await auctioneer.publishTask({ title: 'Child', description: 'd', parentGoal: parent });
      expect(graph.update).toHaveBeenCalledWith(parent, expect.objectContaining({ children: expect.arrayContaining([expect.any(String)]) }));
    });

    it('fires the bid-window timer on expiry (→ _evaluateBids)', async () => {
      vi.useFakeTimers();
      try {
        const a = new TaskAuctioneer({
          graph,
          fleet,
          mailbox,
          selfAgentId: 't',
          bidWindowMs: 50,
          minConfidence: 0.3,
        });
        await a.publishTask({ title: 'T', description: 'Fix bug' });
        const before = (fleet.emit as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[0]?.type === 'task:available').length;
        await vi.advanceTimersByTimeAsync(50); // timer fires → _evaluateBids (no bids → republish)
        const after = (fleet.emit as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[0]?.type === 'task:available').length;
        expect(after).toBeGreaterThan(before);
      } finally {
        vi.useRealTimers();
      }
    });

    it('_onBidEvent is a no-op handler (fleet task:bid)', () => {
      const handler = fleet.handlers.get('task:bid')?.[0];
      expect(handler).toBeDefined();
      expect(() => handler!({ payload: {} })).not.toThrow();
    });

    it('swallows mailbox errors during broadcast + notify', async () => {
      (mailbox.send as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));
      const id = await auctioneer.publishTask({ title: 'T', description: 'Fix bug' }); // _broadcastTask → _mailboxPublish catch
      await expect(auctioneer.claim(id, 'a1', 'Alice')).resolves.not.toThrow(); // _notifyAgent catch
    });

    it('fail + complete are no-ops on a missing task', async () => {
      await expect(auctioneer.fail('no-such-task', 'x')).resolves.not.toThrow();
    });

    it('getStats counts bids once a bid has been placed', async () => {
      const id = await auctioneer.publishTask({ title: 'T', description: 'Fix bug' });
      await auctioneer.bid(id, { agentId: 'a1', agentName: 'Alice', agentRole: 'bug-hunter' }, 'r');
      const stats = auctioneer.getStats();
      expect(stats.totalBids).toBe(1);
      expect(stats.avgBidsPerTask).toBeGreaterThan(0);
    });
  });
});
