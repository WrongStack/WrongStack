/** Builds live controller callbacks for the running CLI session. */
import type { Agent, Context } from '@wrongstack/core/agent';
import type { AuditLevel } from '@wrongstack/core/storage';
import type { Config, LogLevel, Provider } from '@wrongstack/core/types';
import type { EventBus } from '@wrongstack/core/kernel';
import { resolveConfiguredRefinerRef, resolveEnhanceFallbackRef } from '@wrongstack/core/execution';
import type { ControllerDeps } from '../execute-deps.js';
import type { AutonomyMode } from '../services/autonomy-mode.js';
import { deriveFsAccessPair } from '../settings-menu.js';
import { patchConfig } from '../utils.js';

export interface RuntimeControllerDepsInput {
  interruptController: ControllerDeps['interruptController'];
  enhanceController: ControllerDeps['enhanceController'];
  getEnhancerReasoning: ControllerDeps['getEnhancerReasoning'];
  buildProviderForId: (providerId: string) => Provider;
  context: Context;
  getConfig: () => Config;
  setConfig: (config: Config) => void;
  statuslineHiddenItems: ControllerDeps['statuslineHiddenItems'];
  setStatuslineHiddenItems: ControllerDeps['setStatuslineHiddenItems'];
  saveStatuslineHiddenItems: ControllerDeps['saveStatuslineHiddenItems'];
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
    buildEnhancerProvider: async (providerId) => {
      try {
        return input.buildProviderForId(providerId);
      } catch {
        return input.context.provider;
      }
    },
    getEnhanceFallbackRef: () =>
      resolveEnhanceFallbackRef(liveProviderConfig(input.getConfig(), input.context)),
    getConfiguredRefinerRef: () =>
      resolveConfiguredRefinerRef(liveProviderConfig(input.getConfig(), input.context)),
    statuslineHiddenItems: input.statuslineHiddenItems,
    setStatuslineHiddenItems: input.setStatuslineHiddenItems,
    saveStatuslineHiddenItems: input.saveStatuslineHiddenItems,
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
    if (
      settings.restrictFsToRoot !== undefined ||
      settings.allowOutsideProjectRoot !== undefined
    ) {
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
    input.setConfig(config);
  } catch {
    // Persistence is authoritative. Live application remains best-effort.
  }
}
