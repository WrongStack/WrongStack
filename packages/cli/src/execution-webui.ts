import { LeaderAutoWakeController } from '@wrongstack/coordination';
import { runWebUIDispatch } from './boot/dispatch-webui.js';
import type { ExecuteDeps } from './execute-deps.js';
import { createKanbanDispatchHandler } from './execution-kanban-dispatch.js';
import { createHqFleetControl } from './hq-fleet-control.js';
import { cliTuneupHooks } from './tuneup-hooks.js';
import type { UpdateInfo } from './update-check.js';

/** The fleet commands the WebUI runs from this process's registry, over the CLI's fleet host. */
const HOST_FLEET_COMMANDS = ['spawn', 'delegate', 'director', 'supervisor', 'acp', 'ensemble'];

export async function runExecutionWebui(deps: ExecuteDeps): Promise<number> {
  const {
    core: {
      agent,
      events,
      config,
      configStore,
      wpaths: initialWpaths,
      projectRoot: initialProjectRoot,
      flags,
      activateSessionIdentity,
      updateInfo: initialUpdateInfo,
      slashRegistry,
    },
    session: {
      session,
      mcpRegistry,
      sessionStore,
      memoryStore,
      vectorMemoryStore: vectorMemoryStoreFromExecute,
      vectorMemoryModelCacheDir: vectorMemoryModelCacheDirFromExecute,
      modeStore,
      rebindTodosCheckpoint,
      needsSetup,
    },
    provider: {
      modelsRegistry,
      providerAuthRegistry,
      statusTracker,
      onModelContextResolved,
      sddSubagentFactory,
    },
    ui: { renderer, skillLoader, promptLoader, modeId },
    fleet: { getDirector, releaseSessionHelpers, agentTranscripts },
    controllers: { interruptController, onAutonomy, applyLiveSettings },
    picker: { getBrainLog, brain, brainSettings, brainRuntime } = {},
    lifecycles: { subscribeEternalIteration } = {},
  } = deps;

  const wpaths = initialWpaths;
  const projectRoot = initialProjectRoot;
  const activeSessionStore = sessionStore;
  const profileName = config.activeProfile ?? 'default';
  const bootUpdateInfo: UpdateInfo | undefined = initialUpdateInfo;

  // The WebUI's auto-wake controller. Same live user-config read as the
  // TUI branch above; the two branches are exclusive, so this process
  // holds exactly one controller on the delivery hub (two would wake
  // every session twice). The WebUI host binds its port and never
  // creates its own.
  const webuiLeaderAutoWake = new LeaderAutoWakeController({
    events,
    config: () => {
      try {
        return configStore.get()?.fleet?.delegate;
      } catch {
        return undefined;
      }
    },
  });

  try {
    return await runWebUIDispatch({
      leaderAutoWake: webuiLeaderAutoWake,
      interruptController,
      agent,
      events,
      session,
      config,
      flags,
      projectRoot,
      globalConfigPath: wpaths.globalConfig,
      profileConfigPath: wpaths.profileConfig(profileName),
      projectSessionsDir: wpaths.projectSessions,
      modelsRegistry,
      providerAuthRegistry,
      mcpRegistry,
      brain,
      brainSettings,
      brainRuntime,
      getBrainLog,
      subscribeEternalIteration,
      sessionStore: activeSessionStore,
      memoryStore,
      getVectorMemoryStore: () => vectorMemoryStoreFromExecute,
      vectorMemoryModelCacheDir: vectorMemoryModelCacheDirFromExecute,
      skillLoader,
      promptLoader,
      modeStore,
      modeId,
      needsSetup,
      renderer,
      onAutonomy,
      applyLiveSettings,
      activateSessionIdentity,
      rebindTodosCheckpoint,
      agentTranscripts,
      onModelContextResolved,
      sddSubagentFactory,
      statusTracker,
      updateInfo: bootUpdateInfo,
      // Stopping a tab's run stops the work that tab started — its
      // subagents included. Aborting the leader's controller only unwinds
      // workers it is BLOCKED on; anything started with `spawn_subagent` +
      // `assign_task` keeps going unless asked to stop. Scoped to the
      // session so one tab's Stop never reaches another tab's fleet.
      stopSessionFleet: (sessionId: string, subagentIds?: readonly string[]) => {
        const director = getDirector?.();
        if (!director) return;
        const shown = (subagentIds ?? []).filter((id) => id.length > 0 && id !== 'leader');
        return Promise.all([
          director.terminateSession(sessionId),
          ...shown.map((id) => director.terminate(id).catch(() => undefined)),
        ]).then(() => undefined);
      },
      // HQ's per-tab abort fleet / abort agent / spawn, same scoping.
      hqFleetControl: createHqFleetControl(
        () => getDirector?.() ?? null,
        () => '',
        { multiConversation: true },
      ),
      // Closing a tab is not stopping it. The run keeps going and keeps its
      // fleet; what goes is the background help pinned to that conversation
      // — the explore companion's poll timer and the shadow reviewer's
      // bookkeeping — which nobody is watching any more.
      ...(releaseSessionHelpers ? { onSessionRetired: releaseSessionHelpers } : {}),
      getFleetBudget: () => {
        const d = getDirector?.() ?? null;
        if (!d) return null;
        const snap = d.fleetManager?.budgetSnapshot?.();
        const maxSpawns = snap?.maxSpawns ?? d.maxSpawns;
        const usedSpawns = snap?.usedSpawns ?? d.spawnCount;
        const remainingSpawns =
          snap?.remainingSpawns ??
          Math.max(
            0,
            (Number.isFinite(maxSpawns) ? maxSpawns : Number.POSITIVE_INFINITY) - usedSpawns,
          );
        const activeAgents = d
          .status()
          .subagents.filter((s) => s.status === 'running' || s.status === 'idle').length;
        return {
          maxSpawns,
          usedSpawns,
          remainingSpawns,
          activeAgents,
          ...(snap?.checkpointMaxSpawns !== undefined
            ? { checkpointMaxSpawns: snap.checkpointMaxSpawns }
            : {}),
          ...(snap?.ceilingMismatch ? { ceilingMismatch: true } : {}),
        };
      },
      ...createKanbanDispatchHandler({ config, events, skillLoader, sddSubagentFactory }),
      tuneupHooks: cliTuneupHooks,
      hostCommands: () =>
        HOST_FLEET_COMMANDS.flatMap((name) => {
          const command = slashRegistry.get(name);
          return command ? [command] : [];
        }),
    });
  } finally {
    webuiLeaderAutoWake.dispose();
  }
}
