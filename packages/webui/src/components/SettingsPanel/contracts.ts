/**
 * Leaf contract types for the @wrongstack/webui SettingsPanel surface.
 *
 * Lives separately from `MCPSection.tsx` so callers (e.g. `official-servers.ts`
 * which converts an `OfficialServer` entry into an `MCPServerConfig`) can
 * depend on the wire-level shape without pulling in the 904-line MCPSection
 * component implementation. Resolved the type-level SCC ARCH-CYCLE-TYPE-23
 * (now superseded — no matching cycle in architecture/hotspots.json as of
 * 2026-08-22; see .reports/card4c-health.txt "exception no longer matches
 * an active cycle"). The contract moved here so future maintainers do not
 * re-introduce the cycle by inlining the type back into MCPSection.
 *
 * This module MUST contain no runtime imports.
 */

/**
 * Configuration shape for a user-defined MCP server entry.
 * Mirrors the persisted JSON shape consumed by the runtime registry.
 */
export interface MCPServerConfig {
  name: string;
  transport: string;
  description?: string;
  enabled?: boolean;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  allowedTools?: string[];
  url?: string;
  lazy?: boolean;
}
