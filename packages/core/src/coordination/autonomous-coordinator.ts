/**
 * CoordinatorEvent — union of all event types emitted by the AutonomousCoordinator.
 * Consumed by the TUI to drive coordinator panel state and the reducer.
 */
export type CoordinatorEvent =
  | { type: 'goal:added'; goalId: string; title?: string; text?: string; participants?: string[] }
  | { type: 'goal:completed'; goalId: string; text?: string; participants?: string[] }
  | { type: 'goal:failed'; goalId: string; text?: string }
  | {
      type: 'task:ready';
      goalId: string;
      taskId: string;
      title?: string;
      assignedTo?: string;
      text?: string;
    }
  | { type: 'task:completed'; goalId: string; taskId: string; text?: string }
  | { type: 'knowledge:added'; knowledgeId: string; title?: string; text?: string }
  | { type: 'consensus:reached'; goalId: string; text?: string; participants?: string[] }
  | { type: 'deadlock:detected'; goalId: string; text?: string }
  | { type: 'coordinator:mode'; mode: 'standalone' | 'fleet' };

/**
 * AutonomousCoordinator — wires all coordination components into one self-directing engine.
 *
 * This is the main entry point for a fully autonomous session. It owns:
 * - KnowledgeGraph   → shared facts, goals, decisions, changes
 * - TaskDAG         → task dependency graph
 * - TaskAuctioneer  → project-wide task marketplace
 * - ConsensusProtocol → agent voting on changes
 * - ChangeManager   → change lifecycle
 * - AutonomousBrain  → LLM-backed decision-making
 * - FleetManager    → subagent lifecycle (spawn/assign/await)
 *
 * ## Self-directing loop
 *
 * The coordinator runs a goal-oriented loop:
 *
 * 1. Brain decides: what needs to be done?
 * 2. Goals are published to the KnowledgeGraph
 * 3. TaskAuctioneer broadcasts them → idle agents bid → winner claims
 * 4. Agent works autonomously, updating goal status
 * 5. On completion: facts are published, next goals unblock
 * 6. For code changes: ConsensusProtocol votes → ChangeManager applies
 * 7. Brain reviews outcomes → self-improves
 *
 * ## Cross-session coordination
 *
 * Everything is backed by JSONL files under `sessionDir/_autonomous/`.
 * Agents in different terminal sessions (TUI, WebUI, REPL) on the same
 * project share the same KnowledgeGraph, TaskDAG, and Mailbox — they see
 * each other's tasks, bids, and results in real time.
 *
 * @module autonomous-coordinator
 */
import { randomUUID } from 'node:crypto';
import type { EventBus } from '../kernel/events.js';
import type { Logger } from '../types/logger.js';
import type { FleetBus, FleetEvent } from './fleet-bus.js';
import type { FleetManager } from './fleet-manager.js';
import type { Mailbox } from './mailbox-types.js';
import type {
  FactNode,
  GoalNode,
  FactCategory,
  GoalPriority,
  QualityCheck,
} from './knowledge-graph.js';
import type { Director } from './director.js';
import type { SubagentConfig } from '../types/multi-agent.js';
import { KnowledgeGraph } from './knowledge-graph.js';
import { TaskDAG, type DAGEdgeEvent } from './task-dag.js';
import { TaskAuctioneer } from './task-auctioneer.js';
import { ConsensusProtocol } from './consensus-protocol.js';
import { ChangeManager, DEFAULT_QUALITY_CHECKS } from './change-manager.js';
import { AutonomousBrain, type LLMProvider } from './autonomous-brain.js';

export interface AutonomousCoordinatorOptions {
  sessionDir: string;
  selfAgentId: string;
  selfAgentName: string;
  fleet?: FleetBus | undefined;
  fleetManager?: FleetManager | undefined;
  director?: Director | undefined;
  mailbox?: Mailbox | undefined;
  events?: EventBus | undefined;
  llmProvider: LLMProvider;
  /** Disable self-improvement. Default: false. */
  disableSelfImprove?: boolean;
  /** Max concurrent subagents. Default: 5. */
  maxConcurrentAgents?: number;
  /**
   * Called with every CoordinatorEvent so the caller (e.g. execution.ts)
   * can forward it to the TUI coordinator panel timeline.
   */
  onCoordinatorEvent?: (event: CoordinatorEvent) => void;
  /** Logger for structured error events. Falls back to console.error when omitted. */
  logger?: Logger | undefined;
}

export interface RunOptions {
  /** Top-level goal description. Default: "Improve the codebase". */
  goal?: string;
  /** If true, the loop runs until all goals are done (no timeout). Default: false. */
  runUntilComplete?: boolean;
  /** Max iterations. Default: 100. */
  maxIterations?: number;
  /** Stop if cost exceeds this. Default: no limit. */
  maxCostUsd?: number;
}

