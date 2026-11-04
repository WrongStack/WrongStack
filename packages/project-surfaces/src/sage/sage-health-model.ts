/**
 * Pure ordering helpers for the SAGE Doctor tab, kept apart from the
 * component so they can be tested directly.
 */
import type {
  SageDoctorCheck,
  SageDoctorFixId,
  SageDoctorReport,
  SageDoctorSeverity,
} from './model-types';

const SEVERITY_ORDER: Record<SageDoctorSeverity, number> = { error: 0, warn: 1, info: 2, ok: 3 };

export function sortDoctorChecks(checks: readonly SageDoctorCheck[]): SageDoctorCheck[] {
  return [...checks].sort(
    (a, b) => (SEVERITY_ORDER[a.severity] ?? 4) - (SEVERITY_ORDER[b.severity] ?? 4),
  );
}

/** Engine order of `SAGE_DOCTOR_FIX_IDS` (hygiene first, FTS rebuild last). */
const FIX_ORDER: readonly SageDoctorFixId[] = [
  'hygiene',
  'graph-hubs',
  'dangling-edges',
  'audience-runtime-mode',
  'fts-rebuild',
];

/** The repairs `--fix` would apply: fixes of warn/error checks, in engine order. */
export function suggestedFixes(report: SageDoctorReport | null): SageDoctorFixId[] {
  const wanted = new Set<string>();
  for (const check of report?.checks ?? []) {
    if (check.fix && (check.severity === 'warn' || check.severity === 'error')) {
      wanted.add(check.fix);
    }
  }
  return FIX_ORDER.filter((fix) => wanted.has(fix));
}
