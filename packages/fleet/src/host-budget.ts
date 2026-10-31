import { aggregateFleetUsage, type FleetHostUsage } from './host-status.js';

export interface HostBudgetHost {
  fleetManager: import('@wrongstack/coordination').FleetManager | undefined;
  opts: import('./host-types.js').MultiAgentHostOptions;
  director: import('@wrongstack/coordination').Director | undefined;
  getCoordinator: () => import('@wrongstack/coordination').DefaultMultiAgentCoordinator;
  getMaxConcurrent: () => number;
  shadowManager: import('./host-shadow-manager.js').HostShadowManager;
}

export function budgetView(this: HostBudgetHost): import('./host-status.js').FleetBudgetView {
  const snap = this.fleetManager?.budgetSnapshot?.();
  const maxSpawns =
    snap?.maxSpawns ?? this.opts.maxSpawns ?? this.director?.maxSpawns ?? Number.POSITIVE_INFINITY;
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

export function usage(this: HostBudgetHost): FleetHostUsage {
  const shadowTaskIds = this.shadowManager.getTaskIds();
  const completed = this.director
    ? this.director.completedResults().filter((r) => !shadowTaskIds.has(r.taskId))
    : [];
  return aggregateFleetUsage(completed);
}

export async function manifest(this: HostBudgetHost): Promise<string | null> {
  if (!this.director) return null;
  return (await this.director.fleetManager?.writeManifest()) ?? null;
}