export interface CoordinatorStats {
  goals: { total: number; done: number; pending: number; failed: number; progress: number };
  dag: ReturnType<TaskDAG['stats']>;
  auction: ReturnType<TaskAuctioneer['getStats']>;
  changes: { proposed: number; approved: number; applied: number; rejected: number };
  decisions: number;
  costSoFar?: number | undefined;
}

/**
 * AutonomousCoordinator — wires all coordination components into one engine.
 *
 * ## Quick start
 *
 * ```typescript
 * const coord = new AutonomousCoordinator({
 *   sessionDir: '/tmp/session',
 *   selfAgentId: 'director-1',
 *   selfAgentName: 'Director',
 *   llmProvider: myLLMProvider,
 *   fleet: myFleetBus,
 *   mailbox: myMailbox,
 * });
 *
 * // Run a self-directing session
 * await coord.run({ goal: 'Audit and fix all security issues in the auth module' });
 * ```
 */
export class AutonomousCoordinator {
  readonly graph: KnowledgeGraph;
  readonly dag: TaskDAG;
  readonly auction: TaskAuctioneer;
  readonly consensus: ConsensusProtocol;
  readonly changes: ChangeManager;
  readonly brain: AutonomousBrain;

  private readonly selfAgentId: string;
  private readonly fleet?: FleetBus | undefined;
  private readonly fleetManager?: FleetManager | undefined;
  private readonly director?: Director | undefined;
  private readonly mailbox?: Mailbox | undefined;
  private readonly events?: EventBus | undefined;
  private readonly onCoordinatorEvent?: ((event: CoordinatorEvent) => void) | undefined;
  private readonly logger: Logger | undefined;

  private running = false;
  private iterationCount = 0;
  private lastSyncAt = 0;
  private static readonly SYNC_INTERVAL_MS = 5_000;
  /**
   * Tasks already handled by _onSubagentTerminated (to avoid double goal:failed
   * on a late fleet event). Bounded FIFO: entries must outlive the duplicate-event
   * window but not accumulate for the life of a long autonomous run, so the oldest
   * ids are evicted past a cap. Cleared at the top of run().
   */
  private readonly _handledBySubagent = new Set<string>();
  private static readonly HANDLED_BY_SUBAGENT_MAX = 4096;
  /** FleetBus subscription disposers, detached in dispose(). */
  private readonly unsubs: Array<() => void> = [];

  constructor(opts: AutonomousCoordinatorOptions) {
    this.selfAgentId = opts.selfAgentId;
    this.fleet = opts.fleet ?? undefined;
    this.fleetManager = opts.fleetManager ?? undefined;
    this.director = opts.director ?? undefined;
    this.mailbox = opts.mailbox ?? undefined;
    this.events = opts.events ?? undefined;
    this.onCoordinatorEvent = opts.onCoordinatorEvent;
    this.logger = opts.logger;

    // ── Core shared state ─────────────────────────────────────────────
    this.graph = new KnowledgeGraph(opts.sessionDir);

    // ── Task dependency graph ─────────────────────────────────────────
    this.dag = new TaskDAG();

    // ── Task marketplace ────────────────────────────────────────────────
    this.auction = new TaskAuctioneer({
      graph: this.graph,
      fleet: this.fleet ?? undefined,
      mailbox: this.mailbox ?? undefined,
      selfAgentId: this.selfAgentId,
    });

    // ── Consensus protocol ─────────────────────────────────────────────
    this.consensus = new ConsensusProtocol({
      graph: this.graph,
      fleet: this.fleet ?? undefined,
      voters: this._buildVoters(),
      rules: {
        quorumFraction: 0.5,
        approvalFraction: 0.6,
        vetoRoles: ['critic'], // Critic has veto power
        approvalWeightFraction: 0.5,
      },
    });

    // ── Change manager ─────────────────────────────────────────────────
    this.changes = new ChangeManager({
      graph: this.graph,
      consensus: this.consensus,
      fleet: this.fleet ?? undefined,
      checks: DEFAULT_QUALITY_CHECKS,
    });

    // ── Brain ─────────────────────────────────────────────────────────
    this.brain = new AutonomousBrain({
      llmProvider: opts.llmProvider,
      graph: this.graph,
      fleet: this.fleet ?? undefined,
      selfImprove: !opts.disableSelfImprove,
    });

    // ── Wire DAG events to auction ──────────────────────────────────────
    this.dag.onEvent((event: DAGEdgeEvent) => {
      this._onDagEvent(event);
    });

    // ── Wire fleet events ───────────────────────────────────────────────
    // NOTE: 'subagent.terminated' is never emitted — '_onSubagentTerminated' was
    // dead code. The correct event is 'subagent.completed' (emitted by
    // MultiAgentCoordinator when a subagent finishes with status).
    const offCompleted = this.fleet?.filter('subagent.completed', (e: FleetEvent) => {
      this._onSubagentTerminated(e);
    });
    if (offCompleted) this.unsubs.push(offCompleted);

    // Wire task:failed from auctioneer — emits goal:failed for orphan tasks
    // (subagent terminations are handled separately in _onSubagentTerminated)
    const offFailed = this.fleet?.filter('task:failed', (e: FleetEvent) => {
      const payload = e.payload as { taskId: string; error: string } | undefined;
      const taskId = payload?.taskId;
      if (!taskId || this._handledBySubagent.has(taskId)) return;
      this._markHandledBySubagent(taskId);
      this._recordTaskFailed(taskId, payload?.error ?? 'Task failed');
    });
    if (offFailed) this.unsubs.push(offFailed);

    // Emit initial mode so the TUI can display standalone vs fleet indicator
    this._emit({ type: 'coordinator:mode', mode: this.fleet ? 'fleet' : 'standalone' });
  }

