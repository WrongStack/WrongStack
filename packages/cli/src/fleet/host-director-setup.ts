import { recordDispatch } from '@wrongstack/core/agent-catalog';
import {
  AdaptiveConcurrencyController,
  areSubagentCompanionsAllowedForSession,
  DEFAULT_MAX_FLEET_SPAWNS,
  type DefaultMultiAgentCoordinator,
  Director,
  type DirectorSessionFactory,
  HARD_MAX_SPAWN_DEPTH,
  makeDirectorSessionFactory,
  makeFleetEmitTool,
  postSessionNote,
  type TaskResultNotification,
} from '@wrongstack/core/coordination';
import { TOKENS } from '@wrongstack/core/kernel';
import type {
  Config,
  SubagentConfig,
  SubagentRunner,
  TaskResult,
  Tool,
} from '@wrongstack/core/types';
import { formatMemoryEvidenceBlock } from '@wrongstack/core/utils';
import { getSageSurface } from '@wrongstack/sage';
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
import {
  createExploreCompanionRegistry,
  type ExploreCompanionRegistry,
} from './host-explore-companion-registry.js';
import { makeFleetWorktreeConflictResolver } from './host-helpers.js';
import type { HostLearningScheduler } from './host-learning-scheduler.js';
import { HostMemoryCompanion } from './host-memory-companion.js';
import { HostSkillCompanion } from './host-skill-companion.js';
import type { HostShadowManager } from './host-shadow-manager.js';
import type { MultiAgentDeps, MultiAgentHostOptions } from './host-types.js';
export interface HostDirectorSetupHost {
  director: Director | undefined;
  deps: MultiAgentDeps;
  learningScheduler: HostLearningScheduler;
  opts: MultiAgentHostOptions;
  fleetManager: import('@wrongstack/core/coordination').FleetManager | undefined;
  sessionFactory: DirectorSessionFactory | undefined;
  roster: Record<string, SubagentConfig>;
  reportTaskResultToLeader(n: TaskResultNotification): Promise<void>;
  captureCompletedTaskLearning(result: TaskResult): void;
  shadowManager: HostShadowManager;
  emitLifecycleCompleted(taskId: string, result: TaskResult): void;
  statusBroadcaster: { start(): void; stop(): void } | null;
  mailboxProjectDir(): string;
  buildFleetSupervisor(config: Config): void;
  exploreCompanions: ExploreCompanionRegistry | null;
  memoryCompanion: HostMemoryCompanion | null;
  skillCompanion: HostSkillCompanion | null;
  exploreCompanionOff: (() => void) | null;
  directorOffHandles: Array<() => void>;
  sessionForSubagent(subagentId: string): string;
  getCoordinator(): DefaultMultiAgentCoordinator;
  coordinatorOffHandle: (() => void) | null;
  fleetEmitTool: import('@wrongstack/core/types').Tool | undefined;
  directorToolsByName: Map<string, Tool<unknown, unknown>>;
  adaptiveConcurrencyController: AdaptiveConcurrencyController | undefined;
  getMaxConcurrent(): number;
  buildSubagentRunner(config: Config): Promise<SubagentRunner>;
  directorRunnerSet: boolean;
}

