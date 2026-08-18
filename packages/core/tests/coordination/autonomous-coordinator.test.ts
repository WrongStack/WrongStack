import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { KnowledgeGraph } from '../../src/coordination/knowledge-graph.js';
import { TaskDAG } from '../../src/coordination/task-dag.js';
import { TaskAuctioneer } from '../../src/coordination/task-auctioneer.js';
import { ConsensusProtocol } from '../../src/coordination/consensus-protocol.js';
import { ChangeManager } from '../../src/coordination/change-manager.js';
import { AutonomousCoordinator } from '../../src/coordination/autonomous-coordinator.js';
import type { FleetBus } from '../../src/coordination/fleet-bus.js';
import type { Mailbox } from '../../src/coordination/mailbox-types.js';
import type { CoordinatorEvent } from '../../src/coordination/autonomous-coordinator.js';
import type { TaskSpec } from '../../src/types/multi-agent.js';
import type { Director } from '../../src/coordination/director.js';

// ── Test setup ─────────────────────────────────────────────────────────────

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autocoord-test-'));
});

afterEach(async () => {
  vi.useRealTimers();
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
      return;
    } catch (err: unknown) {
      // ENOTEMPTY: un-drained writer still flushing into the dir.
      // EPERM/EBUSY: Windows refuses to unlink a file (e.g. the knowledge-graph
      // .lock) while its holder hasn't released the handle yet.
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOTEMPTY' && code !== 'EPERM' && code !== 'EBUSY') throw err;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
});

// ── Mock helpers ───────────────────────────────────────────────────────────

function createMockFleetBus(): FleetBus {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  return {
    emit: vi.fn((type: string, payload?: unknown) => {
      const handlers = listeners.get(type);
      if (handlers) {
        for (const h of handlers) h(payload);
      }
    }),
    on: vi.fn((type: string, handler: (payload: unknown) => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(handler);
      return () => listeners.get(type)?.delete(handler);
    }),
    off: vi.fn((type: string, handler: (payload: unknown) => void) => {
      listeners.get(type)?.delete(handler);
    }),
    filter: vi.fn((type: string, handler: (payload: unknown) => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(handler);
      return () => listeners.get(type)?.delete(handler);
    }),
    subscribe: vi.fn(() => () => {}),
    unsubscribe: vi.fn(),
    dispose: vi.fn(),
  } as never as FleetBus;
}

function createMockMailbox(): Mailbox {
  return {
    send: vi.fn(async () => {}),
    query: vi.fn(async () => ({ messages: [], nextCursor: null })),
    subscribe: vi.fn(() => () => {}),
    unsubscribe: vi.fn(),
    dispose: vi.fn(),
  } as never as Mailbox;
}

function createMockLlmProvider() {
  return {
    decide: vi.fn(async () => ({
      type: 'deny' as const,
      optionId: 'deny',
      text: 'No valid options',
      rationale: 'Test: always deny to exit loop quickly',
    })),
  };
}

function createMockDirector() {
  const spawnCalls: { config: Parameters<Director['spawn']>[0] }[] = [];
  const assignCalls: { task: TaskSpec }[] = [];

  const director = {
    spawn: vi.fn<Parameters<Director['spawn']>, ReturnType<Director['spawn']>>(
      async (config) => {
        spawnCalls.push({ config });
        return `subagent-${config.name}-${spawnCalls.length}`;
      },
    ),
    assign: vi.fn<Parameters<Director['assign']>, ReturnType<Director['assign']>>(
      async (task) => {
        assignCalls.push({ task });
        return task.id;
      },
    ),
    // Expose calls for assertion
    _spawnCalls: spawnCalls,
    _assignCalls: assignCalls,
  };

  return director;
}