  // ── Public API ───────────────────────────────────────────────────────

  /**
   * Run the autonomous loop until the goal is satisfied or max iterations reached.
   * This is the main entry point for a fully autonomous session.
   */
  async run(opts: RunOptions = {}): Promise<CoordinatorStats> {
    if (this.running) throw new Error('AutonomousCoordinator: already running');
    this.running = true;
    this.iterationCount = 0;
    // Do not carry the dedup guard across runs on the same instance.
    this._handledBySubagent.clear();

    const maxIterations = opts.maxIterations ?? 100;
    const goal = opts.goal ?? 'Improve the codebase';
    const maxCost = opts.maxCostUsd;

    try {
      // Load persisted state (inside try so errors are caught)
      await this.graph.load();

      // Rebuild volatile DAG state from persisted goals before adding new work.
      this._rebuildDagFromGraph();

      // Phase 1: Decompose the goal into sub-goals
      const goalConfigs = await this._decomposeGoal(goal);
      for (const g of goalConfigs) {
        const goalId = await this.auction.publishTask(g);
        // Mirror the published goal into the DAG. _processGoal gates on
        // dag.getReady(), and runUntilComplete / deadlock detection read
        // dag.isDone()/getBlocked(); without a node here the DAG stays empty,
        // so _processGoal is a permanent no-op and isDone() is vacuously true.
        // The decomposed sub-goals carry no inter-dependencies → no deps.
        this.dag.addNode(goalId, g.description, []);
        this._emit({ type: 'goal:added', goalId, title: g.title, text: g.description });
      }

      // Phase 2: Run the autonomous loop
      while (this.running) {
        if (this.dag.getRunning().length > 0 && this.auction.getPendingTasks().length === 0) {
          await this._waitForDagProgress(1_000);
          continue;
        }

        this.iterationCount++;

        // Pick up goals/status changes published by other terminal sessions.
        await this._maybeSyncFromGraph();

        // Check exit conditions
        if (this.iterationCount >= maxIterations) break;
        if (maxCost !== undefined) {
          const cost = this.fleetManager?.snapshot()?.total?.cost ?? 0;
          if (cost >= maxCost) break;
        }
        if (opts.runUntilComplete && this.dag.isDone()) break;

        const pendingTasks = this.auction.getPendingTasks();
        // Filter out tasks that already have a running DAG node — they've been
        // dispatched (to a Director subagent or published to the auction for
        // terminal claiming). Re-processing them wastes a Brain call every
        // iteration and risks duplicate subagent spawns.
        const dispatchable = pendingTasks.filter((task) => {
          const dagNode = this.dag.getNode(task.id);
          return !dagNode || dagNode.status === 'ready';
        });

        if (dispatchable.length === 0) {
          if (this.dag.getRunning().length > 0 || this.dag.getReady().length > 0) {
            // Work is in flight or ready for a terminal to claim. Back off.
            await this._waitForDagProgress(1_000);
            continue;
          }
          // No running, no ready, but tasks are still pending in the auction —
          // they're waiting for a terminal worker to claim them. Back off and
          // let syncFromGraph pick up any cross-session changes.
          if (pendingTasks.length > 0) {
            await this._waitForDagProgress(2_000);
            continue;
          }
          if (this.dag.hasDeadlock()) {
            const blocked = this.dag.getBlocked();
            this._busEmit('autonomous:deadlock', { blocked });
            this._emit({
              type: 'deadlock:detected',
              goalId: blocked[0]?.id ?? '',
              text: `Deadlock detected: ${blocked.map((n) => n.id).join(', ')}`,
            });
          }
          break;
        }

        // Decide: what to work on next?
        const decision = await this.brain.decideAuto({
          id: randomUUID(),
          source: 'system',
          decisionType: 'prioritize_goals',
          question: `What should we work on next? Open goals: ${dispatchable.map((g) => g.title).join(', ')}`,
          context: {
            goals: dispatchable,
            fleetStatus: this._fleetStatus(),
          },
          options: this._goalToOptions(dispatchable),
          risk: 'medium',
          requiresConsensus: false,
        });

        if (decision.type === 'deny') {
          // No clear direction — check for blocked goals
          const blocked = this.dag.getBlocked();
          if (blocked.length > 0 && this.dag.hasDeadlock()) {
            this._busEmit('autonomous:deadlock', { blocked });
            this._emit({
              type: 'deadlock:detected',
              goalId: blocked[0]?.id ?? '',
              text: `Deadlock detected: ${blocked.map((n) => n.id).join(', ')}`,
            });
            this.running = false;
          }
          break;
        }

        // Handle ask_human — can't proceed autonomously, stop
        if (decision.type === 'ask_human') {
          this._busEmit('autonomous:ask_human', { prompt: decision.prompt });
          break;
        }

        // Process the next best goal (answer type)
        if (decision.optionId) {
          const goalNode = this._optionToGoal(decision.optionId);
          if (goalNode) {
            await this._processGoal(goalNode.id);
          }
        }

        // Check for pending changes that need consensus. Guard each one: a
        // consensus/vote error must not abort the whole autonomous loop.
        const pendingChanges = this.changes.getPendingReviews();
        for (const change of pendingChanges) {
          try {
            await this._handlePendingChange(change);
          } catch (err) {
            this._emit({
              type: 'goal:failed',
              goalId: change.id,
              text: `Consensus handling failed: ${err instanceof Error ? err.message : String(err)}`,
            });
          }
        }
      }
    } finally {
      this.running = false;
    }

    return this.getStats();
  }

