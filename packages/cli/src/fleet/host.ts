import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import * as path from 'node:path';
/**
 * L1-E: Multi-agent CLI integration. The coordinator + per-task agent
 * factory is created lazily on the first `/spawn` so users who never use
 * subagents don't pay the construction cost.
 */
import {
  Agent,
  Context,
  createDefaultPipelines,
  createFallbackModelExtension,
} from '@wrongstack/core/agent';
import {
  applyProjectAgentConfig,
  buildProjectContextualizedPrompt,
  createProjectAgentRoster,
  loadProjectAgentConfig,
} from '@wrongstack/core/agent-catalog';
import {
  AdaptiveConcurrencyController,
  type AgentFactory,
  DEFAULT_MAX_FLEET_SPAWNS,
  DEFAULT_SUBAGENT_BASELINE,
  type DefaultMultiAgentCoordinator,
  Director,
  type DirectorSessionFactory,
  FLEET_ROSTER,
  type FleetSupervisor,
  GlobalMailbox,
  HARD_MAX_SPAWN_DEPTH,
  makeDirectorSessionFactory,
  makeFleetEmitTool,
  resolveProjectDir,
  resolveSubagentModelTarget,
  type TaskResultNotification,
} from '@wrongstack/core/coordination';
import { installDesignStudioMiddleware } from '@wrongstack/core/design';
import {
  applyModelRuntime,
  installSubagentAutoCompaction,
  mergeModelRuntime,
  ToolExecutor,
} from '@wrongstack/core/execution';
// PR-C1: DefaultTokenCounter moved off the root barrel — infrastructure/
// symbols are imported from the published subpath (see commit 66c4eb68).
import { DefaultTokenCounter } from '@wrongstack/core/infrastructure';
import { EventBus, TOKENS } from '@wrongstack/core/kernel';
import { ToolRegistry } from '@wrongstack/core/registry';
import { AutoApprovePermissionPolicy } from '@wrongstack/core/security';
import type { SubagentRunner, TextBlock } from '@wrongstack/core/types';
import {
  AgentError,
  type Config,
  type Provider,
  type Request,
  type SessionWriter,
  type SubagentConfig,
  type TaskResult,
  type TaskSpec,
  type Tool,
} from '@wrongstack/core/types';

