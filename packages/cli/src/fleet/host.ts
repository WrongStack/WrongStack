import { randomUUID } from 'node:crypto';
/**
 * L1-E: Multi-agent CLI integration. The coordinator + per-task agent
 * factory is created lazily on the first `/spawn` so users who never use
 * subagents don't pay the construction cost.
 */
import {
  createProjectAgentRoster,
  LearningOptimizationScheduler,
  type LearningOptimizerLlm,
  listProjectAgentRoles,
  resolveAutoOptimizePolicy,
} from '@wrongstack/core/agent-catalog';
import {
  AdaptiveConcurrencyController,
  type AgentFactory,
  DEFAULT_MAX_FLEET_SPAWNS,
  type DefaultMultiAgentCoordinator,
  Director,
  type DirectorSessionFactory,
  FLEET_ROSTER,
  type FleetSupervisor,
  HARD_MAX_SPAWN_DEPTH,
  makeDirectorSessionFactory,
  makeFleetEmitTool,
  resolveProjectDir,
  resolveSubagentModelTarget,
  type TaskResultNotification,
} from '@wrongstack/core/coordination';
import { TOKENS } from '@wrongstack/core/kernel';
import { ToolRegistry } from '@wrongstack/core/registry';
import type { SubagentRunner } from '@wrongstack/core/types';
import {
  AgentError,
  type Config,
  type SubagentConfig,
  type TaskResult,
  type Tool,
} from '@wrongstack/core/types';

import { wstackGlobalRoot } from '@wrongstack/core/utils';
import { HostAcpRunnerCache } from './host-acp-runner-cache.js';
import { normalizeMaxConcurrent } from './host-concurrency.js';
import { createHostFleetManager, prepareHostDirectorRuntime } from './host-director-builder.js';
import {
  installDirectorTaskCompletedHandler,
  registerCoordinatorLifecycleHandlers,
  registerDirectorBudgetAndContextBridges,
  registerDirectorStatsBridge,
  registerDirectorSubagentLifecycleBridges,
} from './host-director-event-bridges.js';
import {
  createHostStatusBroadcaster,
  startDirectorAgentMonitor,
} from './host-director-services.js';
import { makeFleetWorktreeConflictResolver, selectSubagentTools } from './host-helpers.js';
import { HostLearningRoleTracker } from './host-learning-tracker.js';
import { emitHostLifecycleCompleted } from './host-lifecycle-events.js';
import { applyFleetRootDefaults } from './host-paths.js';
import { runHostShadowPass, stopHostShadowAfterTask } from './host-shadow-pass.js';
import type { HostSpawnAndWaitOptions, HostSpawnOptions } from './host-spawn-types.js';
import {
  aggregateFleetUsage,
  buildFleetHostStatus,
  type FleetHostStatus,
  type FleetHostUsage,
} from './host-status.js';
import { buildHostSubagentProvider } from './host-provider.js';
import { createHostSubagentFactory } from './host-subagent-factory.js';
import { createHostFleetSupervisor } from './host-supervisor.js';
import { reportTaskResultToLeader } from './host-task-result-report.js';
import type { MultiAgentDeps, MultiAgentHostOptions } from './host-types.js';
import { buildRoutingRunner } from './routing.js';
import { setActiveFleetSupervisor } from './supervisor-registry.js';

export type { MultiAgentDeps, MultiAgentHostOptions } from './host-types.js';

/**
 * Lazy holder — created on first /spawn call, reused across the session
 * so /agents can list everyone running.
 */