  /** Stop the autonomous loop. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.logger) {
      this.logger.error('Stop signal received — shutting down', {
        event: 'autonomous_coordinator.stop_signal',
        iteration: this.iterationCount,
      });
    } else {
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'autonomous_coordinator.stop_signal',
          message: 'stop signal received — shutting down',
          iteration: this.iterationCount,
          timestamp: new Date().toISOString(),
        }),
      );
    }
  }

  /**
   * Report that a terminal worker (not a Director subagent) completed a claimed
   * task. This updates the auction, DAG, publishes a task-result fact, and
   * extracts follow-up goals — the same path as subagent completion.
   */
  async reportTaskCompletion(taskId: string, result: string): Promise<void> {
    this._markHandledBySubagent(taskId);
    await this._completeTask(taskId, result);
  }

  /**
   * Record a task id in the bounded dedup guard, evicting the oldest ids once the
   * cap is exceeded. Set preserves insertion order, so the first entry is the
   * oldest — well outside any realistic late-duplicate-event window.
   */
  private _markHandledBySubagent(taskId: string): void {
    this._handledBySubagent.add(taskId);
    while (this._handledBySubagent.size > AutonomousCoordinator.HANDLED_BY_SUBAGENT_MAX) {
      const oldest = this._handledBySubagent.values().next().value;
      if (oldest === undefined) break;
      this._handledBySubagent.delete(oldest);
    }
  }

  /**
   * Report that a terminal worker failed a claimed task.
   */
  async reportTaskFailure(taskId: string, error: string): Promise<void> {
    this._markHandledBySubagent(taskId);
    await this._failTask(taskId, error);
  }

  /**
   * Reload the KnowledgeGraph from disk and sync the in-memory DAG with any
   * changes published by other terminal sessions. New goals are added to the
   * DAG; existing goals whose status changed (e.g. completed by another
   * terminal) are transitioned accordingly.
   *
   * Safe to call at any time — also used internally by the run loop.
   */
  async syncFromGraph(): Promise<void> {
    await this.graph.load();
    this._rebuildDagFromGraph();
    this._syncDagStatuses();
  }

  private _syncDagStatuses(): void {
    const goals = this.graph.getGoals({});
    for (const goal of goals) {
      const dagNode = this.dag.getNode(goal.id);
      if (!dagNode) continue;
      if (goal.status === 'done' && dagNode.status !== 'done' && dagNode.status !== 'failed') {
        this.dag.complete(goal.id, goal.result ?? 'Completed by another session');
      } else if (
        goal.status === 'failed' &&
        dagNode.status !== 'failed' &&
        dagNode.status !== 'done'
      ) {
        this.dag.fail(goal.id, goal.result ?? 'Failed by another session');
      } else if (
        goal.status === 'in_progress' &&
        (dagNode.status === 'ready' || dagNode.status === 'pending')
      ) {
        this.dag.start(goal.id, goal.assignee ?? 'another-session');
      }
    }
  }

  private async _maybeSyncFromGraph(): Promise<void> {
    const now = Date.now();
    if (now - this.lastSyncAt < AutonomousCoordinator.SYNC_INTERVAL_MS) return;
    this.lastSyncAt = now;
    await this.syncFromGraph();
  }

  /**
   * Tear down the coordinator for good: stop the loop and detach all FleetBus
   * subscriptions (this coordinator's + the auctioneer's) plus any open bid
   * timers. Call this when discarding the instance (e.g. `/coordinator stop`
   * that recreates a fresh coordinator on the next start) so handlers and
   * timers don't accumulate across cycles. `stop()` only pauses the loop.
   */
  dispose(): void {
    this.stop();
    for (const off of this.unsubs.splice(0)) {
      try {
        off();
      } catch {
        /* best-effort */
      }
    }
    this.auction.dispose();
  }