export async function buildDirector(host: HostDirectorSetupHost): Promise<void> {
  if (host.director) return;
  const config: Config = host.deps.configStore.get() as Config;
  host.learningScheduler.sweep();

  const fleetManager = createHostFleetManager(host.opts);
  host.fleetManager = fleetManager;

  if (host.opts.sessionsRoot && !host.sessionFactory) {
    host.sessionFactory = makeDirectorSessionFactory({
      sessionsRoot: host.opts.sessionsRoot,
      directorRunId: host.opts.directorRunId,
      traceId: host.opts.traceId,
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
    deps: host.deps,
    opts: host.opts,
  });
  host.director = new Director({
    config: coordinatorConfig,
    manifestPath: host.opts.manifestPath,
    sharedScratchpadPath: defaultScratchpad,
    stateCheckpointPath: host.opts.stateCheckpointPath,
    sessionWriter: host.opts.sessionWriter,
    sessionId: () => host.deps.session.id,
    directorBudget: host.opts.directorBudget,
    maxSpawns: host.opts.maxSpawns ?? DEFAULT_MAX_FLEET_SPAWNS,
    maxBudgetExtensions: host.opts.maxBudgetExtensions,
    checkpointDebounceMs: host.opts.checkpointDebounceMs,
    sessionsRoot: host.opts.sessionsRoot,
    directorRunId: host.opts.directorRunId,
    maxSpawnDepth: HARD_MAX_SPAWN_DEPTH,
    maxContext: host.opts.getLeaderMaxContext,
    modelMatrix: () => host.deps.configStore.get().modelMatrix,
    // Live getter, like modelMatrix: tier edits from `/tier`, the TUI menu or
    // the WebUI editor take effect on the next spawn without a restart.
    appConfig: () => host.deps.configStore.get(),
    worktrees,
    worktreePolicy,
    worktreeConflictResolver: makeFleetWorktreeConflictResolver(),
    fleetManager,
    brain: host.opts.brain,
    roster: host.roster,
    dispatchClassifier: (task, candidates) =>
      host.learningScheduler.classifyDispatch(task, candidates),
    // Routing telemetry. Sibling of `dispatchClassifier` on purpose: both are
    // seams the host fills so core keeps no provider and no filesystem
    // dependency. See `.wrongstack/agents/dispatch-log.jsonl`.
    onSpawnRouted: (entry) => recordDispatch(entry, host.deps.projectRoot),
    taskResultNotifier: (n) => host.reportTaskResultToLeader(n),
    subagentIdleTimeoutMs,
    ...(host.opts.statusTracker ? { statusTracker: host.opts.statusTracker } : {}),
    // Live, like `modelMatrix` and `appConfig`: a `/model` switch has to
    // reach the NEXT spawn. Snapshotting here pinned every later worker to
    // the model the leader happened to run on when the fleet was built.
    sessionProvider: () => host.deps.configStore.get().provider,
    sessionModel: () => host.deps.configStore.get().model,
    retireSubagentOnTaskComplete:
      host.opts.retireSubagentOnTaskComplete ?? fleetLifecycle?.retireOnTaskComplete ?? true,
  });
  installDirectorTaskCompletedHandler({
    director: host.director,
    fleetManager: host.fleetManager,
    agentMonitor: host.opts.agentMonitor,
    captureCompletedTaskLearning: (result) => host.captureCompletedTaskLearning(result),
    isShadowTask: (taskId) => host.shadowManager.isShadowTask(taskId),
    onShadowTaskCompleted: (taskId, subagentId) =>
      host.shadowManager.onShadowTaskCompleted(taskId, subagentId),
    emitLifecycleCompleted: (taskId, result) => host.emitLifecycleCompleted(taskId, result),
  });

  startDirectorAgentMonitor({
    director: host.director,
    agentMonitor: host.opts.agentMonitor,
  });

  host.statusBroadcaster = createHostStatusBroadcaster({
    events: host.deps.events,
    sessionId: host.deps.session.id,
    mailboxProjectDir: () => host.mailboxProjectDir(),
    subagentName: (id) => host.director?.status().subagents.find((s) => s.id === id)?.name,
    config: config.fleet?.statusBroadcasts,
  });
  host.statusBroadcaster.start();

  host.buildFleetSupervisor(config);

  // One companion per conversation. The boot session gets one now — that is
  // the CLI's and the TUI's only session, and building it here keeps their
  // behaviour identical. Every other session opens one when it first runs,
  // which is how the WebUI's tabs 2-4 get a companion at all: the host is
  // built once, so a single instance pinned to the boot session filtered
  // every other tab's signals out and explored for nobody.
  host.exploreCompanions = createExploreCompanionRegistry({
    create: (sessionId) =>
      host.director
        ? createHostExploreCompanion({
            director: host.director,
            events: host.deps.events,
            sessionId,
            mailboxProjectDir: host.mailboxProjectDir(),
            roster: host.roster,
            config: config.fleet?.exploreCompanion,
            projectRoot: host.deps.projectRoot,
            scrub: (text) => host.deps.secretScrubber.scrub(text),
            // Companion gate, not the general one: a Bug Hunter round runs
            // solo but keeps its read-only companions.
            companionsAllowed: () => areSubagentCompanionsAllowedForSession(sessionId),
          })
        : null,
  });
  host.exploreCompanions.ensure(host.deps.session.id);
  host.memoryCompanion = new HostMemoryCompanion({
    director: host.director,
    events: host.deps.events,
    projectRoot: host.deps.projectRoot,
    roster: host.roster,
    memory: () => {
      const port = host.deps.container.safeResolve(TOKENS.MemoryStore);
      return port ? getSageSurface(port) : undefined;
    },
    enabled: (sessionId) => {
      const current = host.deps.configStore.get();
      return (
        current.features.memory !== false &&
        current.features.memoryCurator !== false &&
        current.Sage?.enabled !== false &&
        areSubagentCompanionsAllowedForSession(sessionId)
      );
    },
    scrub: (text) => host.deps.secretScrubber.scrub(text),
    note: (sessionId, subject, body) =>
      postSessionNote({
        sessionId,
        from: 'memory-companion',
        to: 'leader',
        kind: 'result',
        subject,
        body: formatMemoryEvidenceBlock('memory-companion', body),
        events: host.deps.events,
      }),
  });
  host.memoryCompanion.ensure(host.deps.session.id);
  // Picks skills the leader did not load; opens its own slot on each
  // conversation's first run, so only the boot session is ensured here.
  host.skillCompanion =
    config.fleet?.skillCompanion?.enabled === false
      ? null
      : new HostSkillCompanion({
          director: host.director,
          events: host.deps.events,
          skillLoader: () => host.deps.skillLoader,
          config: config.fleet?.skillCompanion,
          enabled: (sessionId) => {
            const current = host.deps.configStore.get();
            return (
              current.features.skills !== false &&
              current.fleet?.skillCompanion?.enabled !== false &&
              areSubagentCompanionsAllowedForSession(sessionId)
            );
          },
          scrub: (text) => host.deps.secretScrubber.scrub(text),
          note: (sessionId, subject, body) =>
            postSessionNote({
              sessionId,
              from: 'skill-companion',
              to: 'leader',
              kind: 'note',
              subject,
              body,
              events: host.deps.events,
            }),
        });
  host.skillCompanion?.ensure(host.deps.session.id);
  host.exploreCompanionOff = host.deps.events.on('agent.run.started', (e) => {
    // Unstamped runs exist (thin embedders); `ensure` ignores an empty id,
    // but keep the narrowing explicit rather than relying on that.
    if (e.sessionId && areSubagentCompanionsAllowedForSession(e.sessionId)) {
      host.exploreCompanions?.ensure(e.sessionId);
      // Workers have agentRole metadata and must never open their own verifier.
      if (!e.ctx.meta?.['agentRole']) host.memoryCompanion?.ensure(e.sessionId);
    }
  });

  host.directorOffHandles.push(
    ...registerDirectorBudgetAndContextBridges({
      director: host.director,
      events: host.deps.events,
      sessionFor: (subagentId) => host.sessionForSubagent(subagentId),
    }),
  );
  host.directorOffHandles.push(
    registerDirectorStatsBridge({
      director: host.director,
      events: host.deps.events,
      sessionId: host.deps.session.id,
    }),
  );
  host.directorOffHandles.push(
    ...registerDirectorSubagentLifecycleBridges({
      director: host.director,
      events: host.deps.events,
      sessionFor: (subagentId) => host.sessionForSubagent(subagentId),
      agentMonitor: host.opts.agentMonitor,
      onSubagentRemoved: (subagentId) => host.shadowManager.clearShadowAgent(subagentId),
    }),
  );
  const coordinator = host.getCoordinator();
  host.coordinatorOffHandle = registerCoordinatorLifecycleHandlers({
    coordinator,
    events: host.deps.events,
    sessionFor: (subagentId) => host.sessionForSubagent(subagentId),
    isShadowTask: (taskId) => host.shadowManager.isShadowTask(taskId),
    onSubagentStopped: (subagentId) => host.shadowManager.clearShadowAgent(subagentId),
  });
  host.fleetEmitTool = makeFleetEmitTool(host.director);
  host.directorToolsByName = new Map(
    host.director.tools(host.roster).map((tool) => [tool.name, tool] as const),
  );

  const adaptiveConfig = host.deps.configStore.get().adaptiveConcurrency;
  if (adaptiveConfig?.enabled) {
    host.adaptiveConcurrencyController = new AdaptiveConcurrencyController(
      host.director.fleet,
      (n: number) => coordinator.setMaxConcurrent(n),
      { maxConcurrent: host.getMaxConcurrent(), ...adaptiveConfig },
      undefined,
      host.deps.container.safeResolve(TOKENS.Logger),
    );
  }

  const runner = await host.buildSubagentRunner(config);
  if (!host.directorRunnerSet) {
    host.getCoordinator().setRunner(runner);
    host.directorRunnerSet = true;
  }

  host.shadowManager.armIfNeeded();
}