export class MultiAgentHost {
  private director?: Director | undefined;
  /** Own FleetManager — created in buildDirector(), used for pending task
   *  tracking so status() can show descriptions without host-side state. */
  private fleetManager?: import('@wrongstack/core/coordination').FleetManager | undefined;
  /** Own FleetEmitTool — created in buildDirector() so subagents in director
   *  mode can publish structured events (bug.found, refactor.plan,
   *  critic.evaluation) onto the fleet bus without needing the tool registered
   *  in the host's ToolRegistry. */
  private fleetEmitTool?: import('@wrongstack/core/types').Tool | undefined;
  /** Director-owned tools available to scoped subagents even when the leader
   * ToolRegistry was not populated because director mode was promoted lazily. */
  private directorToolsByName = new Map<string, Tool>();
  /** Lazily built alongside the director — produces per-subagent JSONL
   *  writers under `<sessionsRoot>/<runId>/`. Null without sessionsRoot. */
  private sessionFactory?: DirectorSessionFactory | undefined;
  private readonly opts: MultiAgentHostOptions;
  /** Guards `buildDirector` from overwriting a runner set by `spawnACP`. */
  private directorRunnerSet = false;
  /** Event-bus off-handles registered in `buildDirector` — cleaned up in `dispose()`. */
  private readonly directorOffHandles: Array<() => void> = [];
  /** Coordinator task.assigned listener — cleaned up in `dispose()`. */
  private coordinatorOffHandle: (() => void) | null = null;
  /** ACP runner cache — keyed by role/subagentId, reused across tasks to avoid
   *  creating a new transport process on every ACP task dispatch. Stores the
   *  pending promise so concurrent calls for the same subagentId share one spawn.
   *  Bounded to 20 entries with LRU eviction to prevent unbounded memory growth. */
  private readonly acpRunnerCache = new HostAcpRunnerCache();
  private readonly learningRoles = new HostLearningRoleTracker();
  /** Background distillation of captured learning into per-skill addenda. */
  private learningOptimizer: LearningOptimizationScheduler | null = null;
  private learningSwept = false;
  /** Adaptive concurrency controller — created in buildDirector() when config has
   *  adaptiveConcurrency.enabled = true. Monitors FleetBus for 429 errors and
   *  automatically adjusts maxConcurrent to prevent rate limiting. */
  private adaptiveConcurrencyController?: AdaptiveConcurrencyController | undefined;
  /** Active Shadow Agent spawned by the host or /shadow start. */
  private shadowAgentId: string | null = null;
  /** Assigned monitoring task for the active Shadow Agent. */
  private shadowTaskId: string | null = null;
  /** All internal Shadow Agent startup/heartbeat task ids, excluded from fleet summaries. */
  private readonly shadowTaskIds = new Set<string>();
  /** Shadow task ids assigned but not yet completed. Prevents heartbeat backlog. */
  private readonly shadowOutstandingTaskIds = new Set<string>();
  /** Shadow task ids whose subagent should stop immediately after the one-shot pass. */
  private readonly shadowStopAfterTaskIds = new Set<string>();
  private shadowHeartbeatIntervalMs = 30_000;
  /** Suppresses buildDirector() auto-start while /shadow start is explicitly spawning one. */
  private shadowAutoStartSuppressions = 0;
  private shadowObservedWorkDepth = 0;
  private shadowPassInFlight = false;
  private shadowQueuedProblem: string | null = null;
  private readonly shadowActivityOffHandles: Array<() => void> = [];
  /** Peer-awareness status broadcaster (mailbox `status` mails on subagent
   *  transitions + rich registry heartbeats). Started in buildDirector(),
   *  stopped in dispose(). */
  private statusBroadcaster: { start(): void; stop(): void } | null = null;
  /** Brain-gated FleetSupervisor over this director's fleet. Built in
   *  buildDirector() (when a BrainArbiter is available), stopped in
   *  dispose(). Also published to the supervisor registry for /supervisor. */
  private fleetSupervisor: FleetSupervisor | null = null;
  /** Built-ins plus lazily-resolved project-created roles. */
  private readonly roster: Record<string, SubagentConfig>;

  constructor(
    private readonly deps: MultiAgentDeps,
    opts: MultiAgentHostOptions = {},
  ) {
    this.opts = opts;
    this.roster = createProjectAgentRoster(FLEET_ROSTER, deps.projectRoot);
  }

  /** Live roster surface shared by spawn_subagent and the blocking delegate tool. */
  getRoster(): Record<string, SubagentConfig> {
    return this.roster;
  }

  /**
   * Force the lazy build path to run *now* and return the live Director.
   * Used by the CLI to register the fleet's LLM-callable orchestration
   * tools (spawn_subagent, assign_task, await_tasks, ask_subagent,
   * roll_up, terminate_subagent, fleet) into the leader's ToolRegistry
   * before the agent starts — without this the leader literally cannot
   * see the orchestration tools.
   */
  async ensureDirector(): Promise<Director | null> {
    if (this.director) return this.director;
    await this.buildDirector();
    return this.director ?? null;
  }

  /** Access the Director's internal coordinator. Returns the concrete
   *  `DefaultMultiAgentCoordinator` so callers can use class-only surface
   *  (`on`, `setRunner`) that isn't part of the `MultiAgentCoordinator`
   *  interface. */
  private getCoordinator(): DefaultMultiAgentCoordinator {
    return (this.director as never as { coordinator: DefaultMultiAgentCoordinator }).coordinator;
  }

  /** Public accessor for the Director — used by buildRoutingRunner. */
  getDirector(): Director | undefined {
    return this.director;
  }

  private async ensureCoordinator(_config: Config): Promise<void> {
    await this.buildDirector();
  }