  /** Get a stats snapshot. */
  getStats(): CoordinatorStats {
    const dagStats = this.dag.stats();
    const auctionStats = this.auction.getStats();
    const allGoals = this.graph.getGoals({});
    const allChanges = this.graph.getChanges({});
    const allDecisions = this.graph.getDecisions();

    return {
      goals: {
        total: allGoals.length,
        done: allGoals.filter((g) => g.status === 'done').length,
        pending: allGoals.filter((g) => g.status === 'pending').length,
        failed: allGoals.filter((g) => g.status === 'failed').length,
        progress:
          allGoals.length > 0
            ? allGoals.filter((g) => g.status === 'done').length / allGoals.length
            : 0,
      },
      dag: dagStats,
      auction: auctionStats,
      changes: {
        proposed: allChanges.filter((c) => c.status === 'proposed').length,
        approved: allChanges.filter((c) => c.status === 'approved').length,
        applied: allChanges.filter((c) => c.status === 'applied').length,
        rejected: allChanges.filter((c) => c.status === 'rejected').length,
      },
      decisions: allDecisions.length,
      costSoFar: this.fleetManager?.snapshot()?.total?.cost,
    };
  }

  // ── Fact publishing ──────────────────────────────────────────────────

  /**
   * Publish a fact discovered by an agent. Facts are immutable and form
   * the basis for other agents' decisions.
   */
  async publishFact(input: {
    category: FactCategory;
    subject: string;
    detail: string;
    file?: string;
    line?: number;
    severity?: 'critical' | 'high' | 'medium' | 'low';
    tags?: string[];
  }): Promise<FactNode> {
    const fact = (await this.graph.add({
      type: 'fact',
      category: input.category,
      subject: input.subject,
      detail: input.detail,
      file: input.file,
      line: input.line,
      severity: input.severity,
      discoveredBy: this.selfAgentId,
      discoveredAt: new Date().toISOString(),
      tags: input.tags ?? [],
      key: `${input.category}:${input.subject}:${input.file ?? ''}:${input.line ?? ''}`,
      related: [],
    } as Omit<FactNode, 'id'>)) as FactNode;

    // Cross-session broadcast
    await this._mailboxBroadcast({
      type: 'note',
      subject: `[${input.severity ?? 'info'}] ${input.category}: ${input.subject}`,
      body: `**${input.category}**${input.file ? ` in ${input.file}${input.line ? `:${input.line}` : ''}` : ''}\n${input.detail}`,
    });

    this._emit({
      type: 'knowledge:added',
      knowledgeId: fact.id,
      title: input.subject,
      text: input.detail,
    });

    return fact;
  }

  // ── Goal creation helpers ────────────────────────────────────────────

  /**
   * Publish a goal and add it to the DAG.
   */
  async createGoal(input: {
    title: string;
    description: string;
    priority?: 'critical' | 'high' | 'medium' | 'low';
    deps?: string[];
    tags?: string[];
  }): Promise<GoalNode> {
    const resolvedPriority: GoalPriority = input.priority ?? 'medium';
    const goalId = await this.auction.publishTask({
      title: input.title,
      description: input.description,
      priority: resolvedPriority,
      ...(input.tags ? { tags: input.tags } : {}),
      // Mirror the dependency edges into the auction so blocked goals aren't
      // biddable until their deps complete (the DAG tracks the same edges).
      ...(input.deps && input.deps.length > 0 ? { blockedBy: input.deps } : {}),
    });

    const goal = this.graph.get(goalId) as GoalNode;

    // Add to DAG
    for (const depId of input.deps ?? []) {
      this.dag.addNode(
        depId,
        this.graph.get(depId)?.type === 'goal' ? (this.graph.get(depId) as GoalNode).title : depId,
      );
    }
    this.dag.addNode(goalId, input.description, input.deps ?? []);

    return goal;
  }

  // ── Private ───────────────────────────────────────────────────────────

  private _waitForDagProgress(timeoutMs: number): Promise<void> {
    const before = this._dagProgressKey();
    if (this.dag.isDone()) return Promise.resolve();

    return new Promise((resolve) => {
      let off: (() => void) | undefined;
      const timer = setTimeout(() => {
        off?.();
        resolve();
      }, timeoutMs);

      off = this.dag.onEvent(() => {
        if (this._dagProgressKey() === before) return;
        clearTimeout(timer);
        off?.();
        resolve();
      });
    });
  }

  private _dagProgressKey(): string {
    const s = this.dag.stats();
    return `${s.pending}:${s.ready}:${s.running}:${s.done}:${s.failed}:${s.skipped}`;
  }

