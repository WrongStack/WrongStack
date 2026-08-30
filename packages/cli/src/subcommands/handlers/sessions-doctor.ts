/**
 * `wstack sessions doctor` — diagnose the project's session corpus.
 *
 * Report mode writes nothing. `--fix` rebuilds only DERIVED artifacts: the
 * `.summary.json` sidecars and the catalog index. Journals are never edited;
 * see `core/storage/session-doctor.ts` for why reclaiming their snapshot bytes
 * is a retention decision rather than a repair.
 */
import {
  diagnoseSessions,
  repairSessionSummaries,
  type SessionDiagnosis,
  type SessionDoctorReport,
} from '@wrongstack/core/storage';
import { color, toErrorMessage } from '@wrongstack/core/utils';
import type { SubcommandDeps, SubcommandHandler } from '../contracts.js';

const ICON = { error: color.red('✗'), warn: color.amber('!'), info: color.dim('·') } as const;

function fmtBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`;
  return `${bytes} B`;
}

/** Sessions worth printing individually: anything the user could act on. */
function notable(session: SessionDiagnosis): boolean {
  return session.findings.some((f) => f.severity !== 'info');
}

function renderReport(report: SessionDoctorReport, limit: number): string[] {
  const lines: string[] = [
    color.bold('Session doctor'),
    `  scanned:   ${report.totals.sessions} session(s) in ${report.sessionsDir}`,
    `  on disk:   ${fmtBytes(report.totals.bytes)}`,
  ];
  if (report.totals.snapshotBytes > 0) {
    const share = Math.round(
      (report.totals.snapshotBytes / Math.max(1, report.totals.bytes)) * 100,
    );
    lines.push(
      `  snapshots: ${fmtBytes(report.totals.snapshotBytes)} (${share}%) — superseded conversation` +
        ` snapshots, reclaimed by pruning old sessions, never by rewriting them`,
    );
  }
  if (report.unreadable.length > 0) {
    lines.push('', color.red(`Unreadable journals (${report.unreadable.length}):`));
    for (const entry of report.unreadable.slice(0, limit)) {
      lines.push(`  ${ICON.error} ${color.cyan(entry.id)} — ${entry.reason}`);
    }
  }

  const counts = Object.entries(report.byCode).sort((a, b) => b[1] - a[1]);
  if (counts.length > 0) {
    lines.push('', color.bold('Findings'));
    for (const [code, count] of counts) lines.push(`  ${count.toString().padStart(5)}  ${code}`);
  }

  const interesting = report.sessions.filter(notable);
  if (interesting.length > 0) {
    lines.push('', color.bold(`Sessions needing attention (${interesting.length})`));
    for (const session of interesting.slice(0, limit)) {
      lines.push(`  ${color.cyan(session.id)}  ${color.dim(fmtBytes(session.bytes))}`);
      for (const finding of session.findings) {
        if (finding.severity === 'info') continue;
        const fix = finding.fix ? color.dim(` → fixable: ${finding.fix}`) : '';
        lines.push(`    ${ICON[finding.severity]} ${finding.detail}${fix}`);
      }
    }
    if (interesting.length > limit) {
      lines.push(color.dim(`  … ${interesting.length - limit} more (raise --limit to see them)`));
    }
  } else {
    lines.push('', color.green('No session needs attention.'));
  }
  return lines;
}

export const sessionsDoctorCmd: SubcommandHandler = async (args, deps: SubcommandDeps) => {
  const store = deps.sessionStore;
  const sessionsDir = deps.paths.projectSessions;
  const fix = args.includes('--fix') || deps.flags?.fix === true;
  const asJson = args.includes('--json') || deps.flags?.json === true;
  // The top-level parser strips value flags into `deps.flags` before the
  // dispatcher sees them, so `--limit 6` never reaches `args` in normal use.
  // `args` is still checked so the handler stays callable directly (tests).
  const rawLimit =
    deps.flags?.limit ?? (args.includes('--limit') ? args[args.indexOf('--limit') + 1] : undefined);
  const parsedLimit = Number(rawLimit);
  const limit = Number.isInteger(parsedLimit) && parsedLimit > 0 ? parsedLimit : 20;

  // A 20 GB corpus takes minutes. Without a live line the command looks hung,
  // and the natural reaction to that is Ctrl+C mid-scan.
  let lastTick = 0;
  const report = await diagnoseSessions({
    sessionsDir,
    onProgress: ({ scanned, total, id }) => {
      if (asJson || !id) return;
      const now = Date.now();
      if (now - lastTick < 250) return;
      lastTick = now;
      deps.renderer.write(`\r  scanning ${scanned}/${total} … ${id.slice(0, 48)}[K`);
    },
  }).catch((error: unknown) => {
    deps.renderer.writeError(`Session scan failed: ${toErrorMessage(error)}\n`);
    return null;
  });
  if (!report) return 1;
  if (!asJson) deps.renderer.write('\r[K');

  if (!fix) {
    if (asJson) {
      deps.renderer.write(`${JSON.stringify(report, null, 2)}\n`);
      return 0;
    }
    const lines = renderReport(report, limit);
    const fixable = report.sessions.filter((s) => s.findings.some((f) => f.fix)).length;
    if (fixable > 0) {
      lines.push(
        '',
        color.dim(`Run \`wstack sessions doctor --fix\` to repair ${fixable} of them.`),
      );
    }
    deps.renderer.write(`${lines.join('\n')}\n`);
    return 0;
  }

  // ── Repair: derived artifacts only ──────────────────────────────────────
  const repair = await repairSessionSummaries({
    report,
    onProgress: ({ repaired, total, id }) => {
      if (asJson || !id) return;
      deps.renderer.write(`\r  rebuilding summaries ${repaired}/${total} … ${id.slice(0, 48)}[K`);
    },
  });
  if (!asJson) deps.renderer.write('\r[K');

  // The catalog is the picker's source of truth and is itself derived from the
  // summaries just rebuilt, so it has to follow them.
  let indexed: number | null = null;
  if (store?.rebuildIndex) {
    indexed = await store.rebuildIndex().catch((error: unknown) => {
      deps.renderer.writeError(`Catalog rebuild failed: ${toErrorMessage(error)}\n`);
      return null;
    });
  }

  if (asJson) {
    deps.renderer.write(`${JSON.stringify({ report, repair, indexed }, null, 2)}\n`);
    return repair.failed.length > 0 ? 1 : 0;
  }
  const lines = renderReport(report, limit);
  lines.push('', color.bold('Repairs'));
  lines.push(`  ${color.green('✓')} rebuilt ${repair.repaired.length} summary sidecar(s)`);
  if (indexed !== null) lines.push(`  ${color.green('✓')} re-indexed ${indexed} session(s)`);
  for (const failure of repair.failed) {
    lines.push(`  ${ICON.error} ${color.cyan(failure.id)} — ${failure.reason}`);
  }
  lines.push(
    color.dim(
      '  Journals were not modified. Snapshot bytes are reclaimed with `wstack sessions prune`.',
    ),
  );
  deps.renderer.write(`${lines.join('\n')}\n`);
  return repair.failed.length > 0 ? 1 : 0;
};