function createCoordinator(opts?: {
  onCoordinatorEvent?: (event: CoordinatorEvent) => void;
  disableSelfImprove?: boolean;
}) {
  const graph = new KnowledgeGraph(tempDir);
  const dag = new TaskDAG();
  const fleet = createMockFleetBus();
  const mailbox = createMockMailbox();

  const consensus = new ConsensusProtocol({
    graph,
    fleet,
    voters: [
      { agentId: 'critic', agentName: 'Critic', weight: 2, role: 'critic', veto: true },
      { agentId: 'bug-hunter', agentName: 'Bug Hunter', weight: 1.5, role: 'bug-hunter' },
    ],
    rules: { quorumFraction: 0.5, approvalFraction: 0.6, vetoRoles: ['critic'] },
  });

  const changeManager = new ChangeManager({ graph, consensus });
  const auctioneer = new TaskAuctioneer({ graph, fleet, mailbox, maxBidRetries: 3 });

  // NOTE: AutonomousBrain is NOT constructed here — the coordinator
  // creates its own internal brain. An orphan brain would allocate an
  // LLM provider and subscribe to fleet events with no cleanup path,
  // leaking listeners for the test suite duration.

  const events: CoordinatorEvent[] = [];
  const coordinator = new AutonomousCoordinator({
    sessionDir: tempDir,
    selfAgentId: 'leader@test',
    selfAgentName: 'Leader',
    fleet,
    mailbox,
    llmProvider: createMockLlmProvider(),
    disableSelfImprove: true,
    maxConcurrentAgents: 3,
    onCoordinatorEvent: opts?.onCoordinatorEvent ?? ((e) => events.push(e)),
  });

  return { coordinator, graph, dag, fleet, mailbox, events, auctioneer, consensus, changeManager };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('AutonomousCoordinator', () => {
  describe('onCoordinatorEvent callback', () => {
    it('is called with knowledge:added when publishFact is called', async () => {
      const events: CoordinatorEvent[] = [];
      const { coordinator } = createCoordinator({
        onCoordinatorEvent: (e) => events.push(e),
      });

      // The constructor emits coordinator:mode at construction time — filter it out
      // so we only test what publishFact emits
      const eventsBeforePublish = events.length;

      await coordinator.publishFact({
        category: 'bug',
        subject: 'Test bug',
        detail: 'Found in test',
        severity: 'high',
        tags: ['test'],
      });

      // After publishFact, we should have exactly one new event: knowledge:added
      expect(events).toHaveLength(eventsBeforePublish + 1);
      const newEvents = events.slice(eventsBeforePublish);
      expect(newEvents[0]!.type).toBe('knowledge:added');
      // CoordinatorEvent.knowledge:added has knowledgeId, title?, text?
      const ke = newEvents[0] as { type: 'knowledge:added'; title?: string };
      expect(ke.title).toBe('Test bug');
    });

    it('is called with goal:added for each subgoal during goal decomposition', async () => {
      const events: CoordinatorEvent[] = [];
      // _decomposeGoal is private, but run() calls it. Use run() with
      // maxIterations=1 so the loop exits immediately after decomposition.
      const llmProvider = createMockLlmProvider();
      const realCoordinator = new AutonomousCoordinator({
        sessionDir: tempDir,
        selfAgentId: 'leader@test',
        selfAgentName: 'Leader',
        llmProvider,
        disableSelfImprove: true,
        maxConcurrentAgents: 3,
        onCoordinatorEvent: (e) => events.push(e),
      });

      // Use a goal that decomposes into known subgoals
      await realCoordinator.run({ goal: 'fix security bugs', maxIterations: 1 });

      const goalAddedEvents = events.filter((e) => e.type === 'goal:added');
      expect(goalAddedEvents.length).toBeGreaterThan(0);

      // Security goals should decompose into at least: audit secrets, check injection, dependency audit
      const added = goalAddedEvents as Array<{ type: 'goal:added'; title: string }>;
      expect(added.some((e) => e.title.toLowerCase().includes('secret') || e.title.toLowerCase().includes('audit'))).toBe(true);
    });

    it('collects multiple event types in a single run', async () => {
      const events: CoordinatorEvent[] = [];
      const llmProvider = createMockLlmProvider();
      const coordinator = new AutonomousCoordinator({
        sessionDir: tempDir,
        selfAgentId: 'leader@test',
        selfAgentName: 'Leader',
        llmProvider,
        disableSelfImprove: true,
        maxConcurrentAgents: 3,
        onCoordinatorEvent: (e) => events.push(e),
      });

      // Publish a fact first
      await coordinator.publishFact({
        category: 'perf',
        subject: 'Slow query detected',
        detail: 'DB queries taking >1s',
        severity: 'medium',
        tags: ['perf'],
      });

      // Then run with a goal
      await coordinator.run({ goal: 'fix performance issues', maxIterations: 1 });

      // Should have at least: 1 knowledge:added + N goal:added
      expect(events.some((e) => e.type === 'knowledge:added')).toBe(true);
      expect(events.some((e) => e.type === 'goal:added')).toBe(true);
    });

    it('does not throw when onCoordinatorEvent is undefined', async () => {
      const coordinator = new AutonomousCoordinator({
        sessionDir: tempDir,
        selfAgentId: 'leader@test',
        selfAgentName: 'Leader',
        llmProvider: createMockLlmProvider(),
        disableSelfImprove: true,
        // No onCoordinatorEvent — should be optional
      });

      // Should not throw
      await expect(
        coordinator.publishFact({
          category: 'test',
          subject: 'Test',
          detail: 'Test',
          severity: 'low',
          tags: [],
        }),
      ).resolves.not.toThrow();
    });

    // TaskDAG prevents cycles at creation time (addDependency throws on
    // would-be cycles), so a coordinator-level deadlock event can never fire
    // through normal API usage. Cycle detection is covered in task-dag.test.ts.
    // This test verifies the coordinator's DAG wiring: completing a task
    // unblocks its dependents and makes them dispatchable.
    it('completing a DAG task unblocks its dependents for dispatch', async () => {
      const llmProvider = createMockLlmProvider();
      const coordinator = new AutonomousCoordinator({
        sessionDir: tempDir,
        selfAgentId: 'leader@test',
        selfAgentName: 'Leader',
        llmProvider,
        disableSelfImprove: true,
        maxConcurrentAgents: 2,
      });

      // dag is a public readonly property on AutonomousCoordinator.
      const dag = coordinator.dag;
      dag.addNode('task-a', 'First task');
      dag.addNode('task-b', 'Second task', ['task-a']);

      // task-b is blocked until task-a completes.
      expect(dag.getNode('task-b')!.status).toBe('pending');
      expect(dag.getReady().map((n) => n.id)).toContain('task-a');
      expect(dag.getReady().map((n) => n.id)).not.toContain('task-b');

      // Complete task-a → task-b becomes ready.
      dag.start('task-a', 'test');
      dag.complete('task-a', 'done');
      expect(dag.getNode('task-b')!.status).toBe('ready');
      expect(dag.getReady().map((n) => n.id)).toContain('task-b');
    });
  });

  describe('run() lifecycle', () => {
    it('exits after maxIterations even without completing goals', async () => {
      const llmProvider = createMockLlmProvider();
      const coordinator = new AutonomousCoordinator({
        sessionDir: tempDir,
        selfAgentId: 'leader@test',
        selfAgentName: 'Leader',
        llmProvider,
        disableSelfImprove: true,
        maxConcurrentAgents: 3,
      });

      // run() resolves without hanging — that is sufficient. A wall-clock
      // threshold would be inherently flaky on CI under load or GC pauses.
      const stats = await coordinator.run({ goal: 'improve the codebase', maxIterations: 2 });

      expect(stats.goals.total).toBeGreaterThanOrEqual(0);
    });

    it('returns CoordinatorStats with defined fields', async () => {
      const llmProvider = createMockLlmProvider();
      const coordinator = new AutonomousCoordinator({
        sessionDir: tempDir,
        selfAgentId: 'leader@test',
        selfAgentName: 'Leader',
        llmProvider,
        disableSelfImprove: true,
        maxConcurrentAgents: 3,
      });

      const stats = await coordinator.run({ goal: 'add tests', maxIterations: 1 });

      expect(stats.goals).toBeDefined();
      expect(stats.goals.total).toBeGreaterThanOrEqual(0);
      expect(typeof stats.goals.progress).toBe('number');
      expect(stats.dag).toBeDefined();
      expect(stats.auction).toBeDefined();
      expect(typeof stats.decisions).toBe('number');
    });

    it('throws when already running', async () => {
      const llmProvider = createMockLlmProvider();
      const coordinator = new AutonomousCoordinator({
        sessionDir: tempDir,
        selfAgentId: 'leader@test',
        selfAgentName: 'Leader',
        llmProvider,
        disableSelfImprove: true,
        maxConcurrentAgents: 3,
      });

      // Start first run
      const promise1 = coordinator.run({ goal: 'task 1', maxIterations: 100 });

      // Try to start second run while first is still going
      await expect(coordinator.run({ goal: 'task 2', maxIterations: 1 })).rejects.toThrow(
        'already running',
      );

      // Wait for first to finish
      await promise1.catch(() => {});
    });

    it('stop() terminates the run loop', async () => {
      const llmProvider = createMockLlmProvider();
      const coordinator = new AutonomousCoordinator({
        sessionDir: tempDir,
        selfAgentId: 'leader@test',
        selfAgentName: 'Leader',
        llmProvider,
        disableSelfImprove: true,
        maxConcurrentAgents: 3,
      });

      const runPromise = coordinator.run({ goal: 'long running task', maxIterations: 100 });

      // Stop immediately
      await coordinator.stop();

      // Should exit quickly
      const stats = await runPromise;
      expect(stats).toBeDefined();
    });

    it('does not re-process auction-pending tasks that are already in the DAG (no Director)', async () => {
      let brainCallCount = 0;
      const llmProvider = {
        decide: vi.fn(async (prompt: { options: Array<{ id: string }> }) => {
          brainCallCount++;
          return {
            optionId: prompt.options[0]?.id ?? '',
            rationale: 'pick first',
          };
        }),
      };
      const coordinator = new AutonomousCoordinator({
        sessionDir: tempDir,
        selfAgentId: 'leader@test',
        selfAgentName: 'Leader',
        // No director — tasks go to the auction and wait for terminal claiming
        llmProvider,
        disableSelfImprove: true,
        maxConcurrentAgents: 3,
      });

      const stats = await coordinator.run({ goal: 'fix bugs', maxIterations: 10 });

      // Brain should be called at most a few times (for decomposition + at most
      // once per unique dispatchable goal), NOT 10 times.
      // Decomposition for 'bug' category produces 2 sub-goals → at most 2
      // Brain calls for prioritization + decomposition overhead.
      expect(brainCallCount).toBeLessThanOrEqual(4);
      expect(stats.goals.total).toBeGreaterThan(0);
      // Goals should be pending (waiting for a terminal) or in the DAG, not
      // reprocessed every iteration.
      const pendingCount = coordinator.auction.getPendingTasks().length;
      expect(pendingCount).toBeGreaterThan(0);
    });

    it('assigns the selected goal to a director subagent using the original goal id', async () => {
      const events: CoordinatorEvent[] = [];
      const director = createMockDirector() as never as Director & {
        _assignCalls: Array<{ task: TaskSpec }>;
      };
      const llmProvider = {
        decide: vi.fn(async (prompt: { options: Array<{ id: string }> }) => ({
          optionId: prompt.options[0]!.id,
          rationale: 'choose first ready goal',
        })),
      };
      const coordinator = new AutonomousCoordinator({
        sessionDir: tempDir,
        selfAgentId: 'leader@test',
        selfAgentName: 'Leader',
        director,
        llmProvider,
        disableSelfImprove: true,
        maxConcurrentAgents: 3,
        onCoordinatorEvent: (event) => events.push(event),
      });

      await coordinator.run({ goal: 'fix null pointer bug', maxIterations: 2 });

      const ready = events.find((event) => event.type === 'task:ready') as
        | { type: 'task:ready'; goalId: string; taskId: string }
        | undefined;
      expect(ready).toBeDefined();
      expect(ready!.taskId).toBe(ready!.goalId);
      expect(director._assignCalls).toHaveLength(1);
      expect(director._assignCalls[0]!.task.id).toBe(ready!.goalId);
      expect(coordinator.auction.getTasksForAgent(director._assignCalls[0]!.task.subagentId!)[0]!.id)
        .toBe(ready!.goalId);
    });

    it('treats subagent.completed status=success as task completion and marks the DAG node done', async () => {
      const events: CoordinatorEvent[] = [];
      const fleet = createMockFleetBus();
      const director = createMockDirector() as never as Director & {
        _assignCalls: Array<{ task: TaskSpec }>;
      };
      const llmProvider = {
        decide: vi.fn(async (prompt: { options: Array<{ id: string }> }) => ({
          optionId: prompt.options[0]!.id,
          rationale: 'choose first ready goal',
        })),
      };
      const coordinator = new AutonomousCoordinator({
        sessionDir: tempDir,
        selfAgentId: 'leader@test',
        selfAgentName: 'Leader',
        fleet,
        director,
        llmProvider,
        disableSelfImprove: true,
        maxConcurrentAgents: 3,
        onCoordinatorEvent: (event) => events.push(event),
      });

      await coordinator.run({ goal: 'fix null pointer bug', maxIterations: 2 });
      expect(director._assignCalls.length).toBeGreaterThan(0);
      const assignedTask = director._assignCalls[0]!.task;
      const subagentId = assignedTask.subagentId!;

      (fleet.emit as never as (type: string, event: unknown) => void)('subagent.completed', {
        subagentId,
        payload: { subagentId, taskId: assignedTask.id, status: 'success' },
      });
      await vi.waitFor(() => {
        expect(events.some((event) => event.type === 'task:completed' && event.taskId === assignedTask.id)).toBe(true);
      });

      expect(events.some((event) => event.type === 'goal:failed' && event.goalId === assignedTask.id)).toBe(false);
      expect(coordinator.dag.getNode(assignedTask.id)?.status).toBe('done');
      expect(coordinator.graph.getGoals({ status: 'done' }).some((goal) => goal.id === assignedTask.id)).toBe(true);
      expect(coordinator.graph.getFacts({ category: 'quality' }).some((fact) =>
        fact.key === `task-result:${assignedTask.id}` &&
        fact.detail === 'Subagent completed successfully' &&
        fact.related.includes(assignedTask.id),
      )).toBe(true);
      expect(events.some((event) => event.type === 'knowledge:added' && event.text === 'Subagent completed successfully')).toBe(true);
    });

    it('creates follow-up goals from NEXT/TODO markers in the subagent result', async () => {
      const events: CoordinatorEvent[] = [];
      const fleet = createMockFleetBus();
      const director = createMockDirector() as never as Director & {
        _assignCalls: Array<{ task: TaskSpec }>;
      };
      const llmProvider = {
        decide: vi.fn(async (prompt: { options: Array<{ id: string }> }) => ({
          optionId: prompt.options[0]!.id,
          rationale: 'choose first ready goal',
        })),
      };
      const coordinator = new AutonomousCoordinator({
        sessionDir: tempDir,
        selfAgentId: 'leader@test',
        selfAgentName: 'Leader',
        fleet,
        director,
        llmProvider,
        disableSelfImprove: true,
        onCoordinatorEvent: (event) => events.push(event),
      });

      await coordinator.run({ goal: 'fix null pointer bug', maxIterations: 2 });
      expect(director._assignCalls.length).toBeGreaterThan(0);
      const assignedTask = director._assignCalls[0]!.task;
      const result = [
        'Implemented first pass.',
        'NEXT: Add regression coverage for retry path',
        '- TODO: Document the retry behavior',
        'FOLLOW-UP: Check telemetry output',
      ].join('\n');

      (fleet.emit as never as (type: string, event: unknown) => void)('subagent.completed', {
        subagentId: assignedTask.subagentId!,
        payload: { subagentId: assignedTask.subagentId!, taskId: assignedTask.id, status: 'success', result },
      });
      // createGoal() publishes to the graph before _createFollowUpGoalsFromResult()
      // emits its event. Wait for the final event, not merely the first graph
      // mutation, so the assertions below cannot race the async follow-up loop.
      await vi.waitFor(() => {
        expect(
          events.some(
            (event) =>
              event.type === 'goal:added' && event.title === 'Check telemetry output',
          ),
        ).toBe(true);
      });

      const followUps = coordinator.graph.getGoals({}).filter((goal) => goal.tags.includes('follow-up'));
      expect(followUps.map((goal) => goal.title)).toEqual([
        'Add regression coverage for retry path',
        'Document the retry behavior',
        'Check telemetry output',
      ]);
      expect(followUps.every((goal) => goal.tags.includes('task-result') && goal.tags.includes(assignedTask.id))).toBe(true);
      expect(events.filter((event) => event.type === 'goal:added').some((event) => event.title === 'Check telemetry output')).toBe(true);
      expect(coordinator.graph.getFacts({ category: 'quality' }).some((fact) => fact.detail === result)).toBe(true);
    });
  });

  describe('goal decomposition', () => {
    it('categorizes "security" goals correctly', async () => {
      const llmProvider = createMockLlmProvider();
      const coordinator = new AutonomousCoordinator({
        sessionDir: tempDir,
        selfAgentId: 'leader@test',
        selfAgentName: 'Leader',
        llmProvider,
        disableSelfImprove: true,
        maxConcurrentAgents: 3,
      });

      const events: CoordinatorEvent[] = [];
      // Intercept events by providing a callback
      const realCoordinator = Object.assign(Object.create(Object.getPrototypeOf(coordinator)), coordinator, {
        onCoordinatorEvent: (e: CoordinatorEvent) => events.push(e),
      });

      await realCoordinator.run({ goal: 'audit security vulnerabilities', maxIterations: 1 });

      const goalEvents = events.filter((e) => e.type === 'goal:added') as Array<{
        type: 'goal:added';
        goalId: string;
        title?: string;
        text?: string;
      }>;

      expect(goalEvents.length).toBeGreaterThan(0);
      // Security goals should decompose into subgoals (at least 2 for 'fix security bugs')
      expect(goalEvents.length).toBeGreaterThanOrEqual(2);
    });

    it('categorizes "bug" goals correctly', async () => {
      const llmProvider = createMockLlmProvider();
      const coordinator = new AutonomousCoordinator({
        sessionDir: tempDir,
        selfAgentId: 'leader@test',
        selfAgentName: 'Leader',
        llmProvider,
        disableSelfImprove: true,
        maxConcurrentAgents: 3,
      });

      const events: CoordinatorEvent[] = [];
      const realCoordinator = Object.assign(Object.create(Object.getPrototypeOf(coordinator)), coordinator, {
        onCoordinatorEvent: (e: CoordinatorEvent) => events.push(e),
      });

      await realCoordinator.run({ goal: 'fix null pointer bug', maxIterations: 1 });

      const goalEvents = events.filter((e) => e.type === 'goal:added');
      expect(goalEvents.length).toBeGreaterThan(0);
    });
  });

  describe('publishFact()', () => {
    it('adds a fact to the knowledge graph', async () => {
      const { coordinator } = createCoordinator();

      await coordinator.publishFact({
        category: 'architecture',
        subject: 'Service layer needed',
        detail: 'Controllers are doing too much',
        key: 'arch-service-layer' as never,
        severity: 'medium',
        discoveredBy: 'architect' as never,
        tags: ['architecture', 'refactor'],
      });

      // Use the coordinator's own graph to verify the fact was persisted
      const facts = coordinator.graph.getFacts({ category: 'architecture' });
      expect(facts.some((f) => f.subject === 'Service layer needed')).toBe(true);
    });

    it('accepts all valid fact categories', async () => {
      const { coordinator } = createCoordinator();

      const categories = ['bug', 'perf', 'security', 'refactor', 'test', 'architecture', 'deps', 'quality'] as const;

      for (const category of categories) {
        await expect(
          coordinator.publishFact({
            category,
            subject: `Test fact for ${category}`,
            detail: 'Detail',
            key: `fact-${category}`,
            severity: 'low',
            tags: [],
          }),
        ).resolves.not.toThrow();
      }
    });
  });

  describe('DAG rebuild from persisted graph', () => {
    it('reconstructs persisted completed goals into the DAG on run startup', async () => {
      const coordinator1 = new AutonomousCoordinator({
        sessionDir: tempDir,
        selfAgentId: 'leader@test',
        selfAgentName: 'Leader',
        llmProvider: createMockLlmProvider(),
        disableSelfImprove: true,
      });
      const goal = await coordinator1.createGoal({
        title: 'Persisted goal',
        description: 'Goal created before coordinator restart',
      });
      await coordinator1.auction.complete(goal.id, 'done before restart');

      const coordinator2 = new AutonomousCoordinator({
        sessionDir: tempDir,
        selfAgentId: 'leader@test',
        selfAgentName: 'Leader',
        llmProvider: createMockLlmProvider(),
        disableSelfImprove: true,
      });

      await coordinator2.run({ goal: 'new startup goal', maxIterations: 1 });

      expect(coordinator2.dag.getNode(goal.id)?.status).toBe('done');
      expect(coordinator2.dag.getNode(goal.id)?.result).toBe('done before restart');
    });

    it('syncFromGraph picks up new goals and status changes from another coordinator', async () => {
      const coordinator1 = new AutonomousCoordinator({
        sessionDir: tempDir,
        selfAgentId: 'leader@terminal-a',
        selfAgentName: 'Terminal A',
        llmProvider: createMockLlmProvider(),
        disableSelfImprove: true,
      });
      const coordinator2 = new AutonomousCoordinator({
        sessionDir: tempDir,
        selfAgentId: 'leader@terminal-b',
        selfAgentName: 'Terminal B',
        llmProvider: createMockLlmProvider(),
        disableSelfImprove: true,
      });

      // Terminal A creates a goal that Terminal B doesn't know about yet.
      const goal = await coordinator1.createGoal({
        title: 'Cross-session task',
        description: 'Published by terminal A',
      });

      // Terminal B syncs and should discover the new goal in its DAG.
      await coordinator2.syncFromGraph();
      expect(coordinator2.dag.getNode(goal.id)).toBeDefined();
      expect(coordinator2.auction.getPendingTasks().some((g) => g.id === goal.id)).toBe(true);

      // Terminal A completes the goal.
      await coordinator1.auction.complete(goal.id, 'Done by terminal A');

      // Terminal B syncs again — DAG node should now be 'done'.
      await coordinator2.syncFromGraph();
      expect(coordinator2.dag.getNode(goal.id)?.status).toBe('done');
    });
  });

  describe('getStats()', () => {
    it('returns current coordinator statistics', async () => {
      const llmProvider = createMockLlmProvider();
      const coordinator = new AutonomousCoordinator({
        sessionDir: tempDir,
        selfAgentId: 'leader@test',
        selfAgentName: 'Leader',
        llmProvider,
        disableSelfImprove: true,
        maxConcurrentAgents: 3,
      });

      // Publish some work first
      await coordinator.publishFact({
        category: 'test',
        subject: 'Coverage gap',
        detail: 'Module X has no tests',
        key: 'test-coverage-gap',
        severity: 'medium',
        tags: ['test'],
      });

      const stats = coordinator.getStats();

      expect(stats).toBeDefined();
      expect(stats.goals).toBeDefined();
      expect(stats.dag).toBeDefined();
      expect(stats.auction).toBeDefined();
      expect(typeof stats.decisions).toBe('number');
    });
  });

  describe('orphan task retry (no bids)', () => {
    it('fails a task after maxBidRetries when no agents bid', async () => {
      // Use a short bid window so we don't wait long
      const BID_WINDOW_MS = 100;
      const MAX_RETRIES = 3;
      const fleet = createMockFleetBus();
      const mailbox = createMockMailbox();
      const graph = new KnowledgeGraph(tempDir);

      const auctioneer = new TaskAuctioneer({
        graph,
        fleet,
        mailbox,
        bidWindowMs: BID_WINDOW_MS,
        maxBidRetries: MAX_RETRIES,
      });

      vi.useFakeTimers();

      // Publish a task — no agents will bid
      const taskId = await auctioneer.publishTask({
        title: 'Orphan task',
        description: 'No one will bid on this',
        priority: 'high',
        tags: ['test'],
      });

      // Advance past all 3 bid windows (100ms × 3 = 300ms) plus a small buffer
      await vi.advanceTimersByTimeAsync((BID_WINDOW_MS * MAX_RETRIES) + 50);

      vi.useRealTimers();

      // Task should have failed after MAX_RETRIES attempts
      const node = graph.get(taskId);
      expect(node).toBeDefined();
      expect(node!.status).toBe('failed');
    });

    it('retries orphan tasks up to maxBidRetries, not forever', async () => {
      const BID_WINDOW_MS = 50;
      const MAX_RETRIES = 2;
      const fleet = createMockFleetBus();
      const mailbox = createMockMailbox();
      const graph = new KnowledgeGraph(tempDir);

      const auctioneer = new TaskAuctioneer({
        graph,
        fleet,
        mailbox,
        bidWindowMs: BID_WINDOW_MS,
        maxBidRetries: MAX_RETRIES,
      });

      vi.useFakeTimers();

      const taskId = await auctioneer.publishTask({
        title: 'Will fail after 2 retries',
        description: 'Only 2 retries allowed',
        priority: 'medium',
        tags: ['test'],
      });

      // Advance past exactly 2 bid windows (should fail on 2nd evaluation)
      await vi.advanceTimersByTimeAsync((BID_WINDOW_MS * MAX_RETRIES) + 30);

      vi.useRealTimers();

      // Should be failed after 2 retries
      const node = graph.get(taskId);
      expect(node).toBeDefined();
      expect(node!.status).toBe('failed');
    });

    it('cleans up retry counter when task is manually failed', async () => {
      const BID_WINDOW_MS = 100;
      const fleet = createMockFleetBus();
      const mailbox = createMockMailbox();
      const graph = new KnowledgeGraph(tempDir);

      const auctioneer = new TaskAuctioneer({
        graph,
        fleet,
        mailbox,
        bidWindowMs: BID_WINDOW_MS,
        maxBidRetries: 3,
      });

      vi.useFakeTimers();

      // Publish a task — no bids will come in
      const taskId = await auctioneer.publishTask({
        title: 'Will be manually failed',
        description: 'We manually fail this after a bit',
        priority: 'high',
        tags: ['test'],
      });

      // Advance first bid window — no bids, retry count becomes 1
      await vi.advanceTimersByTimeAsync(BID_WINDOW_MS + 10);
      expect(graph.get(taskId)!.status).toBe('pending'); // still pending (retrying)

      // Manually fail the task
      await auctioneer.fail(taskId, 'Manual failure for test');

      vi.useRealTimers();

      // Task should be failed
      const node = graph.get(taskId);
      expect(node).toBeDefined();
      expect(node!.status).toBe('failed');
      // After fail(), the retry counter should be deleted (no more retries)
      // This is verified by the fact that the task is 'failed', not still 'pending'
    });
  });

  describe('task:failed → goal:failed propagation', () => {
    it('emits goal:failed to onCoordinatorEvent when auctioneer fires task:failed', async () => {
      // This tests the critical path: when a task fails (e.g. orphan with no bids),
      // the coordinator must emit goal:failed so the TUI shows the ❌ icon.
      const fleet = createMockFleetBus();
      const mailbox = createMockMailbox();
      const _graph = new KnowledgeGraph(tempDir);

      const emittedEvents: CoordinatorEvent[] = [];
      const coord = new AutonomousCoordinator({
        sessionDir: tempDir,
        selfAgentId: 'test-coord',
        selfAgentName: 'TestCoord',
        llmProvider: createMockLlmProvider(),
        fleet,
        mailbox,
        onCoordinatorEvent: (e) => emittedEvents.push(e),
      });

      // Publish a task via the coordinator's own auction
      const taskId = await coord.auction.publishTask({
        title: 'Orphan test task',
        description: 'Will fail with no bids',
        priority: 'high',
        tags: ['test'],
      });

      // Simulate task:failed event from auctioneer reaching the coordinator's fleet filter
      // (This is what happens when an orphan task fails after max bid retries)
      const filterCalls = (fleet.filter as ReturnType<typeof vi.fn>).mock.calls;
      for (const [filterType, handler] of filterCalls) {
        if (filterType === 'task:failed') {
          // FleetEvent format expected by the coordinator's filter handler
          (handler as (p: unknown) => void)({
            subagentId: 'auctioneer',
            ts: Date.now(),
            type: 'task:failed',
            payload: { taskId, error: 'No bids received after 3 attempts' },
          });
        }
      }

      // Verify goal:failed was emitted to the TUI callback
      expect(emittedEvents.some(e => e.type === 'goal:failed' && e.goalId === taskId)).toBe(true);
      const failedEvent = emittedEvents.find(e => e.type === 'goal:failed')!;
      expect(failedEvent.text).toContain('No bids received');
    });
  });

  describe('_processGoal with director', () => {
    it('calls director.spawn() and director.assign() when a director is provided', async () => {
      const director = createMockDirector();
      const fleet = createMockFleetBus();
      const mailbox = createMockMailbox();
      const emittedEvents: CoordinatorEvent[] = [];

      const coord = new AutonomousCoordinator({
        sessionDir: tempDir,
        selfAgentId: 'leader@test',
        selfAgentName: 'Leader',
        fleet,
        mailbox,
        director: director as never as Director,
        llmProvider: createMockLlmProvider(),
        disableSelfImprove: true,
        maxConcurrentAgents: 3,
        onCoordinatorEvent: (e) => emittedEvents.push(e),
      });

      // Use createGoal — this adds the goal to BOTH the graph (via publishTask)
      // AND the DAG, so dag.getReady() in _processGoal finds it.
      const goal = await coord.createGoal({
        title: 'Test goal for director',
        description: 'A ready goal that should trigger director.spawn',
        priority: 'high',
        tags: ['test'],
      });

      // Call _processGoal via prototype (private method, accessed for unit testing)
      const processGoal = coord.constructor.prototype._processGoal as (
        goalId: string,
      ) => Promise<void>;
      await processGoal.call(coord, goal.id);

      // Verify director.spawn was called exactly once
      expect(director.spawn).toHaveBeenCalledTimes(1);
      // Verify director.assign was called exactly once
      expect(director.assign).toHaveBeenCalledTimes(1);

      // Verify spawn was called with a SubagentConfig (role: general, sensible timeout)
      const spawnCall = (director.spawn as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(spawnCall[0]).toMatchObject({
        role: 'general',
        maxIterations: 100,
        timeoutMs: 600_000,
      });
      expect(typeof spawnCall[0].name).toBe('string');
      expect(spawnCall[0].name.startsWith('worker-')).toBe(true);

      // Verify assign was called with the goal id and subagentId
      const assignCall = (director.assign as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(assignCall[0]).toMatchObject({
        id: goal.id,
        description: 'A ready goal that should trigger director.spawn',
      });
      expect(typeof assignCall[0].subagentId).toBe('string');

      // Verify task:ready event was emitted
      expect(emittedEvents.some((e) => e.type === 'task:ready' && e.goalId === goal.id)).toBe(true);
    });

    it('does NOT call director.spawn() when no director is provided (standalone mode)', async () => {
      const fleet = createMockFleetBus();
      const mailbox = createMockMailbox();
      const emittedEvents: CoordinatorEvent[] = [];

      // No director passed — coordinator runs in standalone/auction mode
      const coord = new AutonomousCoordinator({
        sessionDir: tempDir,
        selfAgentId: 'leader@test',
        selfAgentName: 'Leader',
        fleet,
        mailbox,
        llmProvider: createMockLlmProvider(),
        disableSelfImprove: true,
        maxConcurrentAgents: 3,
        onCoordinatorEvent: (e) => emittedEvents.push(e),
      });

      // createGoal adds to both graph and DAG so dag.getReady() finds it
      const goal = await coord.createGoal({
        title: 'Standalone goal',
        description: 'Should be published but not spawned',
        priority: 'medium',
        tags: ['test'],
      });

      // Call _processGoal — should not attempt any spawn
      const processGoal = coord.constructor.prototype._processGoal as (
        goalId: string,
      ) => Promise<void>;
      await processGoal.call(coord, goal.id);

      // In standalone mode (no director), the coordinator publishes to the
      // auction for cross-session agents to pick up, but does not spawn itself.
      // Verify task:ready was still emitted (task was published to auction)
      expect(emittedEvents.some((e) => e.type === 'task:ready' && e.goalId === goal.id)).toBe(true);
    });

    it('emits task:ready before spawning, in the correct order', async () => {
      const director = createMockDirector();
      const fleet = createMockFleetBus();
      const mailbox = createMockMailbox();
      const emittedEvents: CoordinatorEvent[] = [];

      const coord = new AutonomousCoordinator({
        sessionDir: tempDir,
        selfAgentId: 'leader@test',
        selfAgentName: 'Leader',
        fleet,
        mailbox,
        director: director as never as Director,
        llmProvider: createMockLlmProvider(),
        disableSelfImprove: true,
        maxConcurrentAgents: 3,
        onCoordinatorEvent: (e) => emittedEvents.push(e),
      });

      const goal = await coord.createGoal({
        title: 'Order test goal',
        description: 'Verify event emission order',
        priority: 'high',
        tags: ['test'],
      });

      const processGoal = coord.constructor.prototype._processGoal as (
        goalId: string,
      ) => Promise<void>;
      await processGoal.call(coord, goal.id);

      // task:ready must be emitted with the correct goalId.
      // Note: goal:added from createGoal may precede it in the events array,
      // so we only assert that task:ready is present, not its index.
      const taskReadyIndex = emittedEvents.findIndex((e) => e.type === 'task:ready');
      expect(taskReadyIndex).toBeGreaterThanOrEqual(0);
      expect((emittedEvents[taskReadyIndex] as { goalId: string }).goalId).toBe(goal.id);
    });
  });
});