  private _rebuildDagFromGraph(): void {
    const goals = this.graph.getGoals({});
    const knownGoalIds = new Set(goals.map((goal) => goal.id));
    const added = new Set<string>();
    const remaining = new Map(goals.map((goal) => [goal.id, goal]));

    while (remaining.size > 0) {
      let progressed = false;
      for (const [id, goal] of Array.from(remaining.entries())) {
        const deps = goal.blockedBy.filter((depId) => knownGoalIds.has(depId));
        if (!deps.every((depId) => added.has(depId))) continue;
        this._rebuildDagNode(goal, deps);
        added.add(id);
        remaining.delete(id);
        progressed = true;
      }

      if (!progressed) {
        // Persisted graph has a cycle or dangling dependency set. Preserve the
        // nodes without deps rather than throwing during coordinator startup;
        // the normal deadlock detector will still surface blocked live work.
        for (const [id, goal] of Array.from(remaining.entries())) {
          this._rebuildDagNode(goal, []);
          added.add(id);
          remaining.delete(id);
        }
      }
    }
  }

  private _rebuildDagNode(goal: GoalNode, deps: string[]): void {
    this.dag.addNode(goal.id, goal.description, deps, { tags: goal.tags });
    if (goal.status === 'in_progress') {
      this.dag.start(goal.id, goal.assignee ?? 'unknown');
      return;
    }
    if (goal.status === 'done') {
      this.dag.complete(goal.id, goal.result ?? 'Persisted completion');
      return;
    }
    if (goal.status === 'failed') {
      this.dag.fail(goal.id, goal.result ?? 'Persisted failure');
    }
  }

  private async _decomposeGoal(goalText: string): Promise<
    {
      title: string;
      description: string;
      priority?: 'critical' | 'high' | 'medium' | 'low';
      tags?: string[];
    }[]
  > {
    const category = this._inferCategory(goalText);

    const subGoals: {
      title: string;
      description: string;
      priority?: 'critical' | 'high' | 'medium' | 'low';
      tags?: string[];
    }[] = [];

    if (category === 'security') {
      subGoals.push({
        title: 'Audit for secrets',
        description: 'Scan codebase for hardcoded secrets and API keys',
        priority: 'critical',
        tags: ['security'],
      });
      subGoals.push({
        title: 'Check injection vectors',
        description: 'Find eval, innerHTML, SQL concat, shell injection patterns',
        priority: 'critical',
        tags: ['security', 'injection'],
      });
      subGoals.push({
        title: 'Dependency audit',
        description: 'Run npm/pnpm audit for known CVEs',
        priority: 'high',
        tags: ['security', 'deps'],
      });
    } else if (category === 'bug') {
      subGoals.push({
        title: 'Find bugs',
        description: `Scan for bugs related to: ${goalText}`,
        priority: 'high',
        tags: ['bug'],
      });
      subGoals.push({
        title: 'Fix bugs',
        description: 'Fix discovered bugs with tests',
        priority: 'high',
        tags: ['fix'],
      });
    } else if (category === 'refactor') {
      subGoals.push({
        title: 'Plan refactor',
        description: `Analyze code structure for: ${goalText}`,
        priority: 'medium',
        tags: ['refactor', 'planning'],
      });
      subGoals.push({
        title: 'Implement refactor',
        description: 'Apply the refactoring plan',
        priority: 'medium',
        tags: ['refactor', 'implementation'],
      });
    } else {
      subGoals.push({
        title: goalText,
        description: goalText,
        priority: 'medium',
        tags: [category],
      });
    }

    return subGoals;
  }

  private _inferCategory(goal: string): FactCategory {
    const g = goal.toLowerCase();
    if (g.includes('security') || g.includes('secret') || g.includes('injection'))
      return 'security';
    if (g.includes('bug') || g.includes('fix') || g.includes('error')) return 'bug';
    if (g.includes('refactor') || g.includes('debt') || g.includes('architecture'))
      return 'architecture';
    if (g.includes('test') || g.includes('coverage')) return 'test';
    if (g.includes('perf') || g.includes('speed') || g.includes('optimize')) return 'perf';
    if (g.includes('deps') || g.includes('package') || g.includes('update')) return 'deps';
    return 'quality';
  }

  private async _processGoal(goalId: string): Promise<void> {
    // The DAG handles dependency ordering
    const ready = this.dag.getReady();
    if (ready.length === 0) return;

    const dagNode = ready.find((n) => n.id === goalId) ?? ready[0]!;
    this.dag.start(dagNode.id, 'auctioneer');

    // Look up the full GoalNode from the knowledge graph to get the title
    const goalNode = this.graph.get(goalId) as GoalNode | undefined;
    if (!goalNode) return;

    const title = goalNode.title || dagNode.description;

    this._emit({ type: 'task:ready', goalId, taskId: goalId, title });

    // Spawn a subagent to work on this goal — the director handles lifecycle
    // (spawn → assign → listen for subagent.completed → mark done/failed).
    // If no director is available, the original auctioned goal remains visible
    // for other fleet agents to bid on.
    if (this.director) {
      const config: SubagentConfig = {
        name: `worker-${goalId.slice(0, 8)}`,
        role: 'general',
        maxIterations: 100,
        timeoutMs: 600_000, // 10 minutes per goal
      };
      const subagentId = await this.director.spawn(config);
      // Claim the original goal task. Publishing a second task here splits the
      // task id from the DAG goal id and completion events can update the wrong
      // record; the decomposed goal is already in the auction from run()/createGoal().
      await this.auction.claim(goalId, subagentId, config.name);
      await this.director.assign({
        id: goalId,
        subagentId,
        description: goalNode.description,
      });
    }
    // When director is absent (standalone, no fleet), another agent in the
    // fleet will pick up the original published task via the auctioneer — no
    // wait polling needed here; completion is reported via the fleet bus.
  }

