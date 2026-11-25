/**
 * Plain-text rendering of a {@link SageDoctorReport}, shared by
 * `wstack sage doctor` and `/memory doctor` so both surfaces say the same
 * thing in the same order.
 */
import type {
  SageDoctorCheck,
  SageDoctorFixId,
  SageDoctorReport,
  SageDoctorSeverity,
} from './memory-doctor-types.js';
import { SAGE_DOCTOR_FIX_IDS } from './memory-doctor-types.js';

const MARK: Record<SageDoctorSeverity, string> = {
  ok: 'ok   ',
  info: 'info ',
  warn: 'WARN ',
  error: 'ERROR',
};

function percent(value: number): string {
  if (!Number.isFinite(value)) return '0.0%';
  return `${(value * 100).toFixed(value < 0.01 ? 2 : 1)}%`;
}

function megabytes(bytes: number | undefined): string {
  return bytes === undefined || !Number.isFinite(bytes) || bytes < 0
    ? '?'
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Repairs the report suggests, in canonical order. */
export function suggestedDoctorFixes(report: SageDoctorReport): SageDoctorFixId[] {
  const wanted = new Set(
    report.checks
      .filter((check) => check.severity === 'warn' || check.severity === 'error')
      .map((check) => check.fix)
      .filter((fix): fix is SageDoctorFixId => fix !== undefined),
  );
  return SAGE_DOCTOR_FIX_IDS.filter((fix) => wanted.has(fix));
}

/** Parses `--fix` / `--fix=a,b`; `true` means "every suggested repair". */
export function parseDoctorFixArg(
  value: string | true | undefined,
): SageDoctorFixId[] | 'suggested' | undefined {
  if (value === undefined) return undefined;
  if (value === true || value.trim() === '' || value.trim() === 'all') return 'suggested';
  const ids = value.split(',').map((part) => part.trim());
  const unknown = ids.filter((id) => !SAGE_DOCTOR_FIX_IDS.includes(id as SageDoctorFixId));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown doctor fix: ${unknown.join(', ')}. Known: ${SAGE_DOCTOR_FIX_IDS.join(', ')}`,
    );
  }
  return ids as SageDoctorFixId[];
}

function checkLine(check: SageDoctorCheck): string[] {
  const lines = [`  ${MARK[check.severity]} ${check.summary}`];
  if (check.samples?.length && check.severity !== 'ok') {
    lines.push(`         e.g. ${check.samples.join(', ')}`);
  }
  if (check.fix && (check.severity === 'warn' || check.severity === 'error')) {
    lines.push(`         fix: --fix=${check.fix}`);
  }
  return lines;
}

export function formatSageDoctorReport(report: SageDoctorReport): string {
  const m = report.metrics;
  const lines: string[] = ['SAGE doctor', ''];
  if (report.fixesApplied?.length) {
    lines.push('Repairs applied:');
    for (const fix of report.fixesApplied) lines.push(`  ${fix.fix}: ${fix.detail}`);
    lines.push('');
  }
  lines.push(
    'Store:',
    `  ${m.active} active / ${m.total} total memories, ${m.edges} edges, ${m.pendingCandidates} pending review`,
    `  database ${megabytes(m.dbBytes)}, WAL ${megabytes(m.walBytes)}`,
    '',
    'Injection quality:',
    `  ${m.injections} injections, ${m.uses} recorded uses — precision ${percent(m.precision)}`,
    `  ${m.injectedNeverUsed} memories injected 20+ times and never used`,
    `  ${m.unanchoredActive} active memories have no anchor (rarely injected); ${m.neverVerifiedActive} anchored ones never verified`,
    '',
  );
  if (report.maintenance) {
    const maint = report.maintenance;
    lines.push(
      'Maintenance:',
      `  owner ${maint.owner}${maint.scheduled ? ', scheduled' : ', not scheduled'}${maint.running ? ', running now' : ''}`,
      `  last run ${maint.lastRunAt ?? 'never'}${maint.nextRunAt ? `, next ${maint.nextRunAt}` : ''}`,
      '',
    );
  }
  lines.push('Checks:');
  const order: SageDoctorSeverity[] = ['error', 'warn', 'info', 'ok'];
  for (const severity of order) {
    for (const check of report.checks.filter((item) => item.severity === severity)) {
      lines.push(...checkLine(check));
    }
  }
  const fixes = suggestedDoctorFixes(report);
  if (fixes.length > 0) {
    lines.push('', `Run with --fix to apply: ${fixes.join(', ')} (no memory is hard-deleted).`);
  }
  return lines.join('\n');
}
