/**
 * TechStack — Ecosystem adapter interface.
 *
 * Every ecosystem (npm, Python, Rust, Go, etc.) implements this contract.
 * The inventory engine discovers workspaces via detectLanguageWorkspaces(),
 * then dispatches to the matching adapter for each workspace.
 *
 * @see docs/specs/techstack-sdd.md §3.2, §6
 */

import type { DependencyObservation, EcosystemId, Evidence, Workspace } from '../types.js';

/**
 * Options passed to inventory() controlling what data the adapter collects.
 */
export interface InventoryOptions {
  /**
   * Absolute path of the project being analyzed. `Workspace.relativeRoot` is
   * resolved against it.
   *
   * Without this, adapters resolve against `process.cwd()` and read nothing
   * whenever the server was started from anywhere but the project root.
   *
   * @see ./paths.ts
   */
  readonly projectRoot?: string | undefined;
  /** Include transitive dependencies from lockfiles, not just direct. */
  readonly includeTransitive?: boolean | undefined;
  /** Abort signal for cancellation. */
  readonly signal?: AbortSignal | undefined;
}

/**
 * Options passed to enrich() for online registry lookups.
 */
export interface EnrichOptions {
  /** Skip network calls; use only cached/offline data. */
  readonly offline?: boolean | undefined;
  /** Abort signal for cancellation. */
  readonly signal?: AbortSignal | undefined;
}

/**
 * Options passed to audit() for security advisory checks.
 */
export interface AuditOptions {
  /** Skip network calls; use only cached/offline data. */
  readonly offline?: boolean | undefined;
  /** Abort signal for cancellation. */
  readonly signal?: AbortSignal | undefined;
}

/**
 * Result of enriching a single dependency with registry metadata.
 */
export interface RegistryEvidence {
  readonly latestStable?: string | undefined;
  readonly license?: string | undefined;
  readonly deprecated?: boolean | undefined;
  readonly yanked?: boolean | undefined;
  readonly evidence: readonly Evidence[];
}

/**
 * Result of auditing a single dependency for vulnerabilities.
 */
export interface AdvisoryEvidence {
  readonly hasAdvisory: boolean;
  readonly severity: 'info' | 'low' | 'medium' | 'high' | 'critical' | undefined;
  readonly summary?: string | undefined;
  readonly url?: string | undefined;
  readonly evidence: readonly Evidence[];
}

/**
 * The contract every ecosystem adapter must implement.
 *
 * Adapters are pure data-extraction/enrichment modules. They never:
 * - Modify any files (analysis is read-only).
 * - Execute arbitrary project code (commands that do are permission-gated).
 * - Set version fields without evidence.
 * - Classify private/unresolved packages (404) as "dead" or "deprecated".
 */
export interface EcosystemAdapter {
  /** The ecosystem this adapter handles. */
  readonly ecosystem: EcosystemId;

  /**
   * Extract all dependencies from a workspace's manifests and lockfiles.
   *
   * This is the deterministic offline pass — no network calls.
   * Returns one DependencyObservation per package/version combination.
   * Each observation must carry at least one Evidence entry (manifest or lockfile).
   */
  inventory(
    workspace: Workspace,
    options: InventoryOptions,
  ): Promise<readonly DependencyObservation[]>;

  /**
   * Enrich dependencies with registry metadata (latest version, license, deprecation).
   *
   * May make network calls to package registries.
   * Must not fabricate version numbers — only return data backed by registry evidence.
   * Must handle 404/401 gracefully → status stays `private_or_unresolved`.
   */
  enrich?(
    dependencies: readonly DependencyObservation[],
    options: EnrichOptions,
  ): Promise<readonly RegistryEvidence[]>;

  /**
   * Check dependencies for known security advisories.
   *
   * Uses ecosystem-native audit commands and/or OSV batch queries.
   * Must not classify a package as vulnerable without advisory evidence.
   */
  audit?(
    dependencies: readonly DependencyObservation[],
    options: AuditOptions,
  ): Promise<readonly AdvisoryEvidence[]>;
}