  private async buildDirector(): Promise<void> {
    if (this.director) return; // Already built — idempotent.
    const config: Config = this.deps.configStore.get() as Config;
    // First real fleet activity in this session: catch up on any role whose
    // learning became eligible for distillation while nobody was looking.
    this.sweepLearningOptimization();

    // Create the FleetManager FIRST so we can pass it to the Director.
    // The FleetManager owns pending task tracking (addPendingTask /
    // removePendingTask) used by status(), plus manifest + checkpointing.
    const fleetManager = createHostFleetManager(this.opts);
    this.fleetManager = fleetManager;

    if (this.opts.sessionsRoot && !this.sessionFactory) {
      this.sessionFactory = makeDirectorSessionFactory({
        sessionsRoot: this.opts.sessionsRoot,
        directorRunId: this.opts.directorRunId,
        traceId: this.opts.traceId,
      });
    }

    const {
      coordinatorConfig,
      fleetLifecycle,
      subagentIdleTimeoutMs,
      defaultScratchpad,
      worktreePolicy,
      worktrees,
    } = prepareHostDirectorRuntime({
      config,
      deps: this.deps,
      opts: this.opts,
    });
    this.director = new Director({
      config: coordinatorConfig,
      manifestPath: this.opts.manifestPath,
      sharedScratchpadPath: defaultScratchpad,
      stateCheckpointPath: this.opts.stateCheckpointPath,
      sessionWriter: this.opts.sessionWriter,
      sessionId: () => this.deps.session.id,
      directorBudget: this.opts.directorBudget,
      maxSpawns: this.opts.maxSpawns ?? DEFAULT_MAX_FLEET_SPAWNS,
      maxBudgetExtensions: this.opts.maxBudgetExtensions,
      checkpointDebounceMs: this.opts.checkpointDebounceMs,
      sessionsRoot: this.opts.sessionsRoot,
      directorRunId: this.opts.directorRunId,
      maxSpawnDepth: HARD_MAX_SPAWN_DEPTH,
      maxContext: this.opts.getLeaderMaxContext,
      // Live getter (not a snapshot) so a mid-session `/setmodel` takes
      // effect on the next spawn — the director is built lazily + once.
      modelMatrix: () => this.deps.configStore.get().modelMatrix,
      worktrees,
      worktreePolicy,
      worktreeConflictResolver: makeFleetWorktreeConflictResolver(),
      fleetManager, // pass so director.fleetManager is never undefined
      brain: this.opts.brain,
      roster: this.roster,
      // Fire-and-forget report-back: when an assign_task completes with no
      // pending await, post the result to this session's leader via the
      // project mailbox (injected inline before the leader's next step).
      taskResultNotifier: (n) => this.reportTaskResultToLeader(n),
      subagentIdleTimeoutMs,
      ...(this.opts.statusTracker ? { statusTracker: this.opts.statusTracker } : {}),
      // Session's own working provider/model — absolute last-resort fallback
      // for every subagent when matrix resolution leaves model undefined.
      sessionProvider: this.deps.configStore.get().provider,
      sessionModel: this.deps.configStore.get().model,
      retireSubagentOnTaskComplete:
        this.opts.retireSubagentOnTaskComplete ?? fleetLifecycle?.retireOnTaskComplete ?? true,
    });
    installDirectorTaskCompletedHandler({
      director: this.director,
      fleetManager: this.fleetManager,
      agentMonitor: this.opts.agentMonitor,
      captureCompletedTaskLearning: (result) => this.captureCompletedTaskLearning(result),
      isShadowTask: (taskId) => this.shadowTaskIds.has(taskId),
      onShadowTaskCompleted: (taskId, subagentId) => {
        this.shadowOutstandingTaskIds.delete(taskId);
        if (this.shadowStopAfterTaskIds.delete(taskId)) {
          void this.stopShadowAfterTask(subagentId);
        }
      },
      emitLifecycleCompleted: (taskId, result) => this.emitLifecycleCompleted(taskId, result),
    });

    startDirectorAgentMonitor({
      director: this.director,
      agentMonitor: this.opts.agentMonitor,
    });

    // Peer-awareness broadcaster: subagent lifecycle transitions become
    // `type:'status'` broadcast mails (visible to every agent on the
    // project, cross-process) and rich registry heartbeats (what makes the
    // fleet-pulse digest show each worker's current task).
    this.statusBroadcaster = createHostStatusBroadcaster({
      events: this.deps.events,
      sessionId: this.deps.session.id,
      mailboxProjectDir: () => this.mailboxProjectDir(),
      subagentName: (id) => this.director?.status().subagents.find((s) => s.id === id)?.name,
      config: config.fleet?.statusBroadcasts,
    });
    this.statusBroadcaster.start();

    this.buildFleetSupervisor(config);

    this.directorOffHandles.push(
      ...registerDirectorBudgetAndContextBridges({
        director: this.director,
        events: this.deps.events,
        sessionId: this.deps.session.id,
      }),
    );
    this.directorOffHandles.push(
      registerDirectorStatsBridge({
        director: this.director,
        events: this.deps.events,
        sessionId: this.deps.session.id,
      }),
    );
    this.directorOffHandles.push(
      ...registerDirectorSubagentLifecycleBridges({
        director: this.director,
        events: this.deps.events,
        sessionId: this.deps.session.id,
        agentMonitor: this.opts.agentMonitor,
        onSubagentRemoved: (subagentId) => this.clearShadowAgent(subagentId),
      }),
    );
    const coordinator = this.getCoordinator();
    this.coordinatorOffHandle = registerCoordinatorLifecycleHandlers({
      coordinator,
      events: this.deps.events,
      sessionId: this.deps.session.id,
      isShadowTask: (taskId) => this.shadowTaskIds.has(taskId),
      onSubagentStopped: (subagentId) => this.clearShadowAgent(subagentId),
    });
    this.fleetEmitTool = makeFleetEmitTool(this.director);
    this.directorToolsByName = new Map(
      this.director.tools(this.roster).map((tool) => [tool.name, tool] as const),
    );

    // Adaptive Concurrency Controller — auto-adjusts maxConcurrent based on 429 rate-limit errors
    const adaptiveConfig = this.deps.configStore.get().adaptiveConcurrency;
    if (adaptiveConfig?.enabled) {
      this.adaptiveConcurrencyController = new AdaptiveConcurrencyController(
        this.director.fleet,
        (n: number) => coordinator.setMaxConcurrent(n),
        adaptiveConfig,
        undefined,
        this.deps.container.safeResolve(TOKENS.Logger),
      );
    }

    const runner = await this.buildSubagentRunner(config);
    // Guard: if spawnACP already set an ACP runner, don't overwrite it with the
    // routing runner. This prevents a race where buildDirector (called by
    // ensureCoordinator from a concurrent spawnACP) overwrites the ACP runner.
    if (!this.directorRunnerSet) {
      this.getCoordinator().setRunner(runner);
      this.directorRunnerSet = true;
    }

    // Arm Shadow Agent event monitoring. This is intentionally lazy and
    // event-driven: no background LLM task is spawned until a real anomaly
    // or an explicit /shadow start asks for one.
    this.armShadowAgentIfNeeded();
  }