  private _stringifyTaskResult(result: unknown): string {
    if (typeof result === 'string' && result.trim()) return result.trim();
    if (result === undefined || result === null) return 'Subagent completed successfully';
    try {
      return JSON.stringify(result);
    } catch {
      return String(result);
    }
  }

  private async _completeTask(taskId: string, result: string): Promise<void> {
    await this.auction.complete(taskId, result);
    if (this.dag.getNode(taskId)) {
      this.dag.complete(taskId, result);
    }
    await this._publishTaskResultFact(taskId, result);
    await this._createFollowUpGoalsFromResult(taskId, result);
    this._emit({ type: 'task:completed', goalId: taskId, taskId, text: result });
  }

  private async _publishTaskResultFact(taskId: string, result: string): Promise<void> {
    const key = `task-result:${taskId}`;
    if (this.graph.getFacts({ category: 'quality' }).some((fact) => fact.key === key)) return;
    const goal = this.graph.get(taskId) as GoalNode | undefined;
    const subject =
      goal?.type === 'goal' ? `Task completed: ${goal.title}` : `Task completed: ${taskId}`;
    const fact = (await this.graph.add({
      type: 'fact',
      category: 'quality',
      subject,
      detail: result,
      discoveredBy: this.selfAgentId,
      discoveredAt: new Date().toISOString(),
      tags: ['task-result', 'autonomous-coordinator'],
      key,
      related: [taskId],
    } as Omit<FactNode, 'id'>)) as FactNode;
    this._emit({ type: 'knowledge:added', knowledgeId: fact.id, title: subject, text: result });
  }

  private async _createFollowUpGoalsFromResult(taskId: string, result: string): Promise<void> {
    const followUps = this._extractFollowUps(result);
    if (followUps.length === 0) return;

    const existing = this.graph.getGoals({});
    for (const title of followUps) {
      if (existing.some((goal) => goal.title === title && goal.tags.includes('follow-up')))
        continue;
      const goal = await this.createGoal({
        title,
        description: title,
        priority: 'medium',
        tags: ['follow-up', 'task-result', taskId],
      });
      this._emit({
        type: 'goal:added',
        goalId: goal.id,
        title: goal.title,
        text: goal.description,
      });
    }
  }

  private _extractFollowUps(result: string): string[] {
    const found: string[] = [];
    for (const line of result.split(/\r?\n/)) {
      const match = /^\s*(?:[-*]\s*)?(?:NEXT|TODO|FOLLOW-?UP):\s*(.+)$/i.exec(line);
      const text = match?.[1]?.trim();
      if (!text || found.includes(text)) continue;
      found.push(text);
      if (found.length >= 5) break;
    }
    return found;
  }

  private async _failTask(taskId: string, error: string): Promise<void> {
    await this.auction.fail(taskId, error);
    this._recordTaskFailed(taskId, error);
  }

  private _recordTaskFailed(taskId: string, error: string): void {
    if (this.dag.getNode(taskId)) {
      this.dag.fail(taskId, error);
    }
    this._emit({ type: 'goal:failed', goalId: taskId, text: error });
  }

  private async _handlePendingChange(change: {
    id: string;
    qualityGate: { passed: boolean; checks: QualityCheck[] };
  }): Promise<void> {
    const result = this.consensus.getStatus(change.id);
    if (result?.outcome !== 'pending') return;

    // Auto-vote if we have quality gate results
    if (change.qualityGate.passed) {
      const voteResult = await this.consensus.castVote(
        change.id,
        this.selfAgentId,
        'approve',
        `Quality gate passed: ${change.qualityGate.checks.map((c) => c.name).join(', ')}`,
      );
      if (voteResult.outcome === 'approved') {
        await this.changes.markApplied(change.id, new Date().toISOString());
        this._emit({
          type: 'consensus:reached',
          goalId: change.id,
          text: 'Change approved and applied',
        });
      }
    } else {
      // Quality gate failed — reject the change outright
      const voteResult = await this.consensus.castVote(
        change.id,
        this.selfAgentId,
        'reject',
        `Quality gate failed: ${change.qualityGate.checks.map((c) => `${c.name}=${c.passed}`).join(', ')}`,
      );
      if (voteResult.outcome === 'rejected' || voteResult.outcome === 'vetoed') {
        // Status update (rejected) is handled inside castVote via graph.update
        this._emit({
          type: 'consensus:reached',
          goalId: change.id,
          text: 'Change rejected by quality gate',
        });
      }
    }
  }

