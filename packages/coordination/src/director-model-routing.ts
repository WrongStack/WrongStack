import type { Config } from '@wrongstack/contracts/types/config';
import { ToolValidationError } from '@wrongstack/contracts/types/errors';

import type { Logger } from '@wrongstack/contracts/types/logger';

import type { SubagentConfig } from '@wrongstack/contracts/types/multi-agent';
import { parseModelRef } from '@wrongstack/core/agent';

import { resolveDirectorSpawnModel } from './director-spawn-model.js';
import { isExternalAgentProvider } from './external-agent-provider.js';

import type { FleetManager } from './fleet-manager.js';

import { type ModelMatrixSource, resolveModelMatrixResolution } from './model-matrix.js';

import type { ProviderModelStatusTracker } from './provider-status-tracker.js';

import type { SubagentSlotClaim } from './session-subagent-models.js';

export interface DirectorModelRoutingHost {
  modelMatrix: ModelMatrixSource | undefined;
  fleetManager: FleetManager | undefined;
  subagentMeta: Map<
    string,
    { provider?: string | undefined; model?: string | undefined; effort?: string | undefined }
  >;
  appConfig: Config | (() => Config | undefined) | undefined;
  sessionProvider: string | (() => string | undefined) | undefined;
  sessionModel: string | (() => string | undefined) | undefined;
  statusTracker: ProviderModelStatusTracker | undefined;
  logger: Logger | undefined;
}
export function hasExplicitMatrixRoute(
  host: DirectorModelRoutingHost,
  role: string | undefined,
): boolean {
  const matrix = typeof host.modelMatrix === 'function' ? host.modelMatrix() : host.modelMatrix;
  const source = resolveModelMatrixResolution(matrix, role)?.source;
  return source === 'role' || source === 'phase';
}

export function resolvedModelFor(
  host: DirectorModelRoutingHost,
  subagentId: string,
):
  | { provider?: string | undefined; model?: string | undefined; effort?: string | undefined }
  | undefined {
  // Two homes for the same fact: `fleet-spawn` records into the FleetManager
  // when one is injected (the CLI/WebUI path) and into the Director's own map
  // otherwise (embedded + tests). Read both so the answer does not depend on
  // which host built the fleet.
  return host.fleetManager?.getSubagentMeta(subagentId) ?? host.subagentMeta.get(subagentId);
}

export function resolveSpawnModel(
  host: DirectorModelRoutingHost,
  config: SubagentConfig,
  slotClaim?: SubagentSlotClaim | undefined,
  companion = false,
): void {
  const appConfig = typeof host.appConfig === 'function' ? host.appConfig() : host.appConfig;
  const sessionProvider =
    typeof host.sessionProvider === 'function' ? host.sessionProvider() : host.sessionProvider;
  const sessionModel =
    typeof host.sessionModel === 'function' ? host.sessionModel() : host.sessionModel;
  const externalLeader =
    companion && isExternalAgentProvider(sessionProvider ?? appConfig?.provider);
  const sideModel = externalLeader
    ? [appConfig?.acp?.leader?.sideModel, appConfig?.fallbackBridge, appConfig?.fallbackModels?.[0]]
        .map((ref) => parseModelRef(ref ?? ''))
        .find(({ provider, model }) => provider && model && !isExternalAgentProvider(provider))
    : undefined;
  resolveDirectorSpawnModel(config, {
    modelMatrix: host.modelMatrix,
    ...(slotClaim
      ? {
          sessionPlan: {
            kind: slotClaim.kind,
            target: slotClaim.target,
            lock: slotClaim.lock,
            slotIndex: slotClaim.slotIndex,
          },
        }
      : {}),
    ...(appConfig ? { config: appConfig } : {}),
    ...(config.tier ? { tier: config.tier } : {}),
    onTierResolved: (resolved) => {
      // Record the tier that actually applied so the fleet manifest and the
      // office map show the level a worker is running at, not just its model.
      config.tier = resolved.tier;
    },
    sessionProvider: externalLeader ? sideModel?.provider : sessionProvider,
    sessionModel: externalLeader ? sideModel?.model : sessionModel,
    statusTracker: host.statusTracker,
    logger: host.logger,
  });
  if (
    companion &&
    (isExternalAgentProvider(config.provider) ||
      (externalLeader && (!config.provider || !config.model)))
  ) {
    throw new ToolValidationError({
      message: `Companion "${config.role ?? config.name ?? 'unknown'}" requires a native provider and model. Configure a native role route or acp.leader.sideModel for an external leader.`,
      field: 'provider',
    });
  }
}
