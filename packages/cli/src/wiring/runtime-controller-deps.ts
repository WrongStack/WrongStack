/** Builds live controller callbacks for the running CLI session. */
import type { Agent, Context } from '@wrongstack/core/agent';
import { resolveConfiguredRefinerRef, resolveEnhanceFallbackRef } from '@wrongstack/core/execution';
import type { EventBus } from '@wrongstack/core/kernel';
import type { AuditLevel } from '@wrongstack/core/storage';
import type { Config, LogLevel, Provider } from '@wrongstack/core/types';
import type { ControllerDeps } from '../execute-deps.js';
import type { AutonomyMode } from '../services/autonomy-mode.js';
import { deriveFsAccessPair } from '../settings-menu.js';
import { patchConfig } from '../utils.js';

interface RuntimeControllerDepsInput {
  interruptController: ControllerDeps['interruptController'];
  enhanceController: ControllerDeps['enhanceController'];
  getEnhancerReasoning: ControllerDeps['getEnhancerReasoning'];
  /** Effort levels the active model documents (see ControllerDeps). Optional
   *  to mirror ControllerDeps — hosts without catalog metadata omit it. */
  getActiveModelReasoningEffortLevels?: ControllerDeps['getActiveModelReasoningEffortLevels'];
  buildProviderForModel: (providerId: string, modelId: string) => Promise<Provider>;
  context: Context;
  getConfig: () => Config;
  setConfig: (config: Config) => void;
  statuslineHiddenItems: ControllerDeps['statuslineHiddenItems'];
  setStatuslineHiddenItems: ControllerDeps['setStatuslineHiddenItems'];
  saveStatuslineHiddenItems: ControllerDeps['saveStatuslineHiddenItems'];
  statuslineLines?: ControllerDeps['statuslineLines'];
  setStatuslineLines?: ControllerDeps['setStatuslineLines'];
  saveStatuslineLines?: ControllerDeps['saveStatuslineLines'];
  getYolo: NonNullable<ControllerDeps['getYolo']>;
  onYolo: NonNullable<ControllerDeps['onYolo']>;
  getAutonomy: () => AutonomyMode;
  setAutonomy: (mode: AutonomyMode) => void;
  getNextPredict: () => boolean;
  setNextPredict: (enabled: boolean) => void;
  agent: Agent;
  setPermissionYolo: (enabled: boolean) => void;
  setLogLevel: (level: LogLevel) => void;
  sessionBridge: { setAuditLevel(level: AuditLevel): void };
  autoCompactor?: { setEnabled(enabled: boolean): void } | undefined;
  multiAgentHost: { setMaxConcurrent(maxConcurrent: number): void };
  events: EventBus;
  getSessionId: () => string;
}

export function createRuntimeControllerDeps(input: RuntimeControllerDepsInput): ControllerDeps {
  return {
    interruptController: input.interruptController,
    enhanceController: input.enhanceController,
    getEnhancerReasoning: input.getEnhancerReasoning,
    getActiveModelReasoningEffortLevels: input.getActiveModelReasoningEffortLevels,
    buildEnhancerProvider: async (providerId, modelId) => {
      try {
        return await input.buildProviderForModel(providerId, modelId);
      } catch {
        // Returning the live provider here while preserving the requested
        // model id creates an invalid cross-provider pair (for example,
        // openai-codex/deepseek-v4-flash). Let the refinement recovery UI
        // report an unavailable target instead.
        return undefined;
      }
    },
    getEnhanceFallbackRef: () =>
      resolveEnhanceFallbackRef(liveProviderConfig(input.getConfig(), input.context)),
    getConfiguredRefinerRef: () =>
      resolveConfiguredRefinerRef(liveProviderConfig(input.getConfig(), input.context)),
    statuslineHiddenItems: input.statuslineHiddenItems,
    setStatuslineHiddenItems: input.setStatuslineHiddenItems,
    saveStatuslineHiddenItems: input.saveStatuslineHiddenItems,
    statuslineLines: input.statuslineLines,
    setStatuslineLines: input.setStatuslineLines,
    saveStatuslineLines: input.saveStatuslineLines,
    getYolo: input.getYolo,
    onYolo: input.onYolo,
    getAutonomy: input.getAutonomy,
    onAutonomy: (mode) => {
      if (mode !== undefined) input.setAutonomy(mode);
    },
    getNextPredict: input.getNextPredict,
    applyLiveSettings: (settings) => applyLiveSettings(input, settings),
    onCountdownTick: (remaining) => {
      input.events.emit('countdown.tick', {
        sessionId: input.getSessionId(),
        remaining,
      });
      return false;
    },
  };
}