  /**
   * Arm host-owned Shadow observation. Healthy work windows stay fully
   * deterministic; a one-shot LLM Shadow pass runs only after problematic work
   * finishes, or when the user explicitly invokes /shadow start.
   */
  private armShadowAgentIfNeeded(): void {
    if (this.shadowActivityOffHandles.length > 0) return;

    this.shadowActivityOffHandles.push(
      this.deps.events.on('agent.run.started', () => this.noteShadowWorkStarted()),
      this.deps.events.on('agent.run.completed', (e) => {
        const problem =
          e.status === 'failed' || e.status === 'max_iterations'
            ? `leader run ended with ${e.status}`
            : undefined;
        this.noteShadowWorkCompleted(problem);
      }),
      this.deps.events.on('subagent.task_started', () => this.noteShadowWorkStarted()),
      this.deps.events.on('subagent.task_completed', (e) => {
        const problem =
          e.status === 'failed' || e.status === 'timeout'
            ? `subagent ${e.subagentId} task ${e.taskId} ended with ${e.status}${e.error?.message ? `: ${e.error.message}` : ''}`
            : undefined;
        this.noteShadowWorkCompleted(problem);
      }),
    );
  }

  private recordShadowAgent(
    subagentId: string,
    taskId: string,
    intervalMs = this.shadowHeartbeatIntervalMs,
  ): void {
    this.shadowAgentId = subagentId;
    this.shadowTaskId = taskId;
    this.shadowHeartbeatIntervalMs = intervalMs;
    this.markShadowTask(taskId);
    this.opts.onShadowAgentStarted?.(subagentId);
  }

  private clearShadowAgent(subagentId?: string): void {
    if (subagentId && this.shadowAgentId !== subagentId) return;
    const stoppedId = this.shadowAgentId;
    this.shadowAgentId = null;
    this.shadowTaskId = null;
    this.shadowOutstandingTaskIds.clear();
    this.shadowStopAfterTaskIds.clear();
    if (stoppedId) this.opts.onShadowAgentStopped?.(stoppedId);
  }

  private markShadowTask(taskId: string): void {
    this.shadowTaskIds.add(taskId);
    this.shadowOutstandingTaskIds.add(taskId);
  }

  private isActiveSubagent(subagentId: string): boolean {
    if (!this.director) return false;
    const status = this.getCoordinator()
      .getStatus()
      .subagents.find((a) => a.id === subagentId)?.status;
    return status === 'running' || status === 'idle';
  }

  private noteShadowWorkStarted(): void {
    if (this.shadowAutoStartSuppressions > 0) return;
    this.shadowObservedWorkDepth++;
  }

  private noteShadowWorkCompleted(problem?: string | undefined): void {
    if (problem) {
      this.shadowQueuedProblem = this.shadowQueuedProblem
        ? `${this.shadowQueuedProblem}; ${problem}`
        : problem;
    }
    if (this.shadowObservedWorkDepth > 0) {
      this.shadowObservedWorkDepth--;
    }
    if (this.shadowObservedWorkDepth === 0 && this.shadowQueuedProblem) {
      const queued = this.shadowQueuedProblem;
      this.shadowQueuedProblem = null;
      this.requestShadowPass(queued);
    }
  }

  private requestShadowPass(reason: string): void {
    if (!this.director) return;
    if (this.shadowObservedWorkDepth > 0) {
      this.shadowQueuedProblem = this.shadowQueuedProblem
        ? `${this.shadowQueuedProblem}; ${reason}`
        : reason;
      return;
    }
    if (
      this.shadowPassInFlight ||
      (this.shadowAgentId && this.isActiveSubagent(this.shadowAgentId))
    ) {
      this.shadowQueuedProblem = this.shadowQueuedProblem
        ? `${this.shadowQueuedProblem}; ${reason}`
        : reason;
      return;
    }

    this.shadowPassInFlight = true;
    queueMicrotask(() => {
      void this.runShadowPass(reason);
    });
  }

  private async runShadowPass(reason: string): Promise<void> {
    return runHostShadowPass(
      {
        getDirector: () => this.director,
        getLiveConfig: () => this.deps.configStore.get() as Config,
        getObservedWorkDepth: () => this.shadowObservedWorkDepth,
        getQueuedProblem: () => this.shadowQueuedProblem,
        setQueuedProblem: (value) => {
          this.shadowQueuedProblem = value;
        },
        setPassInFlight: (value) => {
          this.shadowPassInFlight = value;
        },
        getHeartbeatIntervalMs: () => this.shadowHeartbeatIntervalMs,
        spawnAndAssign: (subagentConfig, task, opts) =>
          this._spawnAndAssign(subagentConfig, task, opts),
        requestShadowPass: (queued) => this.requestShadowPass(queued),
      },
      reason,
    );
  }

  private async stopShadowAfterTask(subagentId: string): Promise<void> {
    return stopHostShadowAfterTask(
      (targetSubagentId) => this.getCoordinator().stop(targetSubagentId),
      (targetSubagentId) => this.clearShadowAgent(targetSubagentId),
      () => this.shadowObservedWorkDepth,
      () => this.shadowQueuedProblem,
      (value) => {
        this.shadowQueuedProblem = value;
      },
      (queued) => this.requestShadowPass(queued),
      subagentId,
    );
  }

  /**
   * Returns the FleetEmitTool for director-mode subagents, if the director
   * has been built. Used by makeSubagentFactory to inject the tool into
   * the filtered tool registry so collab session agents can emit fleet events.
   */
  getFleetEmitTool(): import('@wrongstack/core/types').Tool | undefined {
    return this.fleetEmitTool;
  }

