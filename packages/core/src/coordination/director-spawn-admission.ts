import type { SubagentConfig } from '@wrongstack/contracts/types/multi-agent';
import { setSandboxAgentOverride } from '../sandbox/agent-overrides.js';
import { lockSessionSubagentPolicyForSession } from '../security/session-subagent-policy.js';
import { FleetSpawnBudgetError } from './director/director-errors.js';
import { isExternalAgentSpawn, isHumanPinnedSpawn } from './director-spawn-model.js';
import { type DirectorFleetHost, spawn as fleetSpawn } from './fleet-spawn.js';
import { claimSubagentSlot, type SubagentSlotClaim } from './session-subagent-models.js';

interface DirectorSpawnAdmissionHost {
  readonly workCompleteFlag: boolean;
  readonly maxSpawns: number;
  readonly spawnCount: number;
  hasExplicitMatrixRoute(role: string | undefined): boolean;
  resolveSpawnModel(config: SubagentConfig, slot?: SubagentSlotClaim): void;
  readonly subagentIdleTimeoutMs: number | undefined;
  readonly subagentIdleDelayMs: Map<string, number | undefined>;
  armSubagentIdleRetirement(id: string, delay: number | undefined): void;
}

export async function admitDirectorSpawn(
  fleetHost: DirectorFleetHost,
  host: DirectorSpawnAdmissionHost,
  callerConfig: SubagentConfig,
  policySessionId: string | undefined,
  priceLookup?: {
    input?: number | undefined;
    output?: number | undefined;
    cacheRead?: number | undefined;
    cacheWrite?: number | undefined;
  },
  opts?: { companion?: boolean | undefined },
): Promise<string> {
  lockSessionSubagentPolicyForSession(policySessionId);
  if (host.workCompleteFlag) {
    throw new FleetSpawnBudgetError(
      'max_spawns',
      host.maxSpawns,
      host.spawnCount + 1,
      'workComplete() has been called — director closed further spawning',
    );
  }
  const config: SubagentConfig = {
    ...callerConfig,
    ...(opts?.companion ? { spawnBudgetExempt: true } : {}),
  };
  // Session-scoped model plan: take a lane BEFORE resolution so the lane's
  // target participates in it, and hand the lane to the spawned subagent so
  // `remove()` can give it back. A spawn that never happens (budget caps,
  // coordinator refusal) must not strand the lane as permanently busy.
  // An external ACP agent runs its own model, so it never holds a model lane.
  // Resident companions also step aside from numbered worker lanes and
  // follow-session overrides so they never occupy a user's worker lane or lose
  // their own tier (e.g. skill-companion's `tier: 'budget'`), while still
  // honoring an explicit session role override in `plan.roles[role]`.
  const slotClaim =
    isHumanPinnedSpawn(config) || isExternalAgentSpawn(config)
      ? undefined
      : claimSubagentSlot(policySessionId, {
          role: config.role,
          // `/setmodel` routing keeps its spawns: a role (or phase) the user
          // deliberately routed is not a "plain" spawn, so lanes and the
          // follow-session switch step aside for it. A session role override
          // still wins — that one names this role AND this session.
          routed: Boolean(opts?.companion) || host.hasExplicitMatrixRoute(config.role),
        });
  host.resolveSpawnModel(config, slotClaim);
  let subagentId: string;
  try {
    subagentId = await fleetSpawn(fleetHost, config, priceLookup);
  } catch (err) {
    slotClaim?.abandon();
    throw err;
  }
  slotClaim?.bind(subagentId);
  // Plan 28 T7 — a per-spawn sandbox override takes effect for THIS subagent
  // (ctx.agentId-keyed) and is dropped by Director.remove().
  if (config.sandbox) setSandboxAgentOverride(subagentId, config.sandbox);
  // Per-subagent idle timeout override: if the caller supplied an
  // `idleTimeoutMs` in the SubagentConfig (e.g. via `spawn_subagent`'s
  // inputSchema), honor it. Otherwise fall back to the Director-wide
  // `subagentIdleTimeoutMs`. This lets callers keep spawned slots alive
  // across the gap between `spawn_subagent` and `assign_task` when the
  // leader's reasoning time exceeds the default.
  const perSubagentIdleMs =
    typeof config.idleTimeoutMs === 'number' &&
    Number.isFinite(config.idleTimeoutMs) &&
    config.idleTimeoutMs >= 0
      ? config.idleTimeoutMs
      : host.subagentIdleTimeoutMs;
  host.subagentIdleDelayMs.set(subagentId, perSubagentIdleMs);
  host.armSubagentIdleRetirement(subagentId, perSubagentIdleMs);
  return subagentId;
}
