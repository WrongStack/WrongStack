import { create } from 'zustand';

export type TechStackCoverage = 'full' | 'partial' | 'unsupported';
export type TechStackJobKind = 'inventory' | 'analyze';
export type TechStackJobStatus =
  | 'idle'
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
 * Pipeline depth the user picked for the next `analyze` run.
 * Mirrors `AnalyzeDepth` on the engine; defaults to `'full'` for parity with
 * the pre-feature one-click Analyze button.
 */
export type TechStackAnalyzeDepth = 'inventory' | 'enrich' | 'full';

export interface TechStackEvidence {
  readonly kind: string;
  readonly source: string;
  readonly retrievedAt: string;
  readonly detail?: string | undefined;
}

export interface TechStackWorkspace {
  readonly id: string;
  readonly relativeRoot: string;
  readonly ecosystem: string;
  readonly packageManager?: string | undefined;
  readonly manifests: readonly string[];
  readonly lockfiles: readonly string[];
  readonly confidence: number;
  readonly coverage: TechStackCoverage;
}

export interface TechStackDependency {
  readonly id: string;
  readonly workspaceId: string;
  readonly purl?: string | undefined;
  readonly ecosystem: string;
  readonly name: string;
  readonly sourceType: string;
  readonly direct: boolean;
  readonly scope: string;
  readonly requested?: string | undefined;
  readonly locked?: string | undefined;
  readonly installed?: string | undefined;
  readonly wanted?: string | undefined;
  readonly resolvable?: string | undefined;
  readonly latestStable?: string | undefined;
  readonly license?: string | undefined;
  readonly deprecated?: boolean | undefined;
  readonly yanked?: boolean | undefined;
  readonly status: string;
  readonly evidence: readonly TechStackEvidence[];
}

export type TechStackFindingType =
  | 'upgrade'
  | 'vulnerability'
  | 'deprecated'
  | 'license'
  | 'replacement'
  | 'unsupported'
  | 'investigate';

export type TechStackFindingSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';

export type TechStackFindingAction =
  | 'none'
  | 'upgrade_patch'
  | 'upgrade_minor'
  | 'upgrade_major'
  | 'replace'
  | 'remove'
  | 'investigate';

/**
 * Mirrors `Finding` in `packages/techstack/src/types.ts`.
 *
 * Duplicated rather than imported: `@wrongstack/techstack` reaches for
 * `node:crypto` and SQLite, so it cannot cross into the browser bundle.
 *
 * `confidence` is the fact/interpretation divide — deterministic findings from
 * the registry and OSV are `1.0`; anything the LLM research stage produced is
 * strictly below it and carries its sources in `evidence`.
 */
export interface TechStackFinding {
  readonly id: string;
  readonly dependencyId: string;
  readonly type: TechStackFindingType;
  readonly severity: TechStackFindingSeverity;
  readonly action: TechStackFindingAction;
  readonly confidence: number;
  readonly rationale: string;
  readonly breakingRisk?: string | undefined;
  readonly evidence: readonly TechStackEvidence[];
}

/**
 * One item in a remediation upgrade plan.
 *
 * Mirrors `UpgradePlanItem` server-side (`packages/techstack/src/remediation.ts`).
 * `executable` is true when the engine can drive the change through the
 * permission-gated `language_package` tool — false for ecosystems that need
 * a manual command (ruby, dart, maven, gradle, swift, elixir, c/cpp). The UI
 * uses this to render an "Apply" button vs. a "Copy command" card.
 */
export interface TechStackUpgradePlanItem {
  readonly dependencyName: string;
  readonly ecosystem: string;
  readonly workspaceId: string;
  readonly currentVersion?: string | undefined;
  readonly targetVersion?: string | undefined;
  readonly action: TechStackFindingAction;
  readonly severity: TechStackFindingSeverity;
  readonly rationale: string;
  readonly breakingRisk?: string | undefined;
  readonly suggestedCommand?: string | undefined;
  readonly executable: boolean;
}

export interface TechStackUpgradePlan {
  readonly snapshotId: string;
  readonly generatedAt: string;
  readonly warning: string;
  readonly summary: {
    readonly total: number;
    readonly patch: number;
    readonly minor: number;
    readonly major: number;
    readonly replace: number;
    readonly remove: number;
    readonly investigate: number;
  };
  readonly items: readonly TechStackUpgradePlanItem[];
}

export interface TechStackApplyPlanResult {
  readonly dryRun: boolean;
  readonly items: ReadonlyArray<{
    readonly dependencyName: string;
    readonly status: 'planned' | 'skipped' | 'applied' | 'failed';
    readonly detail?: string | undefined;
  }>;
}