  /** Emit on the optional shared bus; no-op when no bus was wired. */
  private _busEmit(type: string, payload: unknown): void {
    if (!this.events) return;
    (this.events.emit as (type: string, payload: unknown) => void)(type, payload);
  }

  private _onDagEvent(event: DAGEdgeEvent): void {
    if (event.type === 'node:ready') {
      // A new task became runnable — broadcast it
      const node = this.dag.getNode(event.nodeId);
      if (node) {
        this._busEmit('autonomous:task_ready', {
          taskId: event.nodeId,
          description: node.description,
        });
      }
    }
    if (event.type === 'graph:done') {
      this._busEmit('autonomous:all_done', this.getStats());
    }
    // Note: 'deadlock' events are handled exclusively in the main run() loop
    // (line 286-289) to avoid duplicate autonomous:deadlock emissions.
  }

  private _onSubagentTerminated(e: FleetEvent): void {
    // Handle both the old 'stopReason' format and the 'subagent.completed' format
    const payload = e.payload as
      | {
          subagentId?: string;
          stopReason?: string;
          status?: 'ok' | 'success' | 'error' | 'timeout' | 'aborted' | 'failed' | 'stopped';
          taskId?: string;
          result?: unknown;
        }
      | undefined;
    const subagentId = payload?.subagentId ?? e.subagentId;
    // 'stopReason' is from the old format; 'status' is from 'subagent.completed'.
    // MultiAgentCoordinator emits status='success' for a clean finish; older
    // coordinator integrations used 'ok' or stopReason='end_turn'. Treat all
    // clean variants as success so successful subagents do not fail their goal.
    const rawStatus = payload?.stopReason ?? payload?.status ?? 'unknown';
    const succeeded = rawStatus === 'end_turn' || rawStatus === 'ok' || rawStatus === 'success';
    const tasks = payload?.taskId
      ? this.auction.getTasksForAgent(subagentId).filter((task) => task.id === payload.taskId)
      : this.auction.getTasksForAgent(subagentId);

    for (const task of tasks) {
      this._markHandledBySubagent(task.id); // prevent double-emission when fleet fires task:failed
      if (succeeded) {
        void this._completeTask(task.id, this._stringifyTaskResult(payload?.result));
      } else {
        void this._failTask(task.id, `Subagent terminated: ${rawStatus}`);
      }
    }
  }

  private _fleetStatus() {
    return {
      running: this.fleetManager?.getFleetStats().running ?? 0,
      idle: this.fleetManager?.getFleetStats().idle ?? 0,
      total: this.fleetManager?.getFleetStats().total ?? 0,
      costSoFar: this.fleetManager?.snapshot()?.total?.cost ?? 0,
    };
  }

  private _buildVoters() {
    return [
      // The coordinator itself casts the quality-gate auto-vote in
      // _handlePendingChange — it MUST be a registered, eligible voter or
      // castVote throws "unknown voter" and tears down the run() loop.
      { agentId: this.selfAgentId, agentName: 'Coordinator', role: 'coordinator', weight: 1 },
      { agentId: 'critic', agentName: 'Critic', role: 'critic', weight: 2, veto: true },
      { agentId: 'bug-hunter', agentName: 'Bug Hunter', role: 'bug-hunter', weight: 1.5 },
      {
        agentId: 'security-scanner',
        agentName: 'Security Scanner',
        role: 'security-scanner',
        weight: 1.5,
      },
      { agentId: 'audit-log', agentName: 'Audit Log', role: 'audit-log', weight: 1 },
      {
        agentId: 'refactor-planner',
        agentName: 'Refactor Planner',
        role: 'refactor-planner',
        weight: 1,
      },
    ];
  }

  private _goalToOptions(
    goals: GoalNode[],
  ): { id: string; label: string; recommended?: boolean }[] {
    return goals.slice(0, 5).map((g, i) => ({
      id: g.id,
      label: `[${g.priority}] ${g.title}`,
      recommended: i === 0,
    }));
  }

  private _optionToGoal(optionId: string): GoalNode | undefined {
    return this.graph.get(optionId) as GoalNode | undefined;
  }

  private async _mailboxBroadcast(msg: {
    type: 'note' | 'broadcast';
    subject: string;
    body: string;
  }): Promise<void> {
    if (!this.mailbox) return;
    try {
      await this.mailbox.send({
        from: this.selfAgentId,
        to: '*',
        type: msg.type,
        subject: msg.subject,
        body: msg.body,
        priority: 'normal',
      });
    } catch {
      /* best-effort */
    }
  }

  /** Emit a CoordinatorEvent to the subscriber (e.g. TUI panel timeline). */
  private _emit(event: CoordinatorEvent): void {
    this.onCoordinatorEvent?.(event);
  }
}
