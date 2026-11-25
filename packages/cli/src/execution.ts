import * as path from 'node:path';
import { mergeCustomModelDefs } from '@wrongstack/core/utils';
import { capabilitiesFor, catalogProviderIdFor } from '@wrongstack/providers';
import { createToolVisionAdapters } from '@wrongstack/runtime/vision';
import { runSingleShotDispatch } from './boot/dispatch-singleshot.js';
import { resolveExecutionMode } from './boot/execution-mode.js';
import { appendPipedStdin, readPipedStdin } from './boot/piped-stdin.js';
import type { ExecuteDeps } from './execute-deps.js';
import { installExecutionChimeraHandlers } from './execution-chimera-handlers.js';
import { finalizeExecutionCleanup } from './execution-cleanup.js';
import { createKanbanDispatchHandler } from './execution-kanban-dispatch.js';
import { createReplFleetCallbacks } from './execution-repl-fleet-callbacks.js';
import { installStorageObservability } from './execution-storage-observability.js';
import { runExecutionTui } from './execution-tui.js';
import { runExecutionWebui } from './execution-webui.js';
import { FleetStatusLine } from './fleet-statusline.js';
import { runRepl } from './repl.js';
import type { StandaloneAutoUpdate } from './standalone-auto-update.js';
import type { UpdateInfo } from './update-check.js';
import { CLI_VERSION } from './version.js';

export {
  __resetReviewerRoundRobinCursor,
  applyChimeraReviewerReadOnlyPolicy,
  assignReviewerModels,
  assignReviewerModelsRoundRobin,
  CHIMERA_REVIEW_READ_ONLY_TOOLS,
  resolveReviewerFallbackModels,
} from './chimera-reviewer-policy.js';
export type {
  BrainData,
  BrainLogEntry,
  ExecuteDeps,
  McpPickerItem,
  PluginPickerItem,
  RestoredToolCall,
  ToolPickerItem,
} from './execute-deps.js';
export type { LiveSettingsInput } from './live-settings-input.js';

