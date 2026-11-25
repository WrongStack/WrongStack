import * as fsp from 'node:fs/promises';

import type {
  BugFinding,
  CollabDebugReport,
  CollabSessionOptions,
  CriticEvaluation,
  DirectorAlert,
  RefactorPlan,
  SharedFileSnapshot,
} from './collab-debug-types.js';

export interface CollabDebugReportHost {
  bugs: Map<string, BugFinding>;
  plans: Map<string, RefactorPlan>;
  evaluations: Map<string, CriticEvaluation>;
  cancelled: boolean;
  buildMarkdownSummary: (
    bugs: BugFinding[],
    plans: RefactorPlan[],
    evals: CriticEvaluation[],
    overallVerdict: CollabDebugReport['overallVerdict'],
    disposition: CollabDebugReport['disposition'],
  ) => string;
  sessionId: string;
  snapshot: SharedFileSnapshot;
  options: CollabSessionOptions;
  alerts: DirectorAlert[];
  snapshotWarnings: string[];
}
export function assembleReport(host: CollabDebugReportHost): CollabDebugReport {
  const bugList = Array.from(host.bugs.values());
  const planList = Array.from(host.plans.values());
  const evalList = Array.from(host.evaluations.values());

  let disposition: CollabDebugReport['disposition'] = 'completed';
  if (host.cancelled) disposition = 'cancelled';

  const verdictOrder: Record<CollabDebugReport['overallVerdict'], number> = {
    approve: 0,
    needs_revision: 1,
    reject: 2,
  };
  const overallVerdict = evalList.reduce<CollabDebugReport['overallVerdict']>((worst, eval_) => {
    const w = verdictOrder[worst];
    const verdict: CollabDebugReport['overallVerdict'] = Object.hasOwn(verdictOrder, eval_.verdict)
      ? eval_.verdict
      : 'reject';
    const c = verdictOrder[verdict];
    return c > w ? verdict : worst;
  }, 'approve');

  const summary = host.buildMarkdownSummary(
    bugList,
    planList,
    evalList,
    overallVerdict,
    disposition,
  );

  return {
    sessionId: host.sessionId,
    startedAt: host.snapshot.createdAt,
    completedAt: new Date().toISOString(),
    targetPaths: host.options.targetPaths,
    disposition,
    bugs: bugList,
    refactorPlans: planList,
    evaluations: evalList,
    alerts: [...host.alerts],
    ...(host.snapshotWarnings.length > 0 ? { snapshotWarnings: host.snapshotWarnings } : {}),
    overallVerdict,
    summary,
  };
}

export async function checkSnapshotFreshness(host: CollabDebugReportHost): Promise<string[]> {
  const warnings: string[] = [];
  for (const file of host.snapshot.files) {
    if (file.snapshotMtimeMs === undefined && file.snapshotSizeBytes === undefined) continue;
    try {
      const stat = await fsp.stat(file.path);
      const mtimeChanged =
        file.snapshotMtimeMs !== undefined && stat.mtimeMs > file.snapshotMtimeMs + 1;
      const sizeChanged =
        file.snapshotSizeBytes !== undefined && stat.size !== file.snapshotSizeBytes;
      if (mtimeChanged || sizeChanged) {
        warnings.push(`${file.path} changed after the collab snapshot was captured.`);
      }
    } catch {
      warnings.push(`${file.path} could not be checked after the collab snapshot was captured.`);
    }
  }
  return warnings;
}

export function buildMarkdownSummary(
  host: CollabDebugReportHost,
  bugs: BugFinding[],
  plans: RefactorPlan[],
  evals: CriticEvaluation[],
  overallVerdict: CollabDebugReport['overallVerdict'],
  disposition: CollabDebugReport['disposition'],
): string {
  const lines: string[] = [
    `## Collaborative Debugging Report — ${host.sessionId}`,
    '',
    `**Target:** ${host.options.targetPaths.join(', ')}`,
    `**Disposition:** ${disposition.toUpperCase()}`,
    `**Overall Verdict:** **${overallVerdict.toUpperCase()}**`,
    '',
  ];

  if (host.alerts.length > 0) {
    lines.push('### Alerts', '');
    for (const alert of host.alerts) {
      lines.push(`- **[${alert.level.toUpperCase()}]** ${alert.role}: ${alert.message}`);
    }
    lines.push('');
  }

  if (host.snapshotWarnings.length > 0) {
    lines.push('### Snapshot Warnings', '');
    for (const warning of host.snapshotWarnings) {
      lines.push(`- ${warning}`);
    }
    lines.push('');
  }

  if (bugs.length > 0) {
    lines.push('### Bugs Found', '');
    for (const b of bugs) {
      lines.push(
        `- **[${b.severity.toUpperCase()}]** \`${b.location.file}:${b.location.line}\` — ${b.description}`,
      );
    }
    lines.push('');
  }

  if (plans.length > 0) {
    lines.push('### Refactor Plans', '');
    for (const p of plans) {
      lines.push(`- **Phase plan** (risk: ${p.riskScore}, ~${p.estimatedChangeCount} changes)`);
      for (const phase of p.phases) {
        lines.push(`  - Phase ${phase.number}: ${phase.title} [${phase.risk}]`);
      }
    }
    lines.push('');
  }

  if (evals.length > 0) {
    lines.push('### Critic Evaluations', '');
    for (const e of evals) {
      lines.push(`- [${e.subjectType}] score=${e.score}/10 — **${e.verdict.toUpperCase()}**`);
      for (const c of e.concerns) {
        if (c.severity === 'blocking') lines.push(`  - ${c.description}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}
