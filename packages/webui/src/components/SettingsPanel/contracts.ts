/**
 * Leaf contract types for the @wrongstack/webui SettingsPanel surface.
 *
 * Lives separately from `MCPSection.tsx` so callers (e.g. `official-servers.ts`
 * which converts an `OfficialServer` entry into an `MCPServerConfig`) can
 * depend on the wire-level shape without pulling in the 904-line MCPSection
 * component implementation. Breaks the long-standing type-level SCC
 * ARCH-CYCLE-TYPE-23 where `MCPSection.tsx` both homed the shared config
 * type and was imported back by `official-servers.ts`.
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