  /**
   * Build a per-role subagent factory: given a SubagentConfig, construct a
   * fresh, isolated Agent with the role's filtered tools and (when the config
   * carries one) the role's persona as an appended system-prompt block. Public
   * so the autonomy-parallel engine can reuse the exact same agent-construction
   * path the director/spawn flow uses — each parallel slot then runs as a real,
   * specialized, concurrency-safe agent instead of sharing the leader's Context.
   */
  makeSubagentFactory(config: Config): AgentFactory {
    return createHostSubagentFactory(config, {
      deps: this.deps,
      opts: this.opts,
      roster: this.roster,
      sessionFactory: this.sessionFactory,
      filterTools: (allow) => this.filterTools(allow),
      mailboxProjectDir: () => this.mailboxProjectDir(),
      recordLearningRole: (subagentId, role, skills) =>
        this.recordLearningRole(subagentId, role, skills),
      subagentToolRegistry: (allow) => this.subagentToolRegistry(allow),
    });
  }

  /**
   * Build the per-subagent runner.
   *
   * ACP agents (provider: 'acp') get their own runner via
   * makeACPSubagentRunner — they run external processes and don't go
   * through the Agent factory. Regular agents use the standard
   * makeAgentSubagentRunner path.
   */
  async buildSubagentRunner(config: Config): Promise<SubagentRunner> {
    // Detect which subagent type(s) will be spawned. If any ACP agent
    // is configured in the roster, we use a routing runner that branches
    // per spawn based on the subagent config's provider.
    return buildRoutingRunner(config, this);
  }

  async buildACPRunner(subagentId: string): Promise<SubagentRunner> {
    return this.acpRunnerCache.get(subagentId);
  }

  async spawnACP(subagentId: string, task: string, config: Config): Promise<string> {
    const taskId = randomUUID();
    await this.ensureCoordinator(config);
    const coordinator = this.getCoordinator();

    const acpRunner = await this.buildACPRunner(subagentId);
    // ACP agents never pass through the subagent factory, so nothing recorded
    // their role and every `## LEARNED` block they wrote was discarded. Their
    // subagentId *is* the role name (see the spawn call below).
    this.recordLearningRole(subagentId, subagentId);
    coordinator.setRunner(acpRunner);
    // Mark that we've set the runner so buildDirector (called by a concurrent
    // _spawnAndAssign) doesn't overwrite the ACP runner with the routing runner.
    this.directorRunnerSet = true;
    await coordinator.spawn({
      id: subagentId,
      name: subagentId,
      role: subagentId,
      provider: 'acp',
    });
    await coordinator.assign({
      id: taskId,
      description: task,
    });

    // Emit for TUI visibility - ACP agents use subagentId as their name
    // (e.g. "bug-hunter", "refactor-planner" - already meaningful names)
    this.deps.events.emit('subagent.spawned', {
      sessionId: this.deps.session.id,
      subagentId,
      taskId,
      name: subagentId,
      provider: 'acp',
      model: undefined,
      description: task,
    });

    return taskId;
  }

  /** Returns a tool slice for the subagent — full set unless restricted. */
  private filterTools(allow?: string[]): Tool[] {
    return selectSubagentTools(this.deps.toolRegistry.list(), this.directorToolsByName, allow);
  }

  /** Resolved shared-mailbox project dir — same as the leader's checker. */
  private mailboxProjectDir(): string {
    return (
      this.opts.mailboxProjectDir ?? resolveProjectDir(this.deps.projectRoot, wstackGlobalRoot())
    );
  }

  /**
   * Construct + start the brain-gated FleetSupervisor over this director's
   * fleet. Requires a BrainArbiter (production always wires one); without
   * it there is no safe decision path, so supervision stays off. All
   * actions flow through Director APIs — the supervisor never touches
   * coordinator internals or budget negotiation.
   */
  private buildFleetSupervisor(config: Config): void {
    this.fleetSupervisor = createHostFleetSupervisor({
      director: this.director,
      brain: this.opts.brain,
      supervisorConfig: config.fleet?.supervisor,
      events: this.deps.events,
      sessionId: this.deps.session.id,
      mailboxProjectDir: this.mailboxProjectDir(),
      roster: this.roster,
      getLeaderMailboxId: this.opts.getLeaderMailboxId,
    });
  }

  /**
   * Fire-and-forget report-back (wired as the Director's
   * `taskResultNotifier`): posts a non-awaited task's outcome to THIS
   * session's leader via the project mailbox. The leader's mailbox checker
   * injects it inline before the next step, so `assign_task`-without-await
   * results reach the conversation without polling. The body carries a
   * short excerpt only — the full result stays in the director's completed
   * cache, retrievable via `await_tasks`/`roll_up`.
   */
  private async reportTaskResultToLeader(n: TaskResultNotification): Promise<void> {
    await reportTaskResultToLeader({
      notification: n,
      sessionId: this.deps.session.id,
      mailboxProjectDir: this.mailboxProjectDir(),
      events: this.deps.events,
      getLeaderMailboxId: this.opts.getLeaderMailboxId,
    });
  }

  private subagentToolRegistry(allow?: string[]): ToolRegistry {
    // Build a per-subagent registry from the visible tool slice. Even the
    // "full" default hides host orchestration controls like `delegate` and
    // `spawn_subagent`: subagents keep full developer power (read/write/shell/
    // build/install) but do not receive recursive delegation affordances.
    const sub = new ToolRegistry();
    for (const t of this.filterTools(allow)) sub.register(t);
    return sub;
  }

