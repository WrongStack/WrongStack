import { getResolvedSandboxConfig } from './manager.js';
import { resolveSandboxConfig, type SandboxConfig } from './types.js';

/**
 * Plan 28 T7 — per-agent sandbox overrides, keyed by the subagent id a
 * spawned worker carries as `ctx.agentId`. AC5: a subagent spawned without
 * an override runs the leader's (process-global) tier; with an override it
 * runs its own. Overrides are advisory policy signal — hard containment
 * still requires a routing backend (T4).
 */
const overrides = new Map<string, Partial<SandboxConfig>>();

function normalizeAgentId(agentId: string | undefined): string {
  return typeof agentId === 'string' ? agentId.trim() : '';
}

export function setSandboxAgentOverride(
  agentId: string,
  override: Partial<SandboxConfig> | undefined,
): void {
  const key = normalizeAgentId(agentId);
  if (!key) return;
  if (override) overrides.set(key, override);
  else overrides.delete(key);
}

export function getSandboxAgentOverride(
  agentId: string | undefined,
): Partial<SandboxConfig> | undefined {
  const key = normalizeAgentId(agentId);
  return key ? overrides.get(key) : undefined;
}

/** T7 janitor: drop the override when its subagent is removed/retired. */
export function forgetSandboxAgentOverride(agentId: string | undefined): void {
  const key = normalizeAgentId(agentId);
  if (key) overrides.delete(key);
}

/** Test/host seam: drop every override (e.g. between suites). */
export function clearSandboxAgentOverrides(): void {
  overrides.clear();
}

/**
 * Per-agent resolution (AC5): the agent's override (if any) merges over the
 * process-global policy — unspecified fields inherit the leader's tier.
 */
export function resolveSandboxConfigForAgent(agentId: string | undefined): SandboxConfig {
  const override = getSandboxAgentOverride(agentId);
  if (!override) return getResolvedSandboxConfig();
  // Route the merge through resolveSandboxConfig so a malformed override
  // (bad tier/mode literal) cannot slip past enum validation.
  return resolveSandboxConfig({ ...getResolvedSandboxConfig(), ...override });
}

/** Compact tier label for status surfaces (override wins, else the global tier). */
export function sandboxTierForAgent(agentId: string | undefined): string {
  return resolveSandboxConfigForAgent(agentId).tier;
}