import { wstackGlobalRoot } from '@wrongstack/core/utils';
import {
  isAgentAvailable,
  isInsideDirectory,
  makeFleetWorktreeConflictResolver,
  resolveSubagentCapabilities,
  selectSubagentTools,
} from './host-helpers.js';
import { installSubagentEventBridge } from './host-event-bridge.js';
import { HostAcpRunnerCache } from './host-acp-runner-cache.js';
import { runHostShadowPass, stopHostShadowAfterTask } from './host-shadow-pass.js';
import { normalizeMaxConcurrent } from './host-concurrency.js';
import { emitHostLifecycleCompleted } from './host-lifecycle-events.js';
import { applyFleetRootDefaults } from './host-paths.js';
import {
  resolveHostSubagentSkillContent,
  retrieveHostSubagentMemory,
} from './host-context.js';
import {
  buildHostSubagentProvider,
  resolveHostSubagentModelSelection,
  resolveHostSubagentReasoningConfig,
} from './host-provider.js';
import {
  installDirectorTaskCompletedHandler,
  registerCoordinatorLifecycleHandlers,
  registerDirectorBudgetAndContextBridges,
  registerDirectorStatsBridge,
  registerDirectorSubagentLifecycleBridges,
} from './host-director-event-bridges.js';
import { createParentSubagentSessionWriter } from './host-session-writer.js';
import { reportTaskResultToLeader } from './host-task-result-report.js';
import { createHostFleetSupervisor } from './host-supervisor.js';
import {
  createHostStatusBroadcaster,
  startDirectorAgentMonitor,
} from './host-director-services.js';
import { createHostFleetManager, prepareHostDirectorRuntime } from './host-director-builder.js';
import {
  aggregateFleetUsage,
  buildFleetHostStatus,
  type FleetHostStatus,
  type FleetHostUsage,
} from './host-status.js';
import type { HostSpawnAndWaitOptions, HostSpawnOptions } from './host-spawn-types.js';
import type { MultiAgentDeps, MultiAgentHostOptions } from './host-types.js';
import { buildRoutingRunner } from './routing.js';
import { setActiveFleetSupervisor } from './supervisor-registry.js';
import { HostLearningRoleTracker } from './host-learning-tracker.js';

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
    return async (subCfg: SubagentConfig, task?: TaskSpec) => {
      const events = new EventBus();
      // Per-task model matrix safety net. Director.spawn already fills these in
      // for director-routed spawns, but direct-factory paths (e.g. the
      // autonomy-parallel engine) call the factory without going through the
      // director — resolve here too so they honor the matrix. Explicit
      // per-subagent model/provider always win.
      const liveConfig = this.deps.configStore.get();
      const mergedConfig = { ...liveConfig, ...config };
      const projectRoot = this.deps.projectRoot;
      // `applyProjectAgentConfig` never overrides `role` (it only merges
      // tools, skillNames, provider, model, allowedCapabilities, and budget
      // fields), so we can read the role directly from `subCfg` and derive
      // the project override in one shot — no bootstrap call needed. The
      // guard returns the base by reference when `projectCfg` is absent,
      // so `effectiveCfg` is set unconditionally below for downstream use.
      const projectCfg = subCfg.role ? loadProjectAgentConfig(subCfg.role, projectRoot) : undefined;
      const isSystemRole = Boolean(subCfg.role && Object.hasOwn(FLEET_ROSTER, subCfg.role));
      const effectiveCfg: SubagentConfig = projectCfg
        ? applyProjectAgentConfig(subCfg, projectCfg, {
            protectSystemRole: isSystemRole,
          })
        : subCfg;
      const matrixTarget = effectiveCfg.model
        ? undefined
        : resolveSubagentModelTarget(liveConfig, effectiveCfg.role);
      const modelSelection = resolveHostSubagentModelSelection(
        liveConfig,
        effectiveCfg,
        matrixTarget,
      );
      let effProvider = modelSelection.effProvider;
      let effModel = modelSelection.effModel;
      let provider: Provider | undefined;
      let providerError: unknown;
      const seenStartupTargets = new Set<string>();
      for (const target of modelSelection.startupTargets) {
        const key = `${target.provider}/${target.model}`;
        if (seenStartupTargets.has(key)) continue;
        seenStartupTargets.add(key);
        try {
          provider = await buildHostSubagentProvider(
            this.deps,
            mergedConfig,
            target.provider,
            target.model,
          );
          effProvider = target.provider;
          effModel = target.model;
          break;
        } catch (err) {
          providerError = err;
        }
      }
      if (!provider)
        throw providerError ?? new Error('No permitted provider/model could be built.');
      let subReasoningConfig = await resolveHostSubagentReasoningConfig(
        this.deps,
        effProvider,
        effModel,
      );

      let availabilityNotice: string | undefined;
      if (effectiveCfg.availability) {
        const status = isAgentAvailable(effectiveCfg.availability);
        if (!status.allowed) {
          const message = `Agent "${effectiveCfg.role ?? effectiveCfg.name}" is outside its working hours (${status.localTime}; ${effectiveCfg.availability.start}-${effectiveCfg.availability.end}).`;
          if (effectiveCfg.availability.mode === 'enforce') throw new Error(message);
          availabilityNotice = `${message} This protected system role may continue, but should minimize non-urgent work.`;
        }
      }

      // Per-subagent cwd (defaults to the factory cwd). Goal points this
      // at a phase's git worktree so isolated checkouts don't collide.
      const assignedCheckout =
        subCfg.cwd && path.isAbsolute(subCfg.cwd) ? subCfg.cwd : this.deps.projectRoot;
      let subCwd = projectCfg?.cwd
        ? path.resolve(assignedCheckout, projectCfg.cwd)
        : (effectiveCfg.cwd ?? this.deps.cwd);
      if (projectCfg?.cwd && !isInsideDirectory(assignedCheckout, subCwd)) {
        throw new Error(
          `Agent "${effectiveCfg.role ?? effectiveCfg.name}" cwd escapes its assigned checkout.`,
        );
      }
      if (
        projectCfg?.cwd &&
        (!existsSync(subCwd) || !statSync(subCwd, { throwIfNoEntry: false })?.isDirectory())
      ) {
        const message = `Agent "${effectiveCfg.role ?? effectiveCfg.name}" working directory does not exist: ${subCwd}.`;
        if (!isSystemRole) throw new Error(message);
        subCwd = assignedCheckout;
        availabilityNotice = availabilityNotice
          ? `${availabilityNotice}\n${message} Falling back to the assigned checkout.`
          : `${message} Falling back to the assigned checkout.`;
      }

      // Fetch online agents from the shared mailbox to include in subagent prompt.
      // NOTE: must use the RESOLVED project dir (~/.wrongstack/projects/<slug>)
      // — the raw repo root previously passed here pointed GlobalMailbox at a
      // nonexistent <repo>/_mailbox.* and the online list was always empty.
      let onlineAgents: Awaited<ReturnType<GlobalMailbox['getAgentStatuses']>> = [];
      try {
        const subagentMailbox = new GlobalMailbox(this.mailboxProjectDir());
        onlineAgents = await subagentMailbox.getAgentStatuses();
      } catch {
        // Non-fatal — mailbox errors should not block subagent creation
      }

      const baseSystem: TextBlock[] = await this.deps.systemPromptBuilder.build({
        cwd: subCwd,
        projectRoot: this.deps.projectRoot,
        tools: this.filterTools(effectiveCfg.tools),
        model: effModel,
        provider: effProvider,
        // Tell the builder this is a subagent build — skips the host's
        // plan injection so each subagent gets a clean, task-scoped
        // prompt instead of inheriting strategic context that's
        // meaningless to a single delegated subtask.
        subagent: true,
        onlineAgents,
      });

      // Prepend bridge contract so the subagent knows it has a parent it
      // can ask for clarification. Placed first so the subagent reads its
      // role in the hierarchy before absorbing the full identity block.
      // The builder already includes the identity + tools + skills layers.
      baseSystem.unshift({ type: 'text', text: DEFAULT_SUBAGENT_BASELINE });
      if (availabilityNotice) baseSystem.push({ type: 'text', text: availabilityNotice });

      const audienceMemory = await retrieveHostSubagentMemory(
        this.deps,
        this.opts.getLeaderMode,
        effectiveCfg,
        task?.context,
      );
      if (audienceMemory.length > 0) {
        baseSystem.push({
          type: 'text',
          text: `Project memory for this agent role:\n${audienceMemory.map((text) => `- ${text}`).join('\n')}`,
        });
      }

      // Apply project-level agent identity and overrides before building
      // the system prompt. This lets project `.wrongstack/agents/<role>/`
      // files customize the agent's tools, budget, identity and learned
      // wisdom on top of the base catalog definition.
      const roleSkillContent = await resolveHostSubagentSkillContent(
        this.deps,
        this.roster,
        effectiveCfg,
      );
      if (roleSkillContent) {
        // The shared builder may eagerly inject every discovered skill. A
        // roster-selected worker needs only its curated subset, so replace that
        // generic section rather than duplicating the same skill bodies.
        // NOTE: splice is guarded by roleSkillContent being truthy — if
        // resolveSubagentSkillContent returns empty (deduped empty names,
        // no skillLoader, or all skills filtered), we keep the builder's
        // generic block rather than leaving the worker with no skills at all.
        for (let index = baseSystem.length - 1; index >= 0; index--) {
          if (baseSystem[index]?.text.includes('# Active Skills')) baseSystem.splice(index, 1);
        }
        baseSystem.push({ type: 'text', text: roleSkillContent });
      }

      // Append the role persona. Priority:
      //   1. Explicit `systemPromptOverride` on the SubagentConfig (caller control)
      //   2. Roster lookup by `subCfg.role` — matches catalog agents (bug-hunter, etc.)
      //   3. Nothing — subagent runs with generic identity + bridge contract only
      const rawRolePrompt =
        effectiveCfg.systemPromptOverride ??
        effectiveCfg.prompt ??
        (effectiveCfg.role ? this.roster[effectiveCfg.role]?.prompt : undefined);
      const rolePrompt =
        rawRolePrompt && effectiveCfg.role
          ? buildProjectContextualizedPrompt(rawRolePrompt, effectiveCfg.role, projectRoot, {
              identityOverride: effectiveCfg.projectIdentity?.identityOverride,
            })
          : rawRolePrompt;
      if (rolePrompt) {
        baseSystem.push({ type: 'text', text: rolePrompt });
      }

      const subagentName =
        effectiveCfg.id ?? effectiveCfg.name ?? `sub_${randomUUID().slice(0, 8)}`;
      if (effectiveCfg.role) {
        this.recordLearningRole(subagentName, effectiveCfg.role);
        // Avoid a redundant LRU re-insert when `id` is set — in that case
        // `subagentName === effectiveCfg.id` and the first call already
        // recorded the role under the same key. Recording again just
        // performs an extra splice+shift and shifts the role's eviction
        // position one step back in the LRU.
      }
      let subSession: SessionWriter;
      if (this.sessionFactory) {
        subSession = await this.sessionFactory.createSubagentSession({
          subagentId: subagentName,
          provider: effProvider,
          model: effModel,
          title: `subagent: ${subagentName}`,
        });
      } else {
        subSession = createParentSubagentSessionWriter(this.deps.session);
      }

      const tools = effectiveCfg.tools ? [...effectiveCfg.tools] : undefined;
      const subTokenCounter = new DefaultTokenCounter({
        registry: this.deps.modelsRegistry,
        providerId: effProvider,
        events,
        sessionId: () => this.deps.session.id,
      });

      const ctx = new Context({
        systemPrompt: baseSystem,
        provider,
        session: subSession,
        signal: new AbortController().signal,
        // Keep per-request context pressure isolated. The leader statusline
        // reads currentRequestTokens() from the leader counter; sharing it with
        // subagents lets the latest subagent provider call overwrite the ctx
        // chip even though subagent ctx is reported separately as
        // subagent.ctx_pct.
        tokenCounter: subTokenCounter,
        cwd: subCwd,
        projectRoot: this.deps.projectRoot,
        // Subagents inherit the leader's filesystem-access scope.
        allowOutsideProjectRoot:
          config.features?.allowOutsideProjectRoot ??
          !(config.tools?.restrictToProjectRoot ?? false),
        model: effModel,
        tools: this.filterTools(tools),
        // Distinct mailbox identity: without these, every subagent fell back
        // to the host's 'leader' base id and they all collided in the shared
        // project mailbox registry (and consumed each other's read receipts).
        agentId: subagentName,
        agentName: effectiveCfg.name ?? subagentName,
      });
      if (effectiveCfg.role) ctx.meta['agentRole'] = effectiveCfg.role;
      const normalizedAgentName = (effectiveCfg.name ?? subagentName).trim().toLowerCase();
      if (normalizedAgentName === 'chimera' || normalizedAgentName.startsWith('chimera-')) {
        ctx.meta['mailboxSendPolicy'] = 'leaders-only';
      }
      const leaderMode = this.opts.getLeaderMode?.();
      if (leaderMode) ctx.meta['mode'] = leaderMode;
      if (effectiveCfg.spawnLineage) ctx.meta['spawnLineage'] = effectiveCfg.spawnLineage;

      const baseRegistry = this.subagentToolRegistry(tools);
      // Per-spawn capability allowlist. The ToolExecutor and the Agent must
      // share the same policy semantics — resolve one allowlist and pass it to
      // both. See `resolveSubagentCapabilities` for the precedence rules.
      const subAllowedCaps = resolveSubagentCapabilities(effectiveCfg, (allow) =>
        this.filterTools([...allow]),
      );
      const toolExecutor = new ToolExecutor(baseRegistry, {
        permissionPolicy: new AutoApprovePermissionPolicy(subAllowedCaps),
        secretScrubber: this.deps.secretScrubber,
        renderer: this.deps.renderer,
        events,
        confirmAwaiter: undefined,
        iterationTimeoutMs: config.tools?.iterationTimeoutMs ?? 120_000,
        maxToolTimeoutMs: config.tools?.maxToolTimeoutMs ?? 300_000,
        perIterationOutputCapBytes: config.tools?.perIterationOutputCapBytes ?? 100_000,
        tracer: undefined,
      });

      const subagentConfigStore = this.deps.configStore;
      const pipelines = createDefaultPipelines();
      pipelines.request.use({
        name: 'ModelRuntimeSettings',
        async handler(req: Request) {
          return applyModelRuntime(req, {
            getSettings: () =>
              mergeModelRuntime(
                subagentConfigStore.get().modelRuntime,
                modelSelection.runtimeOverride,
              ),
            getReasoningConfig: () => subReasoningConfig,
            getCapabilities: () => ctx.provider.capabilities,
          });
        },
      });

      // Design Studio — install the SAME per-turn UI-intent detection + kit-menu
      // injection + auto-verify-on-write that the leader has, so a frontend task
      // delegated to this subagent still commits to the active kit (restored
      // from `.design/active.json` via shared projectRoot) and gets nudged on
      // off-palette drift. Without this, roster/fleet agents lost the design
      // direction entirely the moment work was delegated. `prepend`-based, so
      // ordering vs. ModelRuntimeSettings above is handled by the installer.
      installDesignStudioMiddleware({ pipelines, ctx });

      // Proactive auto-compaction — subagents shrink on the warn/soft/hard
      // thresholds (and get the last-resort emergency trim) like the leader,
      // instead of growing unbounded until the provider rejects the request.
      installSubagentAutoCompaction(pipelines, ctx, config.context, events);

      const agent = new Agent({
        container: this.deps.container,
        tools: baseRegistry,
        providers: this.deps.providerRegistry,
        events,
        pipelines,
        context: ctx,
        // Subagents cannot answer interactive permission prompts — they
        // run under a director, not the user. Auto-approve everything
        // whose capability is in the (possibly widened) allowlist; the
        // user already authorized the work when they invoked the leader.
        permissionPolicy: new AutoApprovePermissionPolicy(subAllowedCaps),
        toolExecutor,
        loopDetection: config.tools?.loopDetection,
      });

      // Explicit task fallbacks stay pinned, while matrix-selected named
      // profiles are re-resolved from ConfigStore for every provider attempt.
      // This lets WebUI profile edits/reordering affect active workers.
      agent.extensions.register(
        createFallbackModelExtension({
          getConfig: () => this.deps.configStore.get() as Config,
          fallbackProfileManager: this.deps.fallbackProfileManager,
          getFallbackModels: () => effectiveCfg.fallbackModels,
          getFallbackProfile: () => modelSelection.fallbackProfile,
          getPrimaryTarget: () => ({ providerId: effProvider, model: effModel }),
          isClosedWorld: () => modelSelection.closedModelPolicy,
          buildProvider: (id, model) =>
            buildHostSubagentProvider(this.deps, mergedConfig, id, model ?? effModel),
          onModelSwitch: async (id, model) => {
            subReasoningConfig = await resolveHostSubagentReasoningConfig(this.deps, id, model);
          },
          events,
        }),
      );

      // Close the per-subagent JSONL writer when the task ends. Without
      // this each completed task leaks one open file descriptor; over a
      // long fleet run (1000+ tasks) the process eventually hits the OS
      // limit. We only close writers we created via `sessionFactory` —
      // the fallback path forwards into the parent's session, which the
      // host owns and must not close here — the fallback shim's `close()`
      // is a no-op, so calling it unconditionally is safe in both cases.
      // Bridge per-subagent tool lifecycle to the host EventBus so the
      // TUI can update its compact live agent surfaces regardless of
      // director mode. The FleetBus path (director-only) covers the
      // richer FleetPanel stream; this bridge gives baseline visibility
      // for plain /spawn without forcing tool calls into chat history.
      // Capture the subagentId from the caller-supplied config — the
      // factory itself doesn't know the id until spawn() assigns one,
      // but director.spawn/coord.spawn both pass it back via subCfg.id
      // when in director mode; in legacy non-director mode the id is
      // discovered post-spawn, so we wire the bridge lazily with a
      // mutable holder and let the legacy emit path fill it.
      const disposeBridge = installSubagentEventBridge({
        events,
        hostEvents: this.deps.events,
        hostSessionId: this.deps.session.id,
        projectRoot: ctx.projectRoot,
        effectiveCfg,
        subCfg,
      });

      const dispose = async () => {
        disposeBridge();
        try {
          await subSession.close?.();
        } catch {
          // see runner-side comment — cleanup must not mask the result
        }
      };

      return { agent, events, dispose };
    };
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
  async spawnAndWait(
    description: string,
    opts?: HostSpawnAndWaitOptions,
  ): Promise<TaskResult> {
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

  private recordLearningRole(subagentId: string, role: string): void {
    this.learningRoles.record(subagentId, role);
  }

  private captureCompletedTaskLearning(result: TaskResult): void {
    this.learningRoles.capture(result, this.deps);
  }

  status(): FleetHostStatus {
    return buildFleetHostStatus({
      coordinatorStatus: this.director ? this.getCoordinator().getStatus() : null,
      fleetStatus: this.fleetManager?.getFleetStatus() ?? null,
      completedResults: this.director ? this.director.completedResults() : null,
      shadowTaskIds: this.shadowTaskIds,
    });
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