  /**
   * Spawn a fresh subagent and assign a single task. Returns task id.
   *
   * Optional `opts` lets the caller (a `/spawn` slash command or the
   * future director surface) override the subagent's provider, model,
   * and tool slice on a per-spawn basis. Without options, the legacy
   * behavior holds: the subagent uses the leader's provider/model and
   * the full tool registry.
   */
  async spawn(
    description: string,
    opts?: HostSpawnOptions,
  ): Promise<{ subagentId: string; taskId: string }> {
    // Director Mode is permanently on — no guard needed.

    // Build the Director only after the session has opted into director mode.
    // The Director handles all orchestration once enabled.
    const isShadowSpawn = opts?.name === 'shadow';
    if (isShadowSpawn) this.shadowAutoStartSuppressions++;
    try {
      await this.buildDirector();
    } finally {
      if (isShadowSpawn) this.shadowAutoStartSuppressions--;
    }
    if (isShadowSpawn && this.shadowAgentId && this.isActiveSubagent(this.shadowAgentId)) {
      return { subagentId: this.shadowAgentId, taskId: this.shadowTaskId ?? 'shadow-active' };
    }
    const subagentConfig = {
      name: opts?.name ?? 'adhoc',
      role: isShadowSpawn ? 'shadow-agent' : 'general',
      provider: opts?.provider,
      model: opts?.model,
      fallbackModels: opts?.fallbackModels,
      tools: opts?.tools,
      allowedCapabilities: opts?.allowedCapabilities,
    };
    // In director mode we route through `Director.spawn` / `Director.assign`
    // so the director's manifest entries get populated. Calling the
    // underlying coordinator directly would still execute the task, but
    // the manifest would be empty — that surprised the first test.
    const { subagentId, taskId } = await this._spawnAndAssign(subagentConfig, description, {
      internalTask: isShadowSpawn,
      stopShadowAfterTask: isShadowSpawn,
      shadowIntervalMs: opts?.shadowIntervalMs,
      taskContext: opts?.context,
    });
    // Track the pending task via FleetManager so status() can show descriptions
    // without host-side state duplication.
    if (!isShadowSpawn) {
      this.fleetManager?.addPendingTask(taskId, subagentId, description);
    }
    // NOTE: subagent.spawned is now emitted via FleetBus in Director.spawn()
    // and bridged to EventBus in buildDirector(). This ensures the correct
    // nickname (e.g. "Einstein (Bug Hunter)") is captured, not the placeholder.
    return { subagentId, taskId };
  }

  /**
   * Spawn a fresh subagent, assign a task, and **await** its completion.
   *
   * Unlike `spawn()`, which returns immediately with spawn metadata, this
   * method blocks until the subagent finishes (success, failure, or timeout)
   * and returns the full `TaskResult`. Use this when the caller needs the
   * subagent's actual output — e.g. `/techstack` displaying the generated report
   * in chat, or `/spawn` showing the result inline.
   *
   * Optional `opts` lets the caller override the subagent's provider, model,
   * and tool slice per spawn.
   */
  async spawnAndWait(description: string, opts?: HostSpawnAndWaitOptions): Promise<TaskResult> {
    const { taskId } = await this.spawn(description, opts);
    // Capture director reference before await to avoid TOCTOU race with
    // concurrent stopAll() — this.director is a shared mutable field.
    const director = this.director;
    if (!director)
      throw new AgentError({
        message: 'Director is not initialized',
        code: 'AGENT_RUN_FAILED',
        context: { phase: 'awaitTaskAndSpawn' },
      });
    const results = await director.awaitTasks([taskId]);
    const result = results[0];
    if (!result)
      throw new AgentError({
        message: `Task ${taskId} completed but no result returned`,
        code: 'AGENT_RUN_FAILED',
        context: { taskId },
      });
    return result;
  }

  /**
   * Common spawn + assign logic shared by both director mode and raw
   * coordinator mode. Extracts the identical body from the two branches
   * in `spawn()` so future changes (e.g. adding a new field to both
   * paths) are made in one place.
   *
   * Returns `{ subagentId, taskId }`. Caller holds `pending` tracking
   * and event emission — the helper only talks to the coordinator.
   */
  private async _spawnAndAssign(
    subagentConfig: SubagentConfig,
    description: string = '',
    opts?: {
      internalTask?: boolean;
      stopShadowAfterTask?: boolean;
      shadowIntervalMs?: number | undefined;
      taskContext?:
        | {
            kanban?: { boardId?: string; taskId?: string; projectRoot?: string };
          }
        | undefined;
    },
  ): Promise<{ subagentId: string; taskId: string }> {
    const taskId = randomUUID();
    // Always goes through the Director — single code path after buildDirector()
    if (!this.director)
      throw new AgentError({
        message: 'Director is not initialized',
        code: 'AGENT_RUN_FAILED',
        context: { phase: 'spawnAndAssign' },
      });
    const subagentId = await this.director.spawn(subagentConfig);
    const task = {
      id: taskId,
      description,
      subagentId,
      ...(opts?.taskContext ? { context: opts.taskContext as Record<string, unknown> } : {}),
    };
    if (opts?.internalTask) {
      this.markShadowTask(taskId);
      if (opts.stopShadowAfterTask) this.shadowStopAfterTaskIds.add(taskId);
      if (subagentConfig.name === 'shadow' || subagentConfig.role === 'shadow-agent') {
        this.recordShadowAgent(subagentId, taskId, opts.shadowIntervalMs);
      }
      try {
        await this.director.assignInternal(task);
      } catch (err) {
        this.shadowTaskIds.delete(taskId);
        this.shadowOutstandingTaskIds.delete(taskId);
        this.shadowStopAfterTaskIds.delete(taskId);
        if (subagentConfig.name === 'shadow' || subagentConfig.role === 'shadow-agent') {
          this.clearShadowAgent(subagentId);
          await this.director.remove(subagentId).catch(() => undefined);
        }
        throw err;
      }
    } else {
      await this.director.assign(task);
    }
    return { subagentId, taskId };
  }