function liveProviderConfig(config: Config, context: Context): Config {
  return { ...config, provider: context.provider.id, model: context.model };
}

function applyLiveSettings(
  input: RuntimeControllerDepsInput,
  settings: Parameters<NonNullable<ControllerDeps['applyLiveSettings']>>[0],
): void {
  try {
    let config = input.getConfig();
    if (settings.yolo !== undefined) {
      input.setPermissionYolo(settings.yolo);
      config = patchConfig(config, { yolo: settings.yolo });
    }
    if (settings.nextPrediction !== undefined) {
      input.setNextPredict(settings.nextPrediction);
      config = patchConfig(config, { nextPrediction: settings.nextPrediction });
    }
    if (settings.enhanceEnabled !== undefined) {
      input.enhanceController?.setEnabled(settings.enhanceEnabled);
    }
    if (settings.readSymbols !== undefined) {
      input.context.meta['tools.read.advancedMode'] = settings.readSymbols;
    }
    if (settings.maxIterations !== undefined) input.agent.maxIterations = settings.maxIterations;
    if (settings.logLevel !== undefined) input.setLogLevel(settings.logLevel as LogLevel);
    if (settings.auditLevel !== undefined) {
      input.sessionBridge.setAuditLevel(settings.auditLevel as AuditLevel);
    }
    if (settings.contextAutoCompact !== undefined) {
      input.autoCompactor?.setEnabled(settings.contextAutoCompact);
    }
    if (settings.maxConcurrent !== undefined && settings.maxConcurrent > 0) {
      input.multiAgentHost.setMaxConcurrent(settings.maxConcurrent);
      input.events.emit('concurrency.changed', {
        sessionId: input.getSessionId(),
        n: settings.maxConcurrent,
      });
      config = patchConfig(config, { maxConcurrent: settings.maxConcurrent });
    }
    if (settings.restrictFsToRoot !== undefined || settings.allowOutsideProjectRoot !== undefined) {
      const access = deriveFsAccessPair(settings);
      if (access) {
        input.context.allowOutsideProjectRoot = access.allowOutsideProjectRoot;
        config = patchConfig(config, {
          features: {
            ...config.features,
            allowOutsideProjectRoot: access.allowOutsideProjectRoot,
          },
          tools: {
            ...config.tools,
            restrictToProjectRoot: access.restrictToProjectRoot,
          },
        });
      }
    }
    // WrongProxy / WrongTrace: mirror the picker state into the live
    // config so the runtime probe (`packages/cli/src/wiring/proxy-probe.ts`)
    // sees the new values without a session restart. Both keys land in
    // `config.tools.wrongProxy.{enabled,url}` — the same shape `getSettings()`
    // reads from disk. Without this entry, the runtime never reads the
    // picker's mid-session toggle. The canonical type
    // (`ToolsConfig.wrongProxy?: WrongProxyToolConfig`) replaces the
    // earlier index-signature widening cast.
    if (settings.wrongProxyEnabled !== undefined || settings.wrongProxyUrl !== undefined) {
      const prev = config.tools?.wrongProxy;
      const next = {
        ...(prev ?? {}),
        ...(settings.wrongProxyEnabled !== undefined ? { enabled: settings.wrongProxyEnabled } : {}),
        ...(settings.wrongProxyUrl !== undefined ? { url: settings.wrongProxyUrl } : {}),
      };
      config = patchConfig(config, {
        tools: {
          ...config.tools,
          wrongProxy: next,
        },
      });
      // Mirror into ctx.meta so the runtime probe (which reads from
      // `meta['wrongProxyEnabled']` / `meta['wrongProxyUrl']` via the WS
      // prefs pipeline) sees the change immediately. The WebUI pipeline
      // also writes here — keeping the TUI path symmetric avoids drift.
      if (settings.wrongProxyEnabled !== undefined) {
        input.context.meta['wrongProxyEnabled'] = settings.wrongProxyEnabled;
      }
      if (settings.wrongProxyUrl !== undefined) {
        input.context.meta['wrongProxyUrl'] = settings.wrongProxyUrl;
      }
    }
    input.setConfig(config);
  } catch {
    // Persistence is authoritative. Live application remains best-effort.
  }
}
