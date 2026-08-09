import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import {
  DEFAULT_MAX_FLEET_SPAWNS,
  FleetManager,
  type FleetWorktreePolicy,
  HARD_MAX_SPAWN_DEPTH,
} from '@wrongstack/core/coordination';
import type { Config } from '@wrongstack/core/types';
import { WorktreeManager } from '@wrongstack/core/worktree';

import { resolveFleetWorktreePolicy } from './host-helpers.js';
import type { MultiAgentDeps, MultiAgentHostOptions } from './host-types.js';

export function createHostFleetManager(opts: MultiAgentHostOptions): FleetManager {
  return new FleetManager({
    manifestPath: opts.manifestPath,
    sessionsRoot: opts.sessionsRoot,
    directorRunId: opts.directorRunId,
    stateCheckpointPath: opts.stateCheckpointPath,
    sessionWriter: opts.sessionWriter,
    directorBudget: opts.directorBudget,
    maxSpawns: opts.maxSpawns ?? DEFAULT_MAX_FLEET_SPAWNS,
    manifestDebounceMs: 2000,
    checkpointDebounceMs: opts.checkpointDebounceMs ?? 250,
    maxSpawnDepth: HARD_MAX_SPAWN_DEPTH,
    maxContext: opts.getLeaderMaxContext,
  });
}

export function prepareHostDirectorRuntime(input: {
  config: Config;
  deps: MultiAgentDeps;
  opts: MultiAgentHostOptions;
}): {
  coordinatorConfig: {
    coordinatorId: string;
    doneCondition: { type: 'all_tasks_done' };
    maxConcurrent: number;
  };
  fleetLifecycle: NonNullable<Config['fleet']>['lifecycle'] | undefined;
  subagentIdleTimeoutMs: number;
  defaultScratchpad: string | undefined;
  worktreePolicy: FleetWorktreePolicy;
  worktrees: WorktreeManager | undefined;
} {
  const { config, deps, opts } = input;
  const coordinatorConfig = {
    coordinatorId: randomUUID(),
    doneCondition: { type: 'all_tasks_done' as const },
    maxConcurrent: opts.maxConcurrent ?? 4,
  };
  const fleetLifecycle = config.fleet?.lifecycle;
  const configuredIdleTimeoutMs = opts.subagentIdleTimeoutMs ?? fleetLifecycle?.idleTimeoutMs;
  const subagentIdleTimeoutMs =
    typeof configuredIdleTimeoutMs === 'number' &&
    Number.isFinite(configuredIdleTimeoutMs) &&
    configuredIdleTimeoutMs >= 0
      ? configuredIdleTimeoutMs
      : 300_000; // 5 min — covers the typical leader reasoning gap between
  // `spawn_subagent` and `assign_task`. This fallback governs
  // the lifecycle removal timeout only; the per-spawn
  // `spawn_subagent({ idleTimeoutMs })` parameter feeds the
  // separate in-task activity watchdog (see
  // multi-agent-coordinator.ts).
  const defaultScratchpad =
    opts.sharedScratchpadPath ||
    (opts.sessionsRoot && opts.directorRunId
      ? path.join(opts.sessionsRoot, opts.directorRunId, 'shared')
      : undefined);
  const worktreePolicy = resolveFleetWorktreePolicy(config);
  const worktrees =
    worktreePolicy.enabled === false || worktreePolicy.mode === 'off'
      ? undefined
      : new WorktreeManager({
          projectRoot: deps.projectRoot,
          events: deps.events,
          sessionId: () => deps.session.id,
        });
  return {
    coordinatorConfig,
    fleetLifecycle,
    subagentIdleTimeoutMs,
    defaultScratchpad,
    worktreePolicy,
    worktrees,
  };
}