  /**
   * Relay a `task.completed` notification (from either the Director or
   * the raw coordinator) to the EventBus so non-director TUIs and any
   * other observer can react. We forward the full result shape rather
   * than mutating the existing `task.completed` schema — coordination
   * code already binds to that event, and adding subscribers there
   * would change ordering semantics for those listeners.
   */
  private emitLifecycleCompleted(taskId: string, result: TaskResult): void {
    emitHostLifecycleCompleted(this.deps.events, this.deps.session.id, taskId, result);
  }

  private recordLearningRole(
    subagentId: string,
    role: string,
    skills: readonly string[] = [],
  ): void {
    this.learningRoles.record(subagentId, role, skills);
  }

  private captureCompletedTaskLearning(result: TaskResult): void {
    this.learningRoles.capture(result, this.deps, (role) =>
      this.getLearningOptimizer()?.notifyCaptured(role),
    );
  }

  /**
   * Lazily built so a session that never spawns a subagent pays nothing, and
   * so the policy is read from the live config rather than frozen at boot.
   * Returns null when auto-optimization is switched off.
   */
  private getLearningOptimizer(): LearningOptimizationScheduler | null {
    const settings = this.deps.configStore.get().fleet?.learning?.autoOptimize;
    if (settings?.enabled === false) return null;
    if (!this.learningOptimizer) {
      this.learningOptimizer = new LearningOptimizationScheduler({
        projectRoot: this.deps.projectRoot,
        getPolicy: () =>
          resolveAutoOptimizePolicy(this.deps.configStore.get().fleet?.learning?.autoOptimize),
        getLlm: () => this.resolveOptimizerLlm(),
        onEvent: (event) => {
          this.deps.events.emit('agent.learning.optimized', {
            sessionId: this.deps.session.id,
            role: event.role,
            trigger: event.trigger,
            status: event.result?.status ?? 'failed',
            skills: event.result?.skills ?? [],
            ...(event.error ? { error: event.error } : {}),
          });
        },
      });
    }
    return this.learningOptimizer;
  }

  /**
   * Resolve a model for the distillation pass. Uses the `memory-curator` slot
   * of the model matrix when one is configured — curating learned knowledge is
   * exactly that role's job — and the session default otherwise. A failure
   * here is not fatal: the pass still writes the deterministic skill addenda.
   */
  private async resolveOptimizerLlm(): Promise<LearningOptimizerLlm | undefined> {
    try {
      const config = this.deps.configStore.get() as Config;
      const target = resolveSubagentModelTarget(config, 'memory-curator');
      const providerId = target?.provider ?? config.provider;
      const model = target?.model ?? config.model;
      if (!providerId || !model) return undefined;
      const provider = await buildHostSubagentProvider(this.deps, config, providerId, model);
      return { provider, model };
    } catch {
      return undefined;
    }
  }

  /**
   * Evaluate every role with learning data once per session. Without it, a
   * role that became eligible before this session would wait for its next
   * capture — which for a rarely-used role can be never.
   */
  private sweepLearningOptimization(): void {
    if (this.learningSwept) return;
    this.learningSwept = true;
    if (this.deps.configStore.get().fleet?.learning?.autoOptimize?.sweepOnStart === false) return;
    try {
      this.getLearningOptimizer()?.sweep(listProjectAgentRoles(this.deps.projectRoot));
    } catch {
      // A sweep is an optimization, never a startup dependency.
    }
  }

  status(): FleetHostStatus {
    return buildFleetHostStatus({
      coordinatorStatus: this.director ? this.getCoordinator().getStatus() : null,
      fleetStatus: this.fleetManager?.getFleetStatus() ?? null,
      completedResults: this.director ? this.director.completedResults() : null,
      shadowTaskIds: this.shadowTaskIds,
      budget: this.budgetView(),
    });
  }

