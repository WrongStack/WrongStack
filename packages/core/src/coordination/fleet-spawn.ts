/**
 * Fleet spawn admission and bookkeeping for the Director.
 *
 * Owns spawn caps, model-matrix routing, nickname assignment, bridge
 * creation, and manifest/checkpoint registration. Task identity and waiter
 * semantics belong to DirectorTaskRegistry; termination remains a Director
 * lifecycle concern.
 */

import type { DirectorStateCheckpoint } from '../storage/director-state.js';
import type { SubagentConfig } from '../types/multi-agent.js';
import { InMemoryAgentBridge } from './agent-bridge.js';
import {
  FleetContextOverflowError,
  FleetCostCapError,
  FleetSpawnBudgetError,
  FleetTokenCapError,
} from './director/director-errors.js';
import type { FleetBus, FleetUsageAggregator } from './fleet-bus.js';
import type { FleetManager } from './fleet-manager.js';
import type { InMemoryBridgeTransport } from './in-memory-transport.js';
import {
  type ModelMatrixSource,
  resolveModelMatrixResolution,
  roleNeedsIndependentReviewModel,
} from './model-matrix.js';
import type { DefaultMultiAgentCoordinator } from './multi-agent-coordinator.js';
import { resolveMaxSpawnDepth } from './spawn-budget.js';
import { assignNickname } from './subagent-nicknames.js';
import type { WorktreeTaskStateUpdate } from './worktree-task-runner.js';

/**
 * Shape stored in the Director's manifestEntries map for each spawned subagent.
 * Keyed by subagentId.
 */
export interface ManifestEntry {
  subagentId: string;
  name: string;
  role?: string | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  taskIds: string[];
  /** Per-task worktree state updates, keyed by taskId. The entire record
   *  is replaced each time (see `Director._asManifestEntry`), so external
   *  references to a previous `worktrees` object become stale. */
  worktrees?: Record<string, WorktreeTaskStateUpdate> | undefined;
}

/**
 * Narrow interface the helpers in this file need from the Director.
 * Kept here (instead of importing the full Director class) to avoid a
 * circular import: director.ts re-exports the helpers.
 */
export interface DirectorFleetHost {
  // Identity
  readonly id: string;

  // Coordinator / transport
  readonly coordinator: DefaultMultiAgentCoordinator;
  readonly fleet: FleetBus;
  readonly transport: InMemoryBridgeTransport;
  readonly stateCheckpoint: DirectorStateCheckpoint | null;

  // Spawn budget + counters
  workCompleteFlag: boolean;
  spawnCount: number;
  readonly maxSpawns: number;
  readonly maxSpawnDepth: number;
  readonly spawnDepth: number;
  readonly maxFleetCostUsd: number;
  readonly maxFleetTokens?: number | undefined;
  readonly maxLeaderContextLoad: number;
  leaderContextPressure: number;
  readonly modelMatrix?: ModelMatrixSource | undefined;

  // Aggregator
  readonly usage: FleetUsageAggregator;
  readonly fleetManager: FleetManager | undefined;

  // Per-subagent state
  readonly manifestEntries: Map<string, unknown>;
  readonly subagentBridges: Map<string, InMemoryAgentBridge>;
  readonly subagentMeta: Map<string, { provider?: string | undefined; model?: string | undefined }>;
  readonly priceLookups: Map<
    string,
    {
      input?: number | undefined;
      output?: number | undefined;
      cacheRead?: number | undefined;
      cacheWrite?: number | undefined;
    }
  >;

  // Nickname tracking
  readonly usedNicknames: Set<string>;

  // Helpers exposed back to the helpers
  appendSessionEvent(event: unknown): Promise<void>;
  scheduleManifest(): void;
  resolveMaxContext(): number;
}

/**
 * Spawn a subagent. See `Director.spawn` for the full contract.
 */