/**
 * Single point on the cross-snapshot trend curve.
 *
 * Server-side: `TrendReport` in `packages/techstack/src/trend.ts`. The full
 * report is heavier than what the page needs day-to-day, so the WebUI view
 * uses the lightweight shape surfaced by `GET /api/techstack/trends`.
 */
export interface TechStackTrendPoint {
  readonly snapshotId: string;
  readonly createdAt: string;
  readonly dependencies: number;
  readonly outdated: number;
  readonly vulnerable: number;
}

export interface TechStackTrendReport {
  readonly snapshots: number;
  readonly vulnerabilityHalfLifeMs?: number | undefined;
  readonly points: readonly TechStackTrendPoint[];
  readonly dependencies: ReadonlyArray<{
    readonly key: string;
    readonly name: string;
    readonly ecosystem: string;
    readonly currentVersion?: string | undefined;
    readonly lockedVersionAgeMs: number;
    readonly versionChanges: number;
  }>;
}

/**
 * Lightweight description of the LLM available for AI-assisted runs.
 * Mirrors the `GET /api/techstack/models` response. When `available` is false
 * the model picker is disabled — there is no point letting the user pick a
 * model when none can answer.
 */
export interface TechStackModelInfo {
  readonly available: boolean;
  readonly provider: string | null;
  readonly model: string | null;
  readonly candidates: ReadonlyArray<{ readonly id: string }>;
  readonly capabilities: { readonly structuredOutput: boolean; readonly jsonMode: boolean };
}

export interface TechStackSnapshot {
  readonly id: string;
  readonly projectId: string;
  readonly targetRoot: string;
  readonly fingerprint: string;
  readonly createdAt: string;
  readonly workspaces: readonly TechStackWorkspace[];
  readonly dependencies: readonly TechStackDependency[];
  readonly findings: readonly TechStackFinding[];
  readonly coverage: TechStackCoverage;
  readonly adapterVersion: string;
}

export interface TechStackProgress {
  readonly phase: string;
  readonly completed: number;
  readonly total: number;
}

export interface TechStackJobView {
  readonly id: string;
  readonly kind: TechStackJobKind;
  readonly status: TechStackJobStatus;
  readonly progress: TechStackProgress | null;
  readonly error: string | null;
  /** Pipeline depth the job will run / is running. */
  readonly depth?: TechStackAnalyzeDepth;
  /** Model id the user picked for the LLM research stage. */
  readonly model?: string;
}

interface TechStackState {
  snapshot: TechStackSnapshot | null;
  stale: boolean;
  loading: boolean;
  error: string | null;
  activeJob: TechStackJobView | null;
  lastWorkspaceId: string | null;
  reportId: string | null;
  /** Next analyze options. Persisted in-memory so a refresh keeps them. */
  selectedDepth: TechStackAnalyzeDepth;
  selectedModel: string | null;
  /** `null` until the user opens the TechStack page (the page lazy-loads the list). */
  availableModels: TechStackModelInfo | null;
  /** Plan from `GET /api/techstack/remediation`. `null` when not yet fetched. */
  remediationPlan: TechStackUpgradePlan | null;
  remediationPreview: TechStackApplyPlanResult | null;
  remediationLoading: boolean;
  remediationError: string | null;
  /** Cross-snapshot trend report. `null` when not yet fetched. */
  trend: TechStackTrendReport | null;
  trendLoading: boolean;
  trendError: string | null;
  /** Streaming deep-dive partials, keyed by dependency id. */
  deepDivePartial: { dependencyId: string; status: 'researching'; completed: number; total: number } | null;
  setSnapshot: (snapshot: TechStackSnapshot | null, stale?: boolean) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  jobStarted: (
    jobId: string,
    kind: TechStackJobKind,
    options?: { depth?: TechStackAnalyzeDepth; model?: string },
  ) => void;
  jobProgress: (jobId: string, progress: TechStackProgress) => void;
  jobFailed: (jobId: string, error: string) => void;
  jobCancelled: (jobId: string) => void;
  workspaceCompleted: (workspaceId: string) => void;
  reportReady: (reportId: string) => void;
  setSelectedDepth: (depth: TechStackAnalyzeDepth) => void;
  setSelectedModel: (model: string | null) => void;
  setAvailableModels: (models: TechStackModelInfo) => void;
  setRemediation: (plan: TechStackUpgradePlan, preview: TechStackApplyPlanResult) => void;
  setRemediationLoading: (loading: boolean) => void;
  setRemediationError: (error: string | null) => void;
  setTrend: (trend: TechStackTrendReport) => void;
  setTrendLoading: (loading: boolean) => void;
  setTrendError: (error: string | null) => void;
  setDeepDivePartial: (
    partial:
      | { dependencyId: string; status: 'researching'; completed: number; total: number }
      | null,
  ) => void;
  clear: () => void;
}

