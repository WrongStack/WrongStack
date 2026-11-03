/**
 * Browser mirror of the SAGE Doctor contract in
 * `packages/sage/src/memory-doctor-types.ts` (the WebUI cannot import
 * `@wrongstack/sage`). The engine is the source of truth; fields stay
 * optional where an older daemon may omit them.
 */

export type SageDoctorSeverity = 'ok' | 'info' | 'warn' | 'error';

export type SageDoctorFixId =
  | 'hygiene'
  | 'graph-hubs'
  | 'dangling-edges'
  | 'audience-runtime-mode'
  | 'fts-rebuild';

export interface SageDoctorCheck {
  id: string;
  title: string;
  severity: SageDoctorSeverity;
  summary: string;
  count?: number | undefined;
  fix?: SageDoctorFixId | undefined;
  samples?: string[] | undefined;
}

export interface SageDoctorMetrics {
  total: number;
  active: number;
  byStatus: Record<string, number>;
  edges: number;
  pendingCandidates: number;
  injections: number;
  uses: number;
  /** uses / injections, 0 when nothing was injected. */
  precision: number;
  injectedNeverUsed: number;
  unanchoredActive: number;
  neverVerifiedActive: number;
  dbBytes?: number | undefined;
  walBytes?: number | undefined;
}

export interface SageMaintenanceStatus {
  owner: 'daemon' | 'inline';
  scheduled: boolean;
  intervalMs: number;
  running: boolean;
  lastRunAt?: string | undefined;
  lastDurationMs?: number | undefined;
  lastError?: string | undefined;
  nextRunAt?: string | undefined;
}

export interface SageDoctorFixResult {
  fix: SageDoctorFixId;
  changed: number;
  detail: string;
}

export interface SageDoctorReport {
  generatedAt: string;
  metrics: SageDoctorMetrics;
  checks: SageDoctorCheck[];
  maintenance?: SageMaintenanceStatus | undefined;
  fixesApplied?: SageDoctorFixResult[] | undefined;
}

export interface WSMemorySageDoctor {
  type: 'memory.sage.doctor';
  payload: {
    report?: SageDoctorReport | undefined;
    /** Echo of the request's `requestId`, when it carried one. */
    requestId?: string | undefined;
    error?: string | undefined;
  };
}