export async function execute(deps: ExecuteDeps): Promise<number> {
  const {
    core: {
      agent,
      events,
      config,
      configStore,
      wpaths: initialWpaths,
      projectRoot: initialProjectRoot,
      flags,
      positional,
      slashRegistry,
      tokenCounter,
      updateInfo: initialUpdateInfo,
    },
    session: { session, context, attachments, mcpRegistry, sessionStore, detachTodosCheckpoint },
    provider: { modelsRegistry, sddSubagentFactory },
    ui: { renderer, reader, stats, effectiveMaxContext, getEffectiveMaxContext, skillLoader },
    fleet: { director, getDirector, fleetStreamController, agentsMonitorController },
    controllers: {
      interruptController,
      getYolo,
      getAutonomy,
      onAutonomy,
      getNextPredict,
      onCountdownTick,
    },
    lifecycles: {
      getSuggestions,
      getAutoSuggestions,
      onSuggestionsParsed,
      autonomyNextPrompt,
      autoProceedDelayMs,
      autoProceedMaxIterations,
      onValidateAutoProceed,
      getEternalEngine,
      getParallelEngine,
      getSddRun,
      onDestroy,
      onCoordinatorStop,
    } = {},
  } = deps;

  let onCoordinatorStopImpl: (() => void) | undefined = onCoordinatorStop;

  const wpaths = initialWpaths;
  const projectRoot = initialProjectRoot;
  const activeSessionStore = sessionStore;
  const detachActiveTodosCheckpoint: (() => void | Promise<void>) | undefined =
    detachTodosCheckpoint;
  const profileName = config.activeProfile ?? 'default';
  const bootUpdateInfo: UpdateInfo | undefined = initialUpdateInfo;

  const offStorageObservability = installStorageObservability(events, context.traceId);
  const { chimeraWork, chimeraTeardowns } = installExecutionChimeraHandlers(deps);

  let code = 0;
  let backgroundKanbanSupervisor: { dispose(): void } | undefined;
  let autoUpdate: StandaloneAutoUpdate | undefined;
  let fleetStatusLine: FleetStatusLine | null = null;
  try {
    const visionAdapters = () => createToolVisionAdapters(agent.tools);
    const supportsVision = async (): Promise<boolean> => {
      if (context.provider.supportsVisionFor) {
        return context.provider.supportsVisionFor(context.model, context.session.id);
      }
      try {
        const providerConfig = config.providers?.[context.provider.id];
        const mergedModels = mergeCustomModelDefs(providerConfig?.customModels, config.models);
        const caps = await capabilitiesFor(
          modelsRegistry,
          context.provider.id,
          context.model,
          mergedModels,
          { catalogProviderId: catalogProviderIdFor(context.provider.id, providerConfig?.type) },
        );
        if (caps.vision && !context.provider.capabilities.vision) {
          Object.defineProperty(context.provider, 'capabilities', {
            value: { ...context.provider.capabilities, vision: true, pdf: caps.pdf },
            writable: true,
            configurable: true,
            enumerable: true,
          });
        }
        return caps.vision;
      } catch {
        return context.provider.capabilities.vision;
      }
    };
    const promptFlag = typeof flags['prompt'] === 'string' ? flags['prompt'] : undefined;
    if (promptFlag) {
      positional.unshift(promptFlag);
    }
    const goalFlag = typeof flags['goal'] === 'string' ? flags['goal'] : undefined;
    const askFlag = typeof flags['ask'] === 'string' ? flags['ask'] : undefined;
    const executionMode = resolveExecutionMode(positional, flags);
    if (projectRoot && executionMode !== 'webui') {
      backgroundKanbanSupervisor = (
        await import('./webui-server/kanban-supervisor.js')
      ).createKanbanSupervisor({
        projectRoot,
        broadcast: () => {},
        dispatchTask: createKanbanDispatchHandler({
          config,
          events,
          skillLoader,
          sddSubagentFactory,
        }).onKanbanDispatch,
        log: (message) => console.log(message),
      });
    }
    // Interactive sessions only: a one-shot run must not start a 100+ MB
    // download.
    if (executionMode !== 'single-shot') {
      autoUpdate = (await import('./standalone-auto-update.js')).startStandaloneAutoUpdate({
        getConfig: () => configStore.get(),
        updateInfo: bootUpdateInfo,
      });
    }
    const enteringTui = executionMode === 'tui';
    if (!enteringTui) {
      fleetStatusLine = new FleetStatusLine({ events, version: CLI_VERSION });
      fleetStatusLine.start();
    }
    if (executionMode === 'single-shot') {
      const piped = await readPipedStdin(process.stdin);
      if (piped.timedOut) {
        renderer.writeWarning(
          'No stdin data received in time; continuing without it. Redirect stdin (< /dev/null) to skip the wait.',
        );
      } else if (piped.truncated) {
        renderer.writeWarning('Piped stdin exceeded 2 MB and was truncated.');
      }
      // MCP servers start in the background. A one-shot run is a single turn,
      // and a turn takes the tool list as it is when it starts, so without
      // this wait their tools were never offered to it.
      await mcpRegistry.whenStarted();
      code = await runSingleShotDispatch({
        agent,
        query: appendPipedStdin(positional.join(' '), piped.text),
        flags,
        tokenCounter,
        renderer,
        events,
        interruptController,
      });
    } else if (executionMode === 'tui') {
      const tui = await runExecutionTui(deps, {
        wpaths,
        projectRoot,
        activeSessionStore,
        detachActiveTodosCheckpoint,
        profileName,
        bootUpdateInfo,
        supportsVision,
        visionAdapters,
        goalFlag,
        askFlag,
        autoUpdate,
        setCoordinatorStop: (fn) => {
          onCoordinatorStopImpl = fn;
        },
      });
      if (tui.exitWith !== undefined) return tui.exitWith;
      code = tui.code;
    } else if (executionMode === 'webui') {
      code = await runExecutionWebui(deps);
    } else {
      // Imported here rather than at module scope: this is the ONLY static
      // path from the always-loaded CLI graph into `@wrongstack/webui-server`
      // (831KB, +38.7MB heap / +80.2MB RSS standalone). `webui-server.ts`
      // itself is already loaded lazily from `boot/dispatch-webui.ts`, so this
      // one import was single-handedly defeating that boundary and making every
      // `wstack` invocation pay for a WebUI server that is off by default.
      const headlessKanbanMirror = projectRoot
        ? (await import('./webui-server/kanban-run-mirror.js')).createKanbanRunMirror({
            projectRoot,
            events,
            broadcast: () => {},
            log: (m) => console.log(m),
          })
        : null;
      try {
        code = await runRepl({
          agent,
          renderer,
          reader,
          slashRegistry,
          tokenCounter,
          visionAdapters,
          supportsVision,
          attachments,
          effectiveMaxContext,
          getEffectiveMaxContext,
          projectName: path.basename(projectRoot) || undefined,
          projectRoot,
          appConfig: config,
          getSessionId: () => agent.ctx.session?.id ?? session.id,
          getAutonomy,
          onAutonomy,
          getNextPredict,
          onSuggestionsParsed,
          getSuggestions,
          getAutoSuggestions,
          getYolo,
          autonomyNextPrompt,
          autoProceedDelayMs,
          onValidateAutoProceed,
          autoProceedMaxIterations,
          getEternalEngine,
          getParallelEngine,
          getSddRun,
          skillLoader,
          agentsMonitorController,
          fleetStreamController,
          interruptController,
          ...createReplFleetCallbacks({ director, getDirector }),
          onCountdownTick,
          onDestroy,
        });
      } finally {
        headlessKanbanMirror?.dispose();
      }
    }
  } finally {
    backgroundKanbanSupervisor?.dispose();
    autoUpdate?.dispose();
    // Release session-scoped wildcard listeners (chimera review/cascade)
    // BEFORE the cleanup drains below, so no stale listener survives into
    // teardown — the EventBus wildcard-disposer fix.
    for (const off of chimeraTeardowns.splice(0)) {
      try {
        off();
      } catch {
        /* best-effort — a throwing disposer must not block cleanup */
      }
    }
    await finalizeExecutionCleanup({
      offStorageObservability,
      fleetStatusLine,
      onCoordinatorStop: onCoordinatorStopImpl,
      stats,
      renderer,
      detachTodosCheckpoint,
      mcpRegistry,
      agent,
      session,
      tokenCounter,
      events,
      chimeraWork,
      director,
      reader,
    });
  }
  return code;
}