const JOB_STATUSES = new Set<TechStackJobStatus>([
  'idle',
  'queued',
  'discovering',
  'inventorying',
  'enriching',
  'researching',
  'synthesizing',
  'completed',
  'failed',
  'cancelled',
]);

function jobStatusForPhase(phase: string): TechStackJobStatus | undefined {
  return JOB_STATUSES.has(phase as TechStackJobStatus) ? (phase as TechStackJobStatus) : undefined;
}

const INITIAL = {
  snapshot: null,
  stale: false,
  loading: false,
  error: null,
  activeJob: null,
  lastWorkspaceId: null,
  reportId: null,
  selectedDepth: 'full' as TechStackAnalyzeDepth,
  selectedModel: null,
  availableModels: null,
  remediationPlan: null,
  remediationPreview: null,
  remediationLoading: false,
  remediationError: null,
  trend: null,
  trendLoading: false,
  trendError: null,
  deepDivePartial: null,
} satisfies Pick<
  TechStackState,
  | 'snapshot'
  | 'stale'
  | 'loading'
  | 'error'
  | 'activeJob'
  | 'lastWorkspaceId'
  | 'reportId'
  | 'selectedDepth'
  | 'selectedModel'
  | 'availableModels'
  | 'remediationPlan'
  | 'remediationPreview'
  | 'remediationLoading'
  | 'remediationError'
  | 'trend'
  | 'trendLoading'
  | 'trendError'
  | 'deepDivePartial'
>;

export const useTechStackStore = create<TechStackState>()((set) => ({
  ...INITIAL,
  setSnapshot: (snapshot, stale = false) =>
    set((state) => ({
      snapshot,
      stale,
      loading: false,
      error: null,
      activeJob: state.activeJob ? { ...state.activeJob, status: 'completed', error: null } : null,
      deepDivePartial: null,
    })),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error, loading: false }),
  jobStarted: (jobId, kind, options) =>
    set({
      activeJob: {
        id: jobId,
        kind,
        status: 'queued',
        progress: null,
        error: null,
        ...(options?.depth ? { depth: options.depth } : {}),
        ...(options?.model ? { model: options.model } : {}),
      },
      error: null,
      loading: true,
    }),
  jobProgress: (jobId, progress) =>
    set((state) => {
      if (state.activeJob?.id !== jobId) return state;
      const status = jobStatusForPhase(progress.phase);
      if (!status) return state;
      return {
        activeJob: { ...state.activeJob, status, progress },
        loading: true,
      };
    }),
  jobFailed: (jobId, error) =>
    set((state) => {
      if (state.activeJob?.id !== jobId) return state;
      return {
        activeJob: { ...state.activeJob, status: 'failed', error },
        error,
        loading: false,
      };
    }),
  jobCancelled: (jobId) =>
    set((state) => ({
      activeJob:
        state.activeJob?.id === jobId
          ? { ...state.activeJob, status: 'cancelled', error: null }
          : state.activeJob,
      loading: false,
    })),
  workspaceCompleted: (workspaceId) => set({ lastWorkspaceId: workspaceId }),
  reportReady: (reportId) => set({ reportId }),
  setSelectedDepth: (depth) => set({ selectedDepth: depth }),
  setSelectedModel: (model) => set({ selectedModel: model }),
  setAvailableModels: (models) => set({ availableModels: models }),
  setRemediation: (plan, preview) =>
    set({ remediationPlan: plan, remediationPreview: preview, remediationLoading: false, remediationError: null }),
  setRemediationLoading: (loading) =>
    set({ remediationLoading: loading, ...(loading ? { remediationError: null } : {}) }),
  setRemediationError: (error) => set({ remediationError: error, remediationLoading: false }),
  setTrend: (trend) => set({ trend, trendLoading: false, trendError: null }),
  setTrendLoading: (loading) =>
    set({ trendLoading: loading, ...(loading ? { trendError: null } : {}) }),
  setTrendError: (error) => set({ trendError: error, trendLoading: false }),
  setDeepDivePartial: (partial) => set({ deepDivePartial: partial }),
  clear: () => set(INITIAL),
}));
