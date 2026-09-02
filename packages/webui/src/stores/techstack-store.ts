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
}

interface TechStackState {
  snapshot: TechStackSnapshot | null;
  stale: boolean;
  loading: boolean;
  error: string | null;
  activeJob: TechStackJobView | null;
  lastWorkspaceId: string | null;
  reportId: string | null;
  setSnapshot: (snapshot: TechStackSnapshot | null, stale?: boolean) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  jobStarted: (jobId: string, kind: TechStackJobKind) => void;
  jobProgress: (jobId: string, progress: TechStackProgress) => void;
  jobFailed: (jobId: string, error: string) => void;
  jobCancelled: (jobId: string) => void;
  workspaceCompleted: (workspaceId: string) => void;
  reportReady: (reportId: string) => void;
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
} satisfies Pick<
  TechStackState,
  'snapshot' | 'stale' | 'loading' | 'error' | 'activeJob' | 'lastWorkspaceId' | 'reportId'
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
    })),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error, loading: false }),
  jobStarted: (jobId, kind) =>
    set({
      activeJob: { id: jobId, kind, status: 'queued', progress: null, error: null },
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
  clear: () => set(INITIAL),
}));
