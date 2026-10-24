import type { Config } from '@wrongstack/contracts/types/config';

import type { Logger } from '@wrongstack/contracts/types/logger';

import type { SubagentConfig } from '@wrongstack/contracts/types/multi-agent';

import { resolveDirectorSpawnModel } from './director-spawn-model.js';

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
): void {
  const appConfig = typeof host.appConfig === 'function' ? host.appConfig() : host.appConfig;
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
    sessionProvider:
      typeof host.sessionProvider === 'function' ? host.sessionProvider() : host.sessionProvider,
    sessionModel: typeof host.sessionModel === 'function' ? host.sessionModel() : host.sessionModel,
    statusTracker: host.statusTracker,
    logger: host.logger,
  });
}
