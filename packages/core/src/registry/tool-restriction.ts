import type { Tool } from '@wrongstack/contracts/types/tool';

/** The lazy gateways a restricted provider surface depends on. */
export const LAZY_TOOL_GATEWAYS = new Set(['tool_search', 'tool_use']);

/** Exact tool name, or a prefix when the pattern ends with `*`. */
export function matchToolPattern(pattern: string, name: string): boolean {
  return pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : pattern === name;
}

/** A launch-time restriction as callers pass it (`--only-tools` / `--disallowed-tools`). */
export interface ToolRestrictionInput {
  only?: readonly string[] | undefined;
  deny?: readonly string[] | undefined;
  /** Hide any tool declaring one of these capabilities (`--restricted`). */
  denyCapabilities?: readonly string[] | undefined;
  /**
   * Hide tools that declare no capabilities at all unless core owns them:
   * an undeclared plugin tool could do anything, so it fails closed.
   */
  requireDeclaredCapabilities?: boolean | undefined;
}

/** A restriction with its lists copied and defaults filled in. */
export interface ToolRestriction {
  only?: readonly string[];
  deny: readonly string[];
  denyCapabilities: readonly string[];
  requireDeclaredCapabilities: boolean;
}

export function normalizeToolRestriction(restriction: ToolRestrictionInput): ToolRestriction {
  return {
    ...(restriction.only ? { only: [...restriction.only] } : {}),
    deny: [...(restriction.deny ?? [])],
    denyCapabilities: [...(restriction.denyCapabilities ?? [])],
    requireDeclaredCapabilities: restriction.requireDeclaredCapabilities === true,
  };
}

/** True when `r` hides `name`; `entry` is its current registration, if any. */
export function isRestrictedBy(
  r: ToolRestriction,
  name: string,
  entry: { tool: Tool; owner: string } | undefined,
): boolean {
  if (r.deny.some((pattern) => matchToolPattern(pattern, name))) return true;
  // The lazy gateways only reach tools that pass this same check, so the
  // capability rules below never apply to them (tool_use declares
  // `tool.mutate.any` precisely because it forwards).
  if (LAZY_TOOL_GATEWAYS.has(name)) return false;
  if (entry) {
    const caps = entry.tool.capabilities ?? [];
    if (caps.some((cap) => r.denyCapabilities.includes(cap))) return true;
    if (r.requireDeclaredCapabilities && caps.length === 0 && entry.owner !== 'core') return true;
  }
  if (!r.only) return false;
  return !r.only.some((pattern) => matchToolPattern(pattern, name));
}