export async function spawn(
  host: DirectorFleetHost,
  config: SubagentConfig,
  priceLookup?: {
    input?: number | undefined;
    output?: number | undefined;
    cacheRead?: number | undefined;
    cacheWrite?: number | undefined;
  },
): Promise<string> {
  // workComplete() signal: once the director decides the work is done,
  // refuse to spawn new subagents so the fleet winds down naturally.
  if (host.workCompleteFlag) {
    throw new FleetSpawnBudgetError(
      'max_spawns',
      host.maxSpawns,
      host.spawnCount + 1,
      'workComplete() has been called — director closed further spawning',
    );
  }
  // Per-task model matrix: when the caller didn't pin a model, resolve one
  // from the matrix by role (→ phase → `*`). Done here, before the spawned
  // event + manifest + coordinator handoff, so the fleet UI and the agent
  // itself all reflect the matched model. Explicit per-spawn models win.
  if (!config.model && host.modelMatrix) {
    const matrix = typeof host.modelMatrix === 'function' ? host.modelMatrix() : host.modelMatrix;
    const resolution = resolveModelMatrixResolution(matrix, config.role);
    const entry =
      resolution?.source === 'default' && roleNeedsIndependentReviewModel(config.role)
        ? undefined
        : resolution?.entry;
    if (entry) {
      if (entry.model) config.model = entry.model;
      if (entry.provider) config.provider = entry.provider;
      if (entry.fallbackProfile) config.fallbackProfile = entry.fallbackProfile;
      if (entry.modelRuntime) config.modelRuntime = entry.modelRuntime;
    }
  }
  // Enforce safety caps BEFORE touching the coordinator — a refused
  // spawn must not leak partial state into the manifest or fleet bus.
  // Delegate to FleetManager when available; use inline checks otherwise.
  if (host.fleetManager) {
    const rejection = host.fleetManager.canSpawn(config);
    if (rejection) {
      if (rejection.kind === 'max_spawn_depth')
        throw new FleetSpawnBudgetError('max_spawn_depth', rejection.limit, rejection.observed);
      if (rejection.kind === 'max_spawns')
        throw new FleetSpawnBudgetError('max_spawns', rejection.limit, rejection.observed);
      if (rejection.kind === 'max_cost_usd')
        throw new FleetCostCapError(rejection.limit, rejection.observed);
      if (rejection.kind === 'max_tokens')
        throw new FleetTokenCapError(rejection.limit, rejection.observed);
      if (rejection.kind === 'max_context_load')
        throw new FleetContextOverflowError(rejection.limit, rejection.observed);
    }
  } else {
    const maxSpawnDepth = resolveMaxSpawnDepth(host.maxSpawnDepth);
    if (host.spawnDepth >= maxSpawnDepth) {
      throw new FleetSpawnBudgetError('max_spawn_depth', maxSpawnDepth, host.spawnDepth);
    }
    if (host.spawnCount >= host.maxSpawns && !config.spawnBudgetExempt) {
      throw new FleetSpawnBudgetError('max_spawns', host.maxSpawns, host.spawnCount + 1);
    }
    if (host.maxFleetCostUsd < Number.POSITIVE_INFINITY) {
      const totalCost = host.usage.snapshot().total?.cost ?? 0;
      if (totalCost >= host.maxFleetCostUsd) {
        throw new FleetCostCapError(host.maxFleetCostUsd, totalCost);
      }
    }
    const maxFleetTokens = host.maxFleetTokens ?? Number.POSITIVE_INFINITY;
    if (maxFleetTokens < Number.POSITIVE_INFINITY) {
      const total = host.usage.snapshot().total;
      const usedTokens = (total?.input ?? 0) + (total?.output ?? 0);
      if (usedTokens >= maxFleetTokens) {
        throw new FleetTokenCapError(maxFleetTokens, usedTokens);
      }
    }
    // Context pressure check: reject spawn if leader context is too full.
    // maxLeaderContextLoad === 1.0 disables this check.
    if (host.maxLeaderContextLoad < 1.0) {
      const maxContext = host.resolveMaxContext();
      const threshold = maxContext * host.maxLeaderContextLoad;
      if (host.leaderContextPressure >= threshold) {
        throw new FleetContextOverflowError(threshold, host.leaderContextPressure);
      }
    }
  }
  // If the config came from the roster with the default "role-as-name" pattern,
  // OR the name is one of the synthetic defaults used by ad-hoc spawn paths,
  // upgrade to a memorable nickname before the coordinator sees it. This ensures
  // the manifest, fleet UI, and session logs all display human names like
  // "Einstein (Bug Hunter)" instead of "adhoc" or "general".
  const needsNickname =
    config.name === config.role ||
    !config.name ||
    config.name === 'subagent' ||
    config.name === 'adhoc';
  if (needsNickname) {
    const role = config.role ?? 'subagent';
    if (host.fleetManager) {
      // FleetManager owns the used-nicknames set — just assign the nickname.
      // recordSpawn is called after spawn regardless of needsNickname to ensure
      // the manifest is keyed by the real subagentId.
      host.fleetManager.assignNicknameAndRecord(config);
    } else {
      const { key, display } = assignNickname(role, host.usedNicknames);
      config.name = display;
      host.usedNicknames.add(key);
    }
  }
  const total = host.usage.snapshot().total;
  const budget = host.fleetManager?.budgetSnapshot?.();
  const maxFleetTokens = budget?.maxTokens ?? host.maxFleetTokens ?? Number.POSITIVE_INFINITY;
  const maxFleetCostUsd = budget?.maxCostUsd ?? host.maxFleetCostUsd;
  const remainingTokens =
    budget?.remainingTokens ??
    Math.max(0, maxFleetTokens - ((total?.input ?? 0) + (total?.output ?? 0)));
  const remainingCostUsd =
    budget?.remainingCostUsd ?? Math.max(0, maxFleetCostUsd - (total?.cost ?? 0));
  config.spawnLineage = {
    parentDirectorId: host.id,
    spawnDepth: host.spawnDepth + 1,
    maxSpawnDepth: resolveMaxSpawnDepth(host.maxSpawnDepth),
    fleetBudget: {
      ...(Number.isFinite(budget?.maxSpawns ?? host.maxSpawns)
        ? { maxSpawns: budget?.maxSpawns ?? host.maxSpawns }
        : {}),
      ...(Number.isFinite(budget?.remainingSpawns ?? host.maxSpawns - host.spawnCount)
        ? {
            remainingSpawns: Math.max(
              0,
              // Exempt spawns don't consume leader budget, so the reported
              // headroom is not decremented for them.
              (budget?.remainingSpawns ?? host.maxSpawns - host.spawnCount) -
                (config.spawnBudgetExempt ? 0 : 1),
            ),
          }
        : {}),
      ...(Number.isFinite(maxFleetTokens) ? { maxTokens: maxFleetTokens } : {}),
      ...(Number.isFinite(remainingTokens) ? { remainingTokens } : {}),
      ...(Number.isFinite(maxFleetCostUsd) ? { maxCostUsd: maxFleetCostUsd } : {}),
      ...(Number.isFinite(remainingCostUsd) ? { remainingCostUsd } : {}),
    },
  };
  const result = await host.coordinator.spawn(config);
  // Record with FleetManager when available; otherwise manage inline.
  if (host.fleetManager) {
    // Always record the spawn with the real subagentId so the manifest is keyed correctly.
    host.fleetManager.recordSpawn(result.subagentId, config, priceLookup);
  } else {
    // Budget-exempt spawns (Chimera reviewers, cascade agents) do not consume
    // the leader's lifetime spawn budget.
    if (!config.spawnBudgetExempt) {
      host.spawnCount += 1;
    }
    host.subagentMeta.set(result.subagentId, {
      provider: config.provider,
      model: config.model,
    });
    if (priceLookup && config.provider && config.model) {
      host.priceLookups.set(`${config.provider}/${config.model}`, priceLookup);
    }
  }
  // Auto-wire a bridge per spawn — same transport as the director, so
  // `director.ask(subagentId, …)` and the subagent's own `bridge.send()`
  // round-trip without the caller having to plumb anything. Runners
  // grab their bridge from `ctx.bridge` (already populated by the
  // coordinator from `subagent.context.parentBridge`).
  const subagentBridge = new InMemoryAgentBridge(
    { agentId: result.subagentId, coordinatorId: host.id },
    host.transport,
  );
  host.coordinator.setSubagentBridge(result.subagentId, subagentBridge);
  host.subagentBridges.set(result.subagentId, subagentBridge);
  // Emit subagent.spawned on the FleetBus so the TUI can track collab agents
  // (which bypass MultiAgentHost.spawn and go through director.spawn directly).
  // The session that owns THIS worker, not "which session is the host on".
  // The coordinator captured it at spawn from the caller's `originSessionId`,
  // so a worker delegated from a background tab is announced to that tab
  // rather than to whichever conversation the host booted with.
  const currentSessionId =
    typeof (host.coordinator as unknown as { sessionOf?: (id: string) => string | undefined })
      .sessionOf === 'function'
      ? (host.coordinator as unknown as { sessionOf: (id: string) => string | undefined }).sessionOf(
          result.subagentId,
        )
      : undefined;
  host.fleet.emit({
    subagentId: result.subagentId,
    ts: Date.now(),
    type: 'subagent.spawned',
    payload: {
      ...(currentSessionId ? { sessionId: currentSessionId } : {}),
      subagentId: result.subagentId,
      taskId: '', // taskId will be set when assign() is called
      name: config.name,
      role: config.role,
      provider: config.provider,
      model: config.model,
    },
  });
  // Record manifest entry only when not using FleetManager (it manages its own).
  if (!host.fleetManager) {
    host.manifestEntries.set(result.subagentId, {
      subagentId: result.subagentId,
      name: config.name,
      role: config.role,
      provider: config.provider,
      model: config.model,
      taskIds: [],
    });
    const spawnedAt = new Date().toISOString();
    host.stateCheckpoint?.recordSpawn(
      {
        id: result.subagentId,
        name: config.name,
        role: config.role,
        provider: config.provider,
        model: config.model,
        spawnedAt,
      },
      host.spawnCount,
    );
    void host.appendSessionEvent({
      type: 'agent_spawned',
      ts: spawnedAt,
      agentId: result.subagentId,
      role: config.role ?? config.name,
    });
    host.scheduleManifest();
  }
  return result.subagentId;
}