  /**
   * Read-only concurrency + lifetime spawn budget for `/fleet status` and
   * resume diagnostics. Safe when no director/fleet is active yet.
   */
  budgetView(): import('./host-status.js').FleetBudgetView {
    const snap = this.fleetManager?.budgetSnapshot?.();
    const maxSpawns =
      snap?.maxSpawns ??
      this.opts.maxSpawns ??
      this.director?.maxSpawns ??
      Number.POSITIVE_INFINITY;
    const usedSpawns = snap?.usedSpawns ?? this.director?.spawnCount ?? 0;
    const remainingSpawns =
      snap?.remainingSpawns ??
      Math.max(0, (Number.isFinite(maxSpawns) ? maxSpawns : Number.POSITIVE_INFINITY) - usedSpawns);
    const live = this.director
      ? this.getCoordinator()
          .getStatus()
          .subagents.filter((s) => s.status === 'running' || s.status === 'idle').length
      : 0;
    const maxConcurrentSource = this.opts.budgetSources?.maxConcurrent ?? 'default';
    const maxSpawnsSource = this.opts.budgetSources?.maxSpawns ?? 'default';
    const effectiveSource = `maxConcurrent=${maxConcurrentSource}, maxSpawns=${maxSpawnsSource}`;
    return {
      maxConcurrent: this.getMaxConcurrent(),
      activeAgents: live,
      maxSpawns,
      usedSpawns,
      remainingSpawns,
      maxConcurrentSource,
      maxSpawnsSource,
      effectiveSource,
      ...(snap
        ? {
            maxTokens: snap.maxTokens,
            usedTokens: snap.usedTokens,
            remainingTokens: snap.remainingTokens,
            maxCostUsd: snap.maxCostUsd,
            usedCostUsd: snap.usedCostUsd,
            remainingCostUsd: snap.remainingCostUsd,
            ...(snap.checkpointMaxSpawns !== undefined
              ? { checkpointMaxSpawns: snap.checkpointMaxSpawns }
              : {}),
            ...(snap.ceilingMismatch ? { ceilingMismatch: true } : {}),
          }
        : {}),
    };
  }

  usage(): FleetHostUsage {
    const completed = this.director
      ? this.director.completedResults().filter((r) => !this.shadowTaskIds.has(r.taskId))
      : [];
    return aggregateFleetUsage(completed);
  }

  async manifest(): Promise<string | null> {
    if (!this.director) return null;
    // Force a synchronous write — bypass the debounce timer so callers
    // (including tests) get an immediate snapshot without polling.
    // `writeManifest()` returns the absolute path on success, or null
    // when no manifest path is configured on the FleetManager.
    return (await this.director.fleetManager?.writeManifest()) ?? null;
  }

  async promoteToDirector(): Promise<Director | null> {
    if (this.director) return this.director;
    applyFleetRootDefaults(this.opts);
    await this.ensureDirector();
    return this.director ?? null;
  }

  isDirectorMode(): boolean {
    return true;
  }

  async kill(subagentId: string): Promise<boolean> {
    if (!this.director) return false;
    await this.getCoordinator().stop(subagentId);
    if (this.shadowAgentId === subagentId) this.clearShadowAgent(subagentId);
    return true;
  }

  async stopAll(): Promise<void> {
    this.clearShadowAgent();
    if (this.director) {
      await this.getCoordinator().stopAll();
    }
    // Cancel + drain the Director's own manifest writer BEFORE the final
    // FleetManager close. stopAll() (unlike dispose()) never calls
    // director.shutdown(), so without this the Director's armed 2s debounce
    // timer survives stopAll and fires later — its un-awaited atomicWrite
    // then races a caller that deletes the manifest dir (ENOTEMPTY on rmdir,
    // seen on Windows under load).
    await this.director?.quiesceManifest();
    // closeManifest() (not flushManifest()) freezes the FleetManager writer
    // after its final flush so a late task-completion `void flushManifest()`
    // can't land a write while the caller deletes the manifest directory.
    await this.fleetManager?.closeManifest();
  }

  getMaxConcurrent(): number {
    if (this.director) {
      return this.getCoordinator().config.maxConcurrent ?? 4;
    }
    return this.opts.maxConcurrent ?? 4;
  }

  setMaxConcurrent(n: number): void {
    const v = normalizeMaxConcurrent(n);
    this.opts.maxConcurrent = v;
    if (this.director) {
      this.getCoordinator().setMaxConcurrent(v);
    }
  }

  /**
   * Clean up all listeners and resources held by the host.
   * Unregisters all EventBus/FleetBus listeners registered in `buildDirector`
   * and stops the Director and its coordinator.
   *
   * Safe to call multiple times — subsequent calls are no-ops.
   */
  async dispose(): Promise<void> {
    this.learningOptimizer?.dispose();
    this.learningOptimizer = null;
    this.clearShadowAgent();
    for (const off of this.shadowActivityOffHandles) {
      off();
    }
    this.shadowActivityOffHandles.length = 0;
    // Unregister FleetBus filter listeners
    for (const off of this.directorOffHandles) {
      off();
    }
    this.directorOffHandles.length = 0;
    // Unregister coordinator task.assigned listener
    this.coordinatorOffHandle?.();
    this.coordinatorOffHandle = null;
    // Stop the peer-awareness status broadcaster (detaches bus listeners,
    // clears pending coalesce timers).
    this.statusBroadcaster?.stop();
    this.statusBroadcaster = null;
    // Stop the fleet supervisor and clear the /supervisor registry handle.
    this.fleetSupervisor?.stop();
    if (this.fleetSupervisor) setActiveFleetSupervisor(null);
    this.fleetSupervisor = null;
    // Stop the AdaptiveConcurrencyController
    this.adaptiveConcurrencyController?.dispose();
    this.adaptiveConcurrencyController = undefined;
    // Stop the director and all subagents
    if (this.director) {
      await this.director.shutdown();
    }
    // Freeze + drain the manifest writer so no late fire-and-forget write
    // outlives dispose and races a caller deleting the manifest directory.
    await this.fleetManager?.closeManifest();
    this.fleetManager?.dispose();
    this.fleetManager = undefined;
    // Stop the AgentMonitorService and drain its transcript writes, so no late
    // append outlives dispose — same reason the manifest writer is drained above.
    const monitor = this.opts.agentMonitor;
    if (monitor) {
      await monitor.close();
    }
  }
}
