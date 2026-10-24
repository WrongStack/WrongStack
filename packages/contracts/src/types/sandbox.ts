/**
 * Sandbox tier config contract (plan 28 — docs/specs/sandboxed-execution-tiers-sdd.md).
 * The runtime side (defaults, resolution, backends) lives in `sandbox/types.ts`.
 */

/** Sandbox enforcement mode. `off` (the default) preserves current behavior exactly. */
export type SandboxMode = 'off' | 'enforced';

/** Containment level. T2 ships the contract; `container` / `windows-native` backends (T4/T5) enforce it. */
export type SandboxTier = 'read-only' | 'workspace-write' | 'full-access';

/** Backend selection. Only `policy-only` is implemented in T2 (never denies). */
export type SandboxBackendId = 'policy-only' | 'container' | 'windows-native';

export interface SandboxConfig {
  mode: SandboxMode;
  tier: SandboxTier;
  /** Additional paths (absolute or project-relative) writable in `workspace-write` tier. */
  writableRoots: string[];
  backend: SandboxBackendId;
  /** Container image for the `container` backend (T4). In-project-denied (RCE class). */
  image?: string | undefined;
}
