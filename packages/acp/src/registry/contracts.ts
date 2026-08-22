/**
 * Leaf contract types for the @wrongstack/acp public surface.
 *
 * Lives separately from `ensemble-registry.ts` so callers (catalog,
 * runtime registry fetcher, public re-exports) can depend on the
 * wire-level descriptor shape without pulling in the ensemble
 * implementation. Breaks the long-standing type-level SCC
 * ARCH-CYCLE-TYPE-02 where `ensemble-registry.ts` both homed the
 * shared descriptor and was imported back by `agents.catalog.ts`.
 *
 * This module MUST contain no runtime imports.
 */

/** Vendor classification — used to filter the catalog by family. */
export type ACPAgentVendor =
  | 'anthropic'
  | 'google'
  | 'openai'
  | 'github'
  | 'moonshot'
  | 'community';

/** How the agent is integrated into ACP. */
export type ACPIntegration =
  /** Agent ships with a documented ACP entry flag. */
  | 'native'
  /** Runs through Zed's SDK adapter or similar wrapper. */
  | 'adapter'
  /** Community-maintained wrapper (e.g. @agentify/cline, bub-acp-server). */
  | 'community'
  /** Listed by ACP but no public ACP entry yet; may not work. */
  | 'experimental';

/** Static metadata for a known agent. */
export interface ACPAgentDescriptor {
  /** Stable identifier used as the spawn key. Lowercase, hyphenated. */
  id: string;
  /** Display name shown in the TUI / WebUI / CLI. */
  displayName: string;
  vendor: ACPAgentVendor;
  /** argv to detect installation. Exits 0 with stdout on success. */
  probe: { command: string; args?: readonly string[] };
  /** argv to start the agent in ACP mode. */
  acp: { command: string; args?: readonly string[]; env?: Record<string, string> };
  /** Capability hints — used to fail fast when the binary predates ACP. */
  supports: {
    loadSession: boolean;
    promptImages: boolean;
    terminal: boolean;
    fs: boolean;
  };
  integration: ACPIntegration;
  /** Documentation URL — shown in `wstack acp list` and the ensemble UI. */
  docs: string;
}
