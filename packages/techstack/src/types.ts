/**
 * TechStack — Core domain types.
 *
 * These types define the entire data contract for the TechStack feature:
 * workspace discovery, dependency inventory, registry/advisory enrichment,
 * findings, snapshots, jobs, and the idle-delivery outbox.
 *
 * @see docs/specs/techstack-sdd.md §4.1
 */

// ── Ecosystem identifiers ────────────────────────────────────────────────

export type EcosystemId =
  | 'npm'
  | 'python'
  | 'rust'
  | 'go'
  | 'dotnet'
  | 'php'
  | 'dart'
  | 'maven'
  | 'gradle'
  | 'ruby'
  | 'swift'
  | 'elixir'
  | 'cpp';

export type SourceType = 'registry' | 'workspace' | 'path' | 'git' | 'system' | 'unknown';

export type DependencyScope =
  | 'runtime'
  | 'development'
  | 'peer'
  | 'build'
  | 'optional'
  | 'transitive';

export type DependencyStatus =
  | 'current'
  | 'update_available_safe'
  | 'update_available_breaking'
  | 'blocked_by_constraints'
  | 'vulnerable'
  | 'deprecated'
  | 'yanked'
  | 'unmaintained_suspected'
  | 'private_or_unresolved'
  | 'local_path'
  | 'git_dependency'
  | 'unsupported'
  | 'unknown';

export type Coverage = 'full' | 'partial' | 'unsupported';

// ── Evidence ────────────────────────────────────────────────────────────

export interface Evidence {
  /** What kind of source produced this evidence. */
  readonly kind: 'manifest' | 'lockfile' | 'registry' | 'audit' | 'osv' | 'agent' | 'command';
  /** URL, file path, or command that produced the evidence. */
  readonly source: string;
  /** ISO 8601 timestamp of when the evidence was retrieved. */
  readonly retrievedAt: string;
  /** Additional human-readable context. */
  readonly detail?: string | undefined;
}

// ── Workspace ───────────────────────────────────────────────────────────

export interface Workspace {
  readonly id: string;
  /** Path relative to the project root. */
  readonly relativeRoot: string;
  readonly ecosystem: EcosystemId;
  readonly packageManager?: string | undefined;
  readonly manifests: readonly string[];
  readonly lockfiles: readonly string[];
  /** Detection confidence 0..1. */
  readonly confidence: number;
  readonly coverage: Coverage;
}

// ── Dependency observation ──────────────────────────────────────────────

export interface DependencyObservation {
  readonly id: string;
  readonly workspaceId: string;
  /** Package URL (PURL) if resolvable; undefined for path/git/system deps. */
  readonly purl?: string | undefined;
  readonly ecosystem: EcosystemId;
  readonly name: string;
  readonly sourceType: SourceType;
  readonly direct: boolean;
  readonly scope: DependencyScope;
  /** Constraint from the manifest (e.g. "^4.18.0", ">=1.0 <2.0"). */
  readonly requested?: string | undefined;
  /** Exact version from the lockfile. */
  readonly locked?: string | undefined;
  /** Observed version from the environment (pip inspect, cargo metadata, etc.). */
  readonly installed?: string | undefined;
  /** Latest version within the current constraint (npm "wanted"). */
  readonly wanted?: string | undefined;
  /** Latest version considering all constraints (npm "resolvable"). */
  readonly resolvable?: string | undefined;
  /** Latest stable version from the registry. */
  readonly latestStable?: string | undefined;
  /** SPDX identifier or license name from the registry. */
  readonly license?: string | undefined;
  readonly deprecated?: boolean | undefined;
  readonly yanked?: boolean | undefined;
  readonly status: DependencyStatus;
  readonly evidence: readonly Evidence[];
}

// ── Finding ─────────────────────────────────────────────────────────────

export interface Finding {
  readonly id: string;
  readonly dependencyId: string;
  readonly type:
    | 'upgrade'
    | 'vulnerability'
    | 'deprecated'
    | 'license'
    | 'replacement'
    | 'unsupported'
    | 'investigate';
  readonly severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
  readonly action:
    | 'none'
    | 'upgrade_patch'
    | 'upgrade_minor'
    | 'upgrade_major'
    | 'replace'
    | 'remove'
    | 'investigate';
  /** Confidence 0..1 — deterministic findings are 1.0; agent-derived <1.0. */
  readonly confidence: number;
  readonly rationale: string;
  readonly breakingRisk?: string | undefined;
  readonly evidence: readonly Evidence[];
}

// ── Snapshot ────────────────────────────────────────────────────────────

export interface Snapshot {
  readonly id: string;
  readonly projectId: string;
  readonly targetRoot: string;
  /** Hash of manifest+lockfile contents + adapter version — used for dedup. */
  readonly fingerprint: string;
  readonly createdAt: string;
  readonly workspaces: readonly Workspace[];
  readonly dependencies: readonly DependencyObservation[];
  readonly findings: readonly Finding[];
  readonly coverage: Coverage;
  /** Version of the adapter set that produced this snapshot. */
  readonly adapterVersion: string;
}

// ── Job ─────────────────────────────────────────────────────────────────

export type TechStackJobKind = 'inventory' | 'analyze';

export type TechStackJobStatus =
  | 'queued'
  | 'discovering'
  | 'inventorying'
  | 'enriching'
  | 'researching'
  | 'synthesizing'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * Pipeline depth the run actually executed. Mirrors `AnalyzeDepth` on
 * `TechStackEngine.analyze()`. `inventory` is the offline dry run;
 * `enrich` adds registry/OSV; `full` runs the LLM researcher too.
 */
export type TechStackJobDepth = 'inventory' | 'enrich' | 'full';

export interface TechStackJobProgress {
  readonly phase: string;
  readonly completed: number;
  readonly total: number;
}

export interface TechStackJob {
  readonly id: string;
  readonly projectId: string;
  readonly targetRoot: string;
  readonly kind: TechStackJobKind;
  readonly status: TechStackJobStatus;
  readonly fingerprint: string;
  readonly requestedBy: string;
  readonly sessionId?: string | undefined;
  readonly createdAt: string;
  readonly completedAt?: string | undefined;
  readonly error?: string | undefined;
  readonly progress?: TechStackJobProgress | undefined;
  /** Pipeline depth the job ran. Defaults to `full` for legacy rows. */
  readonly depth?: TechStackJobDepth | undefined;
  /** Model id chosen by the user for the LLM researcher. Absent = no LLM. */
  readonly model?: string | undefined;
}

// ── Delivery outbox ─────────────────────────────────────────────────────

export type DeliveryStatus = 'pending' | 'claimed' | 'delivered' | 'failed';

export interface DeliveryOutbox {
  readonly deliveryId: string;
  readonly reportId: string;
  readonly sessionId: string;
  readonly status: DeliveryStatus;
  readonly attempts: number;
  readonly claimedAt?: string | undefined;
  readonly deliveredAt?: string | undefined;
}
