import { randomUUID } from 'node:crypto';
/**
 * L1-E: Multi-agent CLI integration. The coordinator + per-task agent
 * factory is created lazily on the first `/spawn` so users who never use
 * subagents don't pay the construction cost.
 */
import {
  createProjectAgentRoster,
} from '@wrongstack/core/agent-catalog';
import {
  AdaptiveConcurrencyController,
  type AgentFactory,
  DEFAULT_MAX_FLEET_SPAWNS,
  type DefaultMultiAgentCoordinator,
  Director,
  type DirectorSessionFactory,
  type ExploreCompanion,
  FLEET_ROSTER,
  type FleetSupervisor,
  HARD_MAX_SPAWN_DEPTH,
  makeDirectorSessionFactory,
  makeFleetEmitTool,
  resolveProjectDir,
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
import { createHostExploreCompanion } from './host-explore-companion.js';
import { makeFleetWorktreeConflictResolver, selectSubagentTools } from './host-helpers.js';
import { HostLearningScheduler } from './host-learning-scheduler.js';
import { HostLearningRoleTracker } from './host-learning-tracker.js';
import { emitHostLifecycleCompleted } from './host-lifecycle-events.js';
import { applyFleetRootDefaults } from './host-paths.js';
import { HostShadowManager } from './host-shadow-manager.js';
import type { HostSpawnAndWaitOptions, HostSpawnOptions } from './host-spawn-types.js';
import {
  aggregateFleetUsage,
  buildFleetHostStatus,
  type FleetHostStatus,
  type FleetHostUsage,
} from './host-status.js';
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
  private readonly learningScheduler: HostLearningScheduler;
  /** Adaptive concurrency controller — created in buildDirector() when config has
   *  adaptiveConcurrency.enabled = true. Monitors FleetBus for 429 errors and
   *  automatically adjusts maxConcurrent to prevent rate limiting. */
  private adaptiveConcurrencyController?: AdaptiveConcurrencyController | undefined;
  private readonly shadowManager: HostShadowManager;
  /** Peer-awareness status broadcaster (mailbox `status` mails on subagent
   *  transitions + rich registry heartbeats). Started in buildDirector(),
   *  stopped in dispose(). */
  private statusBroadcaster: { start(): void; stop(): void } | null = null;
  /** Brain-gated FleetSupervisor over this director's fleet. Built in
   *  buildDirector() (when a BrainArbiter is available), stopped in
   *  dispose(). Also published to the supervisor registry for /supervisor. */
  private fleetSupervisor: FleetSupervisor | null = null;
  /** ExploreCompanion — state-triggered background codebase explorer behind
   *  the leader. Built in buildDirector() (unless disabled via
   *  fleet.exploreCompanion.enabled=false), stopped in dispose(). Probes are
   *  assigned to a lazily-spawned resident `explore-companion` subagent. */
  private exploreCompanion: ExploreCompanion | null = null;
  /** Built-ins plus lazily-resolved project-created roles. */
  private readonly roster: Record<string, SubagentConfig>;

  constructor(
    private readonly deps: MultiAgentDeps,
    opts: MultiAgentHostOptions = {},
  ) {
    this.opts = opts;
    this.roster = createProjectAgentRoster(FLEET_ROSTER, deps.projectRoot);
    this.learningScheduler = new HostLearningScheduler(deps);
    this.shadowManager = new HostShadowManager({
      deps,
      opts,
      getDirector: () => this.director,
      spawnAndAssign: (subagentConfig, task, spawnOpts) =>
        this._spawnAndAssign(subagentConfig, task, spawnOpts),
    });
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

  /** Run one shadow review pass immediately. */
  async runShadowPass(reason: string): Promise<void> {
    return this.shadowManager.runShadowPass(reason);
  }

  private async ensureCoordinator(_config: Config): Promise<void> {
    await this.buildDirector();
  }

  private async buildDirector(): Promise<void> {
    if (this.director) return;
    const config: Config = this.deps.configStore.get() as Config;
    this.learningScheduler.sweep();

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
      modelMatrix: () => this.deps.configStore.get().modelMatrix,
      worktrees,
      worktreePolicy,
      worktreeConflictResolver: makeFleetWorktreeConflictResolver(),
      fleetManager,
      brain: this.opts.brain,
      roster: this.roster,
      dispatchClassifier: (task, candidates) =>
        this.learningScheduler.classifyDispatch(task, candidates),
      taskResultNotifier: (n) => this.reportTaskResultToLeader(n),
      subagentIdleTimeoutMs,
      ...(this.opts.statusTracker ? { statusTracker: this.opts.statusTracker } : {}),
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
      isShadowTask: (taskId) => this.shadowManager.isShadowTask(taskId),
      onShadowTaskCompleted: (taskId, subagentId) =>
        this.shadowManager.onShadowTaskCompleted(taskId, subagentId),
      emitLifecycleCompleted: (taskId, result) => this.emitLifecycleCompleted(taskId, result),
    });

    startDirectorAgentMonitor({
      director: this.director,
      agentMonitor: this.opts.agentMonitor,
    });

    this.statusBroadcaster = createHostStatusBroadcaster({
      events: this.deps.events,
      sessionId: this.deps.session.id,
      mailboxProjectDir: () => this.mailboxProjectDir(),
      subagentName: (id) => this.director?.status().subagents.find((s) => s.id === id)?.name,
      config: config.fleet?.statusBroadcasts,
    });
    this.statusBroadcaster.start();

    this.buildFleetSupervisor(config);

    this.exploreCompanion = createHostExploreCompanion({
      director: this.director,
      events: this.deps.events,
      sessionId: this.deps.session.id,
      mailboxProjectDir: this.mailboxProjectDir(),
      roster: this.roster,
      config: config.fleet?.exploreCompanion,
    });

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
        onSubagentRemoved: (subagentId) => this.shadowManager.clearShadowAgent(subagentId),
      }),
    );
    const coordinator = this.getCoordinator();
    this.coordinatorOffHandle = registerCoordinatorLifecycleHandlers({
      coordinator,
      events: this.deps.events,
      sessionId: this.deps.session.id,
      isShadowTask: (taskId) => this.shadowManager.isShadowTask(taskId),
      onSubagentStopped: (subagentId) => this.shadowManager.clearShadowAgent(subagentId),
    });
    this.fleetEmitTool = makeFleetEmitTool(this.director);
    this.directorToolsByName = new Map(
      this.director.tools(this.roster).map((tool) => [tool.name, tool] as const),
    );

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
    if (!this.directorRunnerSet) {
      this.getCoordinator().setRunner(runner);
      this.directorRunnerSet = true;
    }

    this.shadowManager.armIfNeeded();
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
   * carries one) the role's persona as an appended system-prompt block.
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
   */
  async buildSubagentRunner(config: Config): Promise<SubagentRunner> {
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
    this.recordLearningRole(subagentId, subagentId);
    coordinator.setRunner(acpRunner);
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

  private filterTools(allow?: string[]): Tool[] {
    return selectSubagentTools(this.deps.toolRegistry.list(), this.directorToolsByName, allow);
  }

  private mailboxProjectDir(): string {
    return (
      this.opts.mailboxProjectDir ?? resolveProjectDir(this.deps.projectRoot, wstackGlobalRoot())
    );
  }

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
    const sub = new ToolRegistry();
    for (const t of this.filterTools(allow)) sub.register(t);
    return sub;
  }

  async spawn(
    description: string,
    opts?: HostSpawnOptions,
  ): Promise<{ subagentId: string; taskId: string }> {
    const isShadowSpawn = opts?.name === 'shadow';
    if (isShadowSpawn) this.shadowManager.enterShadowSpawn();
    try {
      await this.buildDirector();
    } finally {
      if (isShadowSpawn) this.shadowManager.exitShadowSpawn();
    }
    const shadowAgentId = this.shadowManager.getAgentId();
    if (isShadowSpawn && shadowAgentId && this.shadowManager.isActiveSubagent(shadowAgentId)) {
      return { subagentId: shadowAgentId, taskId: this.shadowManager.getTaskId() ?? 'shadow-active' };
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
    const { subagentId, taskId } = await this._spawnAndAssign(subagentConfig, description, {
      internalTask: isShadowSpawn,
      stopShadowAfterTask: isShadowSpawn,
      shadowIntervalMs: opts?.shadowIntervalMs,
      taskContext: opts?.context,
    });
    if (!isShadowSpawn) {
      this.fleetManager?.addPendingTask(taskId, subagentId, description);
    }
    return { subagentId, taskId };
  }

  async spawnAndWait(description: string, opts?: HostSpawnAndWaitOptions): Promise<TaskResult> {
    const { taskId } = await this.spawn(description, opts);
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
      this.shadowManager.markShadowTask(taskId);
      if (opts.stopShadowAfterTask) this.shadowManager.addStopAfterTaskId(taskId);
      if (subagentConfig.name === 'shadow' || subagentConfig.role === 'shadow-agent') {
        this.shadowManager.recordShadowAgent(subagentId, taskId, opts.shadowIntervalMs);
      }
      try {
        await this.director.assignInternal(task);
      } catch (err) {
        this.shadowManager.removeShadowTask(taskId);
        if (subagentConfig.name === 'shadow' || subagentConfig.role === 'shadow-agent') {
          this.shadowManager.clearShadowAgent(subagentId);
          await this.director.remove(subagentId).catch(() => undefined);
        }
        throw err;
      }
    } else {
      await this.director.assign(task);
    }
    return { subagentId, taskId };
  }

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
      this.learningScheduler.notifyCaptured(role),
    );
  }

  status(): FleetHostStatus {
    return buildFleetHostStatus({
      coordinatorStatus: this.director ? this.getCoordinator().getStatus() : null,
      fleetStatus: this.fleetManager?.getFleetStatus() ?? null,
      completedResults: this.director ? this.director.completedResults() : null,
      shadowTaskIds: this.shadowManager.getTaskIds(),
      budget: this.budgetView(),
    });
  }

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
    const shadowTaskIds = this.shadowManager.getTaskIds();
    const completed = this.director
      ? this.director.completedResults().filter((r) => !shadowTaskIds.has(r.taskId))
      : [];
    return aggregateFleetUsage(completed);
  }

  async manifest(): Promise<string | null> {
    if (!this.director) return null;
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
    if (this.shadowManager.getAgentId() === subagentId) this.shadowManager.clearShadowAgent(subagentId);
    return true;
  }

  async stopAll(): Promise<void> {
    this.shadowManager.clearShadowAgent();
    if (this.director) {
      await this.getCoordinator().stopAll();
    }
    await this.director?.quiesceManifest();
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

  async dispose(): Promise<void> {
    this.learningScheduler.dispose();
    this.shadowManager.dispose();
    for (const off of this.directorOffHandles) {
      off();
    }
    this.directorOffHandles.length = 0;
    this.coordinatorOffHandle?.();
    this.coordinatorOffHandle = null;
    this.statusBroadcaster?.stop();
    this.statusBroadcaster = null;
    this.fleetSupervisor?.stop();
    if (this.fleetSupervisor) setActiveFleetSupervisor(null);
    this.fleetSupervisor = null;
    this.exploreCompanion?.stop();
    this.exploreCompanion = null;
    this.adaptiveConcurrencyController?.dispose();
    this.adaptiveConcurrencyController = undefined;
    if (this.director) {
      await this.director.shutdown();
    }
    await this.fleetManager?.closeManifest();
    this.fleetManager?.dispose();
    this.fleetManager = undefined;
    const monitor = this.opts.agentMonitor;
    if (monitor) {
      await monitor.close();
    }
  }
}
