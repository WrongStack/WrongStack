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
import type { SubagentConfig } from '../types/multi-agent.js';
import { AutonomousBrain } from './autonomous-brain.js';
import {
  rebuildDagFromGraph,
  syncDagStatuses,
  waitForDagProgress,
} from './autonomous-coordinator-dag-helpers.js';
import {
  buildCoordinatorVoters,
  decomposeGoal,
  extractFollowUps,
  goalToOptions,
  optionToGoal,
  stringifyTaskResult,
} from './autonomous-coordinator-goal-helpers.js';
import type {
  AutonomousCoordinatorOptions,
  CoordinatorEvent,
  CoordinatorStats,
  RunOptions,
} from './autonomous-coordinator-types.js';
import { ChangeManager, DEFAULT_QUALITY_CHECKS } from './change-manager.js';
import { ConsensusProtocol } from './consensus-protocol.js';
import type { Director } from './director.js';
import type { FleetBus, FleetEvent } from './fleet-bus.js';
import type { FleetManager } from './fleet-manager.js';
import type {
  FactCategory,
  FactNode,
  GoalNode,
  GoalPriority,
  QualityCheck,
} from './knowledge-graph.js';
import { KnowledgeGraph } from './knowledge-graph.js';
import type { Mailbox } from './mailbox-types.js';
import { TaskAuctioneer } from './task-auctioneer.js';
import { type DAGEdgeEvent, TaskDAG } from './task-dag.js';

export * from './autonomous-coordinator-types.js';

