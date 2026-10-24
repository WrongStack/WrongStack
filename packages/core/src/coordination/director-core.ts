/**
 * State, construction and helper-host layer of the {@link Director}
 * (director.ts). Owns every field, wires the coordinator / fleet / budget
 * policy in the constructor, and builds the host objects the director-*
 * helper modules operate on. The public orchestration API lives in Director.
 */

import { randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import type { Config } from '@wrongstack/contracts/types/config';
import type { Logger } from '@wrongstack/contracts/types/logger';
import type { SubagentConfig, TaskResult, TaskSpec } from '@wrongstack/contracts/types/multi-agent';
import type { SessionWriter } from '@wrongstack/contracts/types/session';
import { forgetSandboxAgentOverride } from '../sandbox/agent-overrides.js';
import { DirectorStateCheckpoint } from '../storage/director-state.js';
import { InMemoryAgentBridge } from './agent-bridge.js';
import {
  appendSessionEvent as appendDirectorSessionEvent,
  type DirectorCheckpointHost,
  scheduleManifest as scheduleDirectorManifest,
  writeManifest as writeDirectorManifest,
} from './checkpoint-wiring.js';
import { DirectorBtwNotes } from './director/director-btw-notes.js';
import { DirectorBudgetPolicy } from './director/director-budget-policy.js';
import { DirectorCollabController } from './director/director-collab.js';
import type { DirectorTaskRegistry } from './director/director-task-registry.js';
import {
  type DirectorCompletionListenersHost,
  handleTaskCompleted as handleTaskCompletedFromHost,
  logShutdownError as logShutdownErrorFromHost,
} from './director-completion-listeners.js';
import { DirectorIdleRetirement } from './director-idle-retirement.js';
import { type DirectorLifecycleHost, removeDirectorSubagent } from './director-lifecycle.js';
import type { DirectorModelRoutingHost } from './director-model-routing.js';
import type { DirectorOptions } from './director-options.js';
import type { DirectorPromptHost } from './director-prompt-host.js';
import { DEFAULT_DIRECTOR_PREAMBLE, DEFAULT_SUBAGENT_BASELINE } from './director-prompts.js';
import {
  type DirectorTaskNotesHost,
  recordWorktreeTaskUpdate as recordWorktreeTaskUpdateFromHost,
} from './director-task-notes.js';
import { createDirectorTaskRegistry } from './director-task-registry-wiring.js';
import { FleetBus, FleetUsageAggregator } from './fleet-bus.js';
import type { FleetManager } from './fleet-manager.js';
import type { DirectorFleetHost } from './fleet-spawn.js';
import { InMemoryBridgeTransport } from './in-memory-transport.js';
import { LargeAnswerStore } from './large-answer-store.js';
import type { ModelMatrixSource } from './model-matrix.js';
import { DefaultMultiAgentCoordinator } from './multi-agent-coordinator.js';
import type { ProviderModelStatusTracker } from './provider-status-tracker.js';
import { resolveMaxSpawnDepth } from './spawn-budget.js';
import {
  type WorktreeTaskStateUpdate,
  wrapSubagentRunnerWithWorktrees,
} from './worktree-task-runner.js';

export abstract class DirectorCore implements DirectorFleetHost {
  readonly id: string;
  readonly fleet: FleetBus;
  readonly usage: FleetUsageAggregator;

  readonly fleetManager: FleetManager | undefined;
  readonly bridge: InMemoryAgentBridge;
  readonly transport: InMemoryBridgeTransport;
  readonly coordinator: DefaultMultiAgentCoordinator;
  protected readonly tasks: DirectorTaskRegistry;
  readonly subagentMeta = new Map<
    string,
    { provider?: string | undefined; model?: string | undefined; effort?: string | undefined }
  >();
  readonly priceLookups = new Map<
    string,
    {
      input?: number | undefined;
      output?: number | undefined;
      cacheRead?: number | undefined;
      cacheWrite?: number | undefined;
    }
  >();
  readonly subagentBridges = new Map<string, InMemoryAgentBridge>();
  readonly manifestEntries = new Map<string, unknown>();
  readonly usedNicknames = new Set<string>();
  protected readonly manifestPath?: string | undefined;
  protected readonly roster?: Record<string, SubagentConfig> | undefined;
  protected readonly directorPreamble: string;
  protected readonly subagentBaseline: string;
  protected readonly taskResultNotifier?: DirectorOptions['taskResultNotifier'];
  protected readonly subagentIdleTimeoutMs: number | undefined;
  protected readonly retireSubagentOnTaskComplete: boolean;
  protected readonly idleRetirement = new DirectorIdleRetirement(
    () => this.coordinator,
    (id) => this.remove(id),
    (err) => this.logShutdownError('subagent_idle_retirement', err),
  );
  /**
   * Effective idle window per subagent (spawn-time `idleTimeoutMs` override
   * or the Director-wide default; undefined = no window). Internal-task
   * completion re-arms with THIS value, not the Director-wide default, so
   * a subagent-configured window survives its first internal probe.
   */
  protected readonly subagentIdleDelayMs = new Map<string, number | undefined>();
  readonly sharedScratchpadPath: string | null;
  readonly maxSpawns: number;
  readonly maxSpawnDepth: number;
  readonly spawnDepth: number;
  spawnCount = 0;
  readonly stateCheckpoint: DirectorStateCheckpoint | null;
  protected readonly sessionWriter: SessionWriter | null;
  protected readonly sessionIdSource: string | (() => string | undefined) | undefined;
  protected manifestTimer: NodeJS.Timeout | null = null;
  protected manifestWriteChain: Promise<unknown> = Promise.resolve();
  protected readonly manifestDebounceMs: number;
  readonly maxFleetCostUsd: number;
  readonly maxFleetTokens: number;
  protected readonly sessionsRoot?: string | undefined;
  protected readonly directorRunId: string;
  protected readonly logger: Logger | undefined;
  readonly taskWorktrees = new Map<string, WorktreeTaskStateUpdate>();
  protected readonly budgetPolicy: DirectorBudgetPolicy;
  protected taskCompletedListener:
    | ((payload: { task: TaskSpec; result: TaskResult }) => void)
    | null = null;
  readonly dispatchClassifier?:
    | import('../coordination/dispatcher.js').DispatchClassifier
    | undefined;
  readonly onSpawnRouted?:
    | ((entry: import('./agents/dispatch-log.js').DispatchLogEntry) => void)
    | undefined;
  leaderContextPressure = 0;
  readonly maxLeaderContextLoad: number;
  protected readonly maxContext: number | (() => number | undefined);
  protected readonly appConfig?: Config | (() => Config | undefined) | undefined;
  readonly modelMatrix?: ModelMatrixSource | undefined;
  workCompleteFlag = false;
  protected readonly btwNotes = new DirectorBtwNotes();
  protected readonly collab: DirectorCollabController;
  readonly largeAnswerStore: LargeAnswerStore;
  protected readonly statusTracker: ProviderModelStatusTracker | undefined;
  /**
   * The session's own provider/model. Held as the option gave them — a getter
   * where the host can supply one — and resolved at SPAWN time, not at
   * construction: `/model` mid-session must reach the next worker, both for the
   * plan's "use my model" switch and for the final session fallback. A snapshot
   * here pinned every later subagent to whatever the leader ran on when the
   * fleet was first built.
   */
  protected readonly sessionProvider: string | (() => string | undefined) | undefined;
  protected readonly sessionModel: string | (() => string | undefined) | undefined;
  protected readonly sessionTerminateListeners = new Set<(sessionId: string) => void>();

  constructor(opts: DirectorOptions) {
    this.id = opts.config.coordinatorId || randomUUID();
    this.manifestPath = opts.manifestPath;
    this.roster = opts.roster;
    this.directorPreamble = opts.directorPreamble ?? DEFAULT_DIRECTOR_PREAMBLE;
    this.subagentBaseline = opts.subagentBaseline ?? DEFAULT_SUBAGENT_BASELINE;
    this.taskResultNotifier = opts.taskResultNotifier;
    this.subagentIdleTimeoutMs =
      typeof opts.subagentIdleTimeoutMs === 'number' &&
      Number.isFinite(opts.subagentIdleTimeoutMs) &&
      opts.subagentIdleTimeoutMs >= 0
        ? opts.subagentIdleTimeoutMs
        : undefined;
    this.retireSubagentOnTaskComplete = opts.retireSubagentOnTaskComplete ?? true;
    this.sharedScratchpadPath = opts.sharedScratchpadPath ?? null;
    this.maxSpawns = opts.maxSpawns ?? Number.POSITIVE_INFINITY;
    this.maxSpawnDepth =
      opts.fleetManager?.maxSpawnDepth ?? resolveMaxSpawnDepth(opts.maxSpawnDepth);
    this.spawnDepth = opts.fleetManager?.spawnDepth ?? opts.spawnDepth ?? 0;
    this.sessionWriter = opts.sessionWriter ?? null;
    this.sessionIdSource = opts.sessionId ?? (() => opts.sessionWriter?.id);
    this.manifestDebounceMs = opts.manifestDebounceMs ?? 2000;
    this.dispatchClassifier = opts.dispatchClassifier;
    this.onSpawnRouted = opts.onSpawnRouted;
    this.maxFleetCostUsd = opts.directorBudget?.maxCostUsd ?? Number.POSITIVE_INFINITY;
    this.maxFleetTokens = opts.directorBudget?.maxTokens ?? Number.POSITIVE_INFINITY;
    this.maxLeaderContextLoad = opts.maxLeaderContextLoad ?? 0.85;
    this.maxContext = opts.maxContext ?? 0;
    this.appConfig = opts.appConfig;
    this.modelMatrix = opts.modelMatrix;
    this.sessionsRoot = opts.sessionsRoot;
    this.directorRunId = opts.directorRunId ?? this.id;
    this.stateCheckpoint = opts.stateCheckpointPath
      ? new DirectorStateCheckpoint(
          opts.stateCheckpointPath,
          {
            directorRunId: this.id,
            maxSpawns: opts.maxSpawns,
            spawnDepth: this.spawnDepth,
            maxSpawnDepth: this.maxSpawnDepth,
            directorBudget: opts.directorBudget,
          },
          opts.checkpointDebounceMs ?? 250,
        )
      : null;
    this.fleetManager = opts.fleetManager;
    this.statusTracker = opts.statusTracker;
    this.logger = opts.logger;
    this.sessionProvider = opts.sessionProvider;
    this.sessionModel = opts.sessionModel;
    if (this.sharedScratchpadPath) {
      void fsp
        .mkdir(this.sharedScratchpadPath, { recursive: true })
        .catch((err) => this.logShutdownError('shared_scratchpad_mkdir', err));
    }
    this.transport = new InMemoryBridgeTransport();
    this.bridge = new InMemoryAgentBridge(
      { agentId: this.id, coordinatorId: this.id },
      this.transport,
    );
    if (this.fleetManager) {
      this.fleet = this.fleetManager.fleet;
      this.usage = this.fleetManager.usage;
    } else {
      this.fleet = new FleetBus();
      this.usage = new FleetUsageAggregator(
        this.fleet,
        (_id, provider, model) => {
          if (provider && model) return this.priceLookups.get(`${provider}/${model}`);
          return undefined;
        },
        (id) => this.subagentMeta.get(id),
      );
    }
    const runner =
      opts.runner && (opts.worktrees || opts.worktreePolicy)
        ? wrapSubagentRunnerWithWorktrees({
            runner: opts.runner,
            worktrees: opts.worktrees,
            policy: opts.worktreePolicy,
            conflictResolver: opts.worktreeConflictResolver,
            onUpdate: (update) => this.recordWorktreeTaskUpdate(update),
          })
        : opts.runner;
    this.coordinator = new DefaultMultiAgentCoordinator(
      { ...opts.config, coordinatorId: this.id },
      { runner, sessionId: () => this.currentSessionId() },
    );
    this.coordinator.setFleetBus(this.fleet);
    this.fleetManager?.setCoordinator(this.coordinator);
    this.tasks = createDirectorTaskRegistry(this, (subagentId) =>
      this.armSubagentIdleRetirement(
        subagentId,
        this.subagentIdleDelayMs.get(subagentId) ?? this.subagentIdleTimeoutMs,
      ),
    );
    this.taskCompletedListener = (payload) => this.handleTaskCompleted(payload);
    this.coordinator.on('task.completed', this.taskCompletedListener);

    this.collab = new DirectorCollabController({
      director: this,
      fleet: this.fleet,
      coordinator: this.coordinator,
      logger: this.logger,
    });
    this.budgetPolicy = new DirectorBudgetPolicy({
      fleet: this.fleet,
      usage: this.usage,
      brain: opts.brain,
      maxBudgetExtensions: opts.maxBudgetExtensions ?? 12,
      maxFleetCostUsd: this.maxFleetCostUsd,
      currentSessionId: () => this.currentSessionId(),
      isCollabOwned: (subagentId) => this.collab.ownsSubagent(subagentId),
    });
    this.budgetPolicy.start();
    this.largeAnswerStore = new LargeAnswerStore(2000);
  }

  abstract spawn(
    callerConfig: SubagentConfig,
    priceLookup?: {
      input?: number | undefined;
      output?: number | undefined;
      cacheRead?: number | undefined;
      cacheWrite?: number | undefined;
    },
  ): Promise<string>;
  abstract assign(task: TaskSpec): Promise<string>;
  abstract awaitTasks(taskIds: string[]): Promise<TaskResult[]>;
  abstract getLeaderBtwNotes(): string[];

  /** The leader's window in tokens, or 0 when unknown (no invented default). */
  resolveMaxContext(): number {
    const resolved = typeof this.maxContext === 'function' ? this.maxContext() : this.maxContext;
    return resolved && resolved > 0 ? resolved : 0;
  }

  protected currentSessionId(): string | undefined {
    const value =
      typeof this.sessionIdSource === 'function' ? this.sessionIdSource() : this.sessionIdSource;
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }

  protected checkpointHost(): DirectorCheckpointHost {
    return {
      id: this.id,
      manifestPath: this.manifestPath,
      manifestDebounceMs: this.manifestDebounceMs,
      stateCheckpoint: this.stateCheckpoint,
      sessionWriter: this.sessionWriter,
      usage: this.usage,
      manifestEntries: this.manifestEntries,
      completedResult: (...args) => this.tasks.completedResult(...args),
      logShutdownError: (...args) => this.logShutdownError(...args),
      onManifestTimerFired: () => {
        this.manifestTimer = null;
      },
    };
  }

  protected handleTaskCompleted(payload: { task: TaskSpec; result: TaskResult }): void {
    handleTaskCompletedFromHost(this.directorCompletionListenersHost(), payload);
  }

  async appendSessionEvent(event: Parameters<SessionWriter['append']>[0]): Promise<void> {
    await appendDirectorSessionEvent(this.checkpointHost(), event);
  }

  scheduleManifest(): void {
    if (this.manifestTimer) return;
    this.manifestTimer = scheduleDirectorManifest(this.checkpointHost());
  }

  protected clearManifestTimer(): void {
    if (!this.manifestTimer) return;
    clearTimeout(this.manifestTimer);
    this.manifestTimer = null;
  }

  protected recordWorktreeTaskUpdate(update: WorktreeTaskStateUpdate): void {
    recordWorktreeTaskUpdateFromHost(this.directorTaskNotesHost(), update);
  }

  async writeManifest(): Promise<string | null> {
    if (!this.manifestPath) return null;
    this.clearManifestTimer();
    const write = this.manifestWriteChain
      .catch(() => undefined)
      .then(() => writeDirectorManifest(this.checkpointHost()));
    this.manifestWriteChain = write.catch(() => undefined);
    return write;
  }

  protected logShutdownError(phase: string, err: unknown): void {
    logShutdownErrorFromHost(this.directorCompletionListenersHost(), phase, err);
  }

  async remove(subagentId: string): Promise<void> {
    forgetSandboxAgentOverride(subagentId);
    return removeDirectorSubagent(this.directorLifecycleHost(), subagentId);
  }

  protected clearSubagentIdleRetirement(subagentId: string): void {
    this.idleRetirement.clear(subagentId);
  }

  protected armSubagentIdleRetirement(subagentId: string, delayMs: number | undefined): void {
    this.idleRetirement.arm(subagentId, delayMs);
  }

  protected directorModelRoutingHost(): DirectorModelRoutingHost {
    return {
      modelMatrix: this.modelMatrix,
      fleetManager: this.fleetManager,
      subagentMeta: this.subagentMeta,
      appConfig: this.appConfig,
      sessionProvider: this.sessionProvider,
      sessionModel: this.sessionModel,
      statusTracker: this.statusTracker,
      logger: this.logger,
    };
  }

  protected directorLifecycleHost(): DirectorLifecycleHost {
    const self = this;
    return {
      clearSubagentIdleRetirement: (...args) => this.clearSubagentIdleRetirement(...args),
      subagentIdleDelayMs: this.subagentIdleDelayMs,
      appendSessionEvent: (...args) => this.appendSessionEvent(...args),
      coordinator: this.coordinator,
      subagentBridges: this.subagentBridges,
      usage: this.usage,
      fleetManager: this.fleetManager,
      manifestEntries: this.manifestEntries,
      usedNicknames: this.usedNicknames,
      tasks: this.tasks,
      taskWorktrees: this.taskWorktrees,
      budgetPolicy: this.budgetPolicy,
      subagentMeta: this.subagentMeta,
      priceLookups: this.priceLookups,
      clearManifestTimer: (...args) => this.clearManifestTimer(...args),
      get taskCompletedListener() {
        return self.taskCompletedListener;
      },
      set taskCompletedListener(value) {
        self.taskCompletedListener = value;
      },
      idleRetirement: this.idleRetirement,
      logShutdownError: (...args) => this.logShutdownError(...args),
      bridge: this.bridge,
      get manifestWriteChain() {
        return self.manifestWriteChain;
      },
      manifestPath: this.manifestPath,
      writeManifest: (...args) => this.writeManifest(...args),
      stateCheckpoint: this.stateCheckpoint,
      largeAnswerStore: this.largeAnswerStore,
      sessionTerminateListeners: this.sessionTerminateListeners,
      logger: this.logger,
      remove: (...args) => this.remove(...args),
    };
  }

  protected directorPromptHost(): DirectorPromptHost {
    return {
      coordinator: this.coordinator,
      directorPreamble: this.directorPreamble,
      roster: this.roster,
      subagentBaseline: this.subagentBaseline,
      sharedScratchpadPath: this.sharedScratchpadPath,
    };
  }

  protected directorTaskNotesHost(): DirectorTaskNotesHost {
    // Check the complete helper contract while preserving the owner's identity and receivers.
    void ({
      workCompleteFlag: this.workCompleteFlag,
      fleet: this.fleet,
      id: this.id,
      coordinator: this.coordinator,
      btwNotes: this.btwNotes,
      getLeaderBtwNotes: this.getLeaderBtwNotes,
      taskWorktrees: this.taskWorktrees,
      tasks: this.tasks,
      manifestEntries: this.manifestEntries,
      stateCheckpoint: this.stateCheckpoint,
      fleetManager: this.fleetManager,
      scheduleManifest: this.scheduleManifest,
      sessionTerminateListeners: this.sessionTerminateListeners,
      subagentMeta: this.subagentMeta,
      maxSpawns: this.maxSpawns,
    } satisfies DirectorTaskNotesHost);
    return this as unknown as DirectorTaskNotesHost;
  }

  protected directorCompletionListenersHost(): DirectorCompletionListenersHost {
    // Check the complete helper contract while preserving the owner's identity and receivers.
    void ({
      tasks: this.tasks,
      subagentIdleDelayMs: this.subagentIdleDelayMs,
      subagentIdleTimeoutMs: this.subagentIdleTimeoutMs,
      taskResultNotifier: this.taskResultNotifier,
      manifestEntries: this.manifestEntries,
      logger: this.logger,
      stateCheckpoint: this.stateCheckpoint,
      usage: this.usage,
      fleetManager: this.fleetManager,
      retireSubagentOnTaskComplete: this.retireSubagentOnTaskComplete,
      armSubagentIdleRetirement: this.armSubagentIdleRetirement,
      appendSessionEvent: this.appendSessionEvent,
      scheduleManifest: this.scheduleManifest,
      budgetPolicy: this.budgetPolicy,
      subagentBridges: this.subagentBridges,
      id: this.id,
      bridge: this.bridge,
      coordinator: this.coordinator,
    } satisfies DirectorCompletionListenersHost);
    return this as unknown as DirectorCompletionListenersHost;
  }
}