/**
 * AutonomousCoordinator — wires all coordination components into one engine.
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
      voters: buildCoordinatorVoters(this.selfAgentId),
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
    const offCompleted = this.fleet?.filter('subagent.completed', (e: FleetEvent) => {
      this._onSubagentTerminated(e);
    });
    if (offCompleted) this.unsubs.push(offCompleted);

    const offFailed = this.fleet?.filter('task:failed', (e: FleetEvent) => {
      const payload = e.payload as { taskId: string; error: string } | undefined;
      const taskId = payload?.taskId;
      if (!taskId || this._handledBySubagent.has(taskId)) return;
      this._markHandledBySubagent(taskId);
      this._recordTaskFailed(taskId, payload?.error ?? 'Task failed');
    });
    if (offFailed) this.unsubs.push(offFailed);

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
    this._handledBySubagent.clear();

    const maxIterations = opts.maxIterations ?? 100;
    const goal = opts.goal ?? 'Improve the codebase';
    const maxCost = opts.maxCostUsd;

    try {
      await this.graph.load();
      rebuildDagFromGraph(this.graph, this.dag);

      // Phase 1: Decompose the goal into sub-goals
      const goalConfigs = await decomposeGoal(goal);
      for (const g of goalConfigs) {
        const goalId = await this.auction.publishTask(g);
        this.dag.addNode(goalId, g.description, []);
        this._emit({ type: 'goal:added', goalId, title: g.title, text: g.description });
      }

      // Phase 2: Run the autonomous loop
      while (this.running) {
        if (this.dag.getRunning().length > 0 && this.auction.getPendingTasks().length === 0) {
          await waitForDagProgress(this.dag, 1_000);
          continue;
        }

        this.iterationCount++;
        await this._maybeSyncFromGraph();

        if (this.iterationCount >= maxIterations) break;
        if (maxCost !== undefined) {
          const cost = this.fleetManager?.snapshot()?.total?.cost ?? 0;
          if (cost >= maxCost) break;
        }
        if (opts.runUntilComplete && this.dag.isDone()) break;

        const pendingTasks = this.auction.getPendingTasks();
        const dispatchable = pendingTasks.filter((task) => {
          const dagNode = this.dag.getNode(task.id);
          return !dagNode || dagNode.status === 'ready';
        });

        if (dispatchable.length === 0) {
          if (this.dag.getRunning().length > 0 || this.dag.getReady().length > 0) {
            await waitForDagProgress(this.dag, 1_000);
            continue;
          }
          if (pendingTasks.length > 0) {
            await waitForDagProgress(this.dag, 2_000);
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

        const decision = await this.brain.decideAuto({
          id: randomUUID(),
          source: 'system',
          decisionType: 'prioritize_goals',
          question: `What should we work on next? Open goals: ${dispatchable.map((g) => g.title).join(', ')}`,
          context: {
            goals: dispatchable,
            fleetStatus: this._fleetStatus(),
          },
          options: goalToOptions(dispatchable),
          risk: 'medium',
          requiresConsensus: false,
        });

        if (decision.type === 'deny') {
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

        if (decision.type === 'ask_human') {
          this._busEmit('autonomous:ask_human', { prompt: decision.prompt });
          break;
        }

        if (decision.optionId) {
          const goalNode = optionToGoal(this.graph, decision.optionId);
          if (goalNode) {
            await this._processGoal(goalNode.id);
          }
        }

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
   * Report that a terminal worker (not a Director subagent) completed a claimed task.
   */
  async reportTaskCompletion(taskId: string, result: string): Promise<void> {
    this._markHandledBySubagent(taskId);
    await this._completeTask(taskId, result);
  }

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
   * Reload KnowledgeGraph from disk and sync DAG with external updates.
   */
  async syncFromGraph(): Promise<void> {
    await this.graph.load();
    rebuildDagFromGraph(this.graph, this.dag);
    syncDagStatuses(this.graph, this.dag);
  }

  private async _maybeSyncFromGraph(): Promise<void> {
    const now = Date.now();
    if (now - this.lastSyncAt < AutonomousCoordinator.SYNC_INTERVAL_MS) return;
    this.lastSyncAt = now;
    await this.syncFromGraph();
  }

  /**
   * Tear down coordinator and subscriptions.
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
   * Publish a fact discovered by an agent.
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
      ...(input.deps && input.deps.length > 0 ? { blockedBy: input.deps } : {}),
    });

    const goal = this.graph.get(goalId) as GoalNode;

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

  private async _processGoal(goalId: string): Promise<void> {
    const ready = this.dag.getReady();
    if (ready.length === 0) return;

    const dagNode = ready.find((n) => n.id === goalId) ?? ready[0]!;
    this.dag.start(dagNode.id, 'auctioneer');

    const goalNode = this.graph.get(goalId) as GoalNode | undefined;
    if (!goalNode) return;

    const title = goalNode.title || dagNode.description;
    this._emit({ type: 'task:ready', goalId, taskId: goalId, title });

    if (this.director) {
      const config: SubagentConfig = {
        name: `worker-${goalId.slice(0, 8)}`,
        role: 'general',
        maxIterations: 100,
        timeoutMs: 600_000,
      };
      const subagentId = await this.director.spawn(config);
      await this.auction.claim(goalId, subagentId, config.name);
      await this.director.assign({
        id: goalId,
        subagentId,
        description: goalNode.description,
      });
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
    const followUps = extractFollowUps(result);
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
      const voteResult = await this.consensus.castVote(
        change.id,
        this.selfAgentId,
        'reject',
        `Quality gate failed: ${change.qualityGate.checks.map((c) => `${c.name}=${c.passed}`).join(', ')}`,
      );
      if (voteResult.outcome === 'rejected' || voteResult.outcome === 'vetoed') {
        this._emit({
          type: 'consensus:reached',
          goalId: change.id,
          text: 'Change rejected by quality gate',
        });
      }
    }
  }

  private _busEmit(type: string, payload: unknown): void {
    if (!this.events) return;
    (this.events.emit as (type: string, payload: unknown) => void)(type, payload);
  }

  private _onDagEvent(event: DAGEdgeEvent): void {
    if (event.type === 'node:ready') {
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
  }

  private _onSubagentTerminated(e: FleetEvent): void {
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
    const rawStatus = payload?.stopReason ?? payload?.status ?? 'unknown';
    const succeeded = rawStatus === 'end_turn' || rawStatus === 'ok' || rawStatus === 'success';
    const tasks = payload?.taskId
      ? this.auction.getTasksForAgent(subagentId).filter((task) => task.id === payload.taskId)
      : this.auction.getTasksForAgent(subagentId);

    for (const task of tasks) {
      this._markHandledBySubagent(task.id);
      if (succeeded) {
        void this._completeTask(task.id, stringifyTaskResult(payload?.result));
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

  private _emit(event: CoordinatorEvent): void {
    this.onCoordinatorEvent?.(event);
  }
}
