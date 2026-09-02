import type { KanbanBoard, KanbanEvent, KanbanTask } from '@wrongstack/kanban';
import { AlertTriangle, CheckCircle2, ChevronDown, Database, ShieldAlert } from 'lucide-react';
import { usePagination } from '@/hooks/usePagination';
import { Pagination } from './ui/pagination';
import { useAppTranslation } from '@/i18n';

type TaskRiskSeverity = 'critical' | 'warning' | 'info';

/**
 * A finding carries i18n KEYS, not prose: `analyzeTaskRisk` is a pure function
 * used outside React (KanbanColumnView calls it for badge counts), so it must
 * not depend on a translator. The panel resolves the keys at render time and
 * feeds `detailParams` into the interpolation.
 */
interface TaskRiskFinding {
  id: string;
  severity: TaskRiskSeverity;
  category: 'operational' | 'audit';
  titleKey: string;
  detailKey: string;
  detailParams?: Record<string, string | number>;
  remediationKey: string;
}

interface TaskRiskAssessment {
  score: number;
  findings: TaskRiskFinding[];
  critical: number;
  warnings: number;
  coverage: {
    durableEvents: number;
    actorPercent: number;
    sessionPercent: number;
    reasonPercent: number;
    hasExecutionRoute: boolean;
    hasTerminalEvidence: boolean;
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function terminal(status?: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function percent(part: number, total: number): number {
  return total ? Math.round((part / total) * 100) : 0;
}

export function analyzeTaskRisk(
  board: KanbanBoard,
  task: KanbanTask,
  events: KanbanEvent[],
  now = new Date(),
): TaskRiskAssessment {
  const findings: TaskRiskFinding[] = [];
  const taskEvents = events.filter((event) => event.taskId === task.id);
  const mutationEvents = taskEvents.filter((event) => event.type !== 'task.created');
  const reasonEligibleEvents = mutationEvents.filter(
    (event) =>
      event.type !== 'task.assignment.heartbeat' && event.type !== 'task.assignment.snapshot',
  );
  const reasonEvents = reasonEligibleEvents.filter((event) => Boolean(event.note?.trim()));
  const assignment = task.assignment;
  const nowMs = now.getTime();
  let score = 100;
  const add = (finding: TaskRiskFinding, deduction = 0) => {
    if (findings.some((candidate) => candidate.id === finding.id)) return;
    findings.push(finding);
    score = Math.max(0, score - deduction);
  };

  if (
    task.dueDate &&
    !['completed', 'archived'].includes(task.status) &&
    Date.parse(task.dueDate) < nowMs
  ) {
    add({
      id: 'overdue',
      severity: 'critical',
      category: 'operational',
      titleKey: 'activity:taskRisk.overdueTitle',
      detailKey: 'activity:taskRisk.overdueDetail',
      detailParams: { dueDate: String(task.dueDate), status: String(task.status) },
      remediationKey: 'activity:taskRisk.overdueFix',
    });
  }

  const missingDependencies = (task.dependsOn ?? []).filter(
    (id) => !board.tasks.some((candidate) => candidate.id === id),
  );
  if (missingDependencies.length) {
    add({
      id: 'missing-dependency',
      severity: 'critical',
      category: 'operational',
      titleKey: 'activity:taskRisk.missingDependencyTitle',
      detailKey: 'activity:taskRisk.missingDependencyDetail',
      detailParams: { count: missingDependencies.length },
      remediationKey: 'activity:taskRisk.missingDependencyFix',
    });
  }
  const unresolvedDependencies = (task.dependsOn ?? []).filter((id) => {
    const dependency = board.tasks.find((candidate) => candidate.id === id);
    return dependency && !['completed', 'archived'].includes(dependency.status);
  });
  if (unresolvedDependencies.length) {
    add({
      id: 'unresolved-dependency',
      severity: 'warning',
      category: 'operational',
      titleKey: 'activity:taskRisk.unresolvedDependencyTitle',
      detailKey: 'activity:taskRisk.unresolvedDependencyDetail',
      detailParams: { count: unresolvedDependencies.length },
      remediationKey: 'activity:taskRisk.unresolvedDependencyFix',
    });
  }

  if (assignment?.status === 'failed' || assignment?.error) {
    add({
      id: 'assignment-failed',
      severity: 'critical',
      category: 'operational',
      titleKey: 'activity:taskRisk.assignmentFailedTitle',
      // The server's error text is DATA, not UI copy — surface it verbatim and
      // only translate the wrapper. With no reason at all, fall back to a
      // fully-translated sentence.
      ...((assignment.error ?? assignment.lastFailureKind)
        ? {
            detailKey: 'activity:taskRisk.assignmentFailedDetail',
            detailParams: {
              reason: String(assignment.error ?? assignment.lastFailureKind),
            },
          }
        : { detailKey: 'activity:taskRisk.assignmentFailedDetailGeneric' }),
      remediationKey: 'activity:taskRisk.assignmentFailedFix',
    });
  }
  if (
    assignment?.status === 'failed' &&
    assignment.maxAttempts !== undefined &&
    (assignment.attempt ?? 0) >= assignment.maxAttempts
  ) {
    add({
      id: 'retry-exhausted',
      severity: 'critical',
      category: 'operational',
      titleKey: 'activity:taskRisk.retryExhaustedTitle',
      detailKey: 'activity:taskRisk.retryExhaustedDetail',
      detailParams: { used: assignment.attempt ?? 0, max: String(assignment.maxAttempts) },
      remediationKey: 'activity:taskRisk.retryExhaustedFix',
    });
  }
  if (
    assignment &&
    ['queued', 'running'].includes(assignment.status) &&
    assignment.leaseExpiresAt &&
    Date.parse(assignment.leaseExpiresAt) <= nowMs
  ) {
    add({
      id: 'lease-expired',
      severity: 'critical',
      category: 'operational',
      titleKey: 'activity:taskRisk.leaseExpiredTitle',
      detailKey: 'activity:taskRisk.leaseExpiredDetail',
      detailParams: {
        expiresAt: String(assignment.leaseExpiresAt),
        status: String(assignment.status),
      },
      remediationKey: 'activity:taskRisk.leaseExpiredFix',
    });
  }
  if (
    assignment?.status === 'running' &&
    assignment.heartbeatAt &&
    nowMs - Date.parse(assignment.heartbeatAt) > 5 * 60_000
  ) {
    add({
      id: 'heartbeat-stale',
      severity: 'warning',
      category: 'operational',
      titleKey: 'activity:taskRisk.staleHeartbeatTitle',
      detailKey: 'activity:taskRisk.staleHeartbeatDetail',
      detailParams: { since: String(assignment.heartbeatAt) },
      remediationKey: 'activity:taskRisk.staleHeartbeatFix',
    });
  }
  if (task.status === 'in_progress' && !assignment) {
    add({
      id: 'unowned-in-progress',
      severity: 'warning',
      category: 'operational',
      titleKey: 'activity:taskRisk.noAssignmentTitle',
      detailKey: 'activity:taskRisk.noAssignmentDetail',
      remediationKey: 'activity:taskRisk.noAssignmentFix',
    });
  }

  const failedChecks = (task.successCriteria ?? []).filter((check) => check.status === 'failed');
  const pendingChecks = (task.successCriteria ?? []).filter((check) => check.status === 'pending');
  if (failedChecks.length) {
    add({
      id: 'failed-checks',
      severity: task.status === 'completed' ? 'critical' : 'warning',
      category: 'operational',
      titleKey: 'activity:taskRisk.failedChecksTitle',
      detailKey: 'activity:taskRisk.failedChecksDetail',
      detailParams: { count: failedChecks.length },
      remediationKey: 'activity:taskRisk.failedChecksFix',
    });
  }
  if (task.status === 'completed' && pendingChecks.length) {
    add({
      id: 'completed-with-pending-checks',
      severity: 'critical',
      category: 'operational',
      titleKey: 'activity:taskRisk.pendingChecksTitle',
      detailKey: 'activity:taskRisk.pendingChecksDetail',
      detailParams: { count: pendingChecks.length },
      remediationKey: 'activity:taskRisk.pendingChecksFix',
    });
  }

  if (!taskEvents.length) {
    add(
      {
        id: 'no-durable-events',
        severity: 'critical',
        category: 'audit',
        titleKey: 'activity:taskRisk.noEventsTitle',
        detailKey: 'activity:taskRisk.noEventsDetail',
        remediationKey: 'activity:taskRisk.noEventsFix',
      },
      25,
    );
  } else if (!taskEvents.some((event) => event.type === 'task.created')) {
    add(
      {
        id: 'missing-creation-event',
        severity: 'warning',
        category: 'audit',
        titleKey: 'activity:taskRisk.noProvenanceTitle',
        detailKey: 'activity:taskRisk.noProvenanceDetail',
        remediationKey: 'activity:taskRisk.noProvenanceFix',
      },
      10,
    );
  }

  const actorPercent = percent(
    mutationEvents.filter((event) => Boolean(event.actor)).length,
    mutationEvents.length,
  );
  const sessionPercent = percent(
    mutationEvents.filter((event) => Boolean(event.sessionId)).length,
    mutationEvents.length,
  );
  const reasonPercent = percent(reasonEvents.length, reasonEligibleEvents.length);
  if (mutationEvents.length && actorPercent < 100) {
    add(
      {
        id: 'actor-coverage',
        severity: 'warning',
        category: 'audit',
        titleKey: 'activity:taskRisk.actorCoverageTitle',
        detailKey: 'activity:taskRisk.actorCoverageDetail',
        detailParams: { percent: actorPercent },
        remediationKey: 'activity:taskRisk.actorCoverageFix',
      },
      10,
    );
  }
  if (mutationEvents.length && sessionPercent < 100) {
    add(
      {
        id: 'session-coverage',
        severity: 'warning',
        category: 'audit',
        titleKey: 'activity:taskRisk.sessionCoverageTitle',
        detailKey: 'activity:taskRisk.sessionCoverageDetail',
        detailParams: { percent: sessionPercent },
        remediationKey: 'activity:taskRisk.sessionCoverageFix',
      },
      10,
    );
  }
  if (reasonEligibleEvents.length && reasonPercent < 50) {
    add(
      {
        id: 'reason-coverage',
        severity: 'info',
        category: 'audit',
        titleKey: 'activity:taskRisk.reasonCoverageTitle',
        detailKey: 'activity:taskRisk.reasonCoverageDetail',
        detailParams: { percent: reasonPercent },
        remediationKey: 'activity:taskRisk.reasonCoverageFix',
      },
      10,
    );
  }

  const latestAssignmentEvent = [...taskEvents]
    .sort((left, right) => right.ts.localeCompare(left.ts))
    .find((event) => event.type === 'task.assigned' || event.type.startsWith('task.assignment.'));
  const routeSource = { ...record(latestAssignmentEvent?.after), ...(assignment ?? {}) };
  const hasExecutionRoute = Boolean(
    routeSource['provider'] || routeSource['model'] || routeSource['modelRouting'],
  );
  if (assignment && !hasExecutionRoute) {
    add(
      {
        id: 'missing-route',
        severity: 'warning',
        category: 'audit',
        titleKey: 'activity:taskRisk.noRouteTitle',
        detailKey: 'activity:taskRisk.noRouteDetail',
        remediationKey: 'activity:taskRisk.noRouteFix',
      },
      10,
    );
  }
  const hasTerminalEvidence = Boolean(
    assignment?.lastResult ||
      assignment?.error ||
      taskEvents.some(
        (event) =>
          terminal(String(record(event.after)['status'] ?? '')) && Boolean(event.note?.trim()),
      ),
  );
  if (terminal(assignment?.status) && !hasTerminalEvidence) {
    add(
      {
        id: 'missing-terminal-evidence',
        severity: 'critical',
        category: 'audit',
        titleKey: 'activity:taskRisk.missingTerminalEvidenceTitle',
        detailKey: 'activity:taskRisk.missingTerminalEvidenceDetail',
        detailParams: { status: String(assignment?.status) },
        remediationKey: 'activity:taskRisk.missingTerminalEvidenceFix',
      },
      15,
    );
  }

  findings.sort((left, right) => {
    const rank: Record<TaskRiskSeverity, number> = { critical: 0, warning: 1, info: 2 };
    return rank[left.severity] - rank[right.severity];
  });
  return {
    score,
    findings,
    critical: findings.filter((finding) => finding.severity === 'critical').length,
    warnings: findings.filter((finding) => finding.severity === 'warning').length,
    coverage: {
      durableEvents: taskEvents.length,
      actorPercent,
      sessionPercent,
      reasonPercent,
      hasExecutionRoute,
      hasTerminalEvidence,
    },
  };
}

function tone(severity: TaskRiskSeverity): string {
  if (severity === 'critical') return 'border-destructive/30 bg-destructive/5 text-destructive';
  if (severity === 'warning') return 'border-warning/30 bg-warning/5 text-warning';
  return 'border-info/30 bg-info/5 text-info';
}

export function TaskRiskPanel({
  board,
  task,
  events,
}: {
  board: KanbanBoard;
  task: KanbanTask;
  events: KanbanEvent[];
}) {
  const { t } = useAppTranslation();
  const assessment = analyzeTaskRisk(board, task, events);
  const findingPage = usePagination(assessment.findings, 8, task.id);
  return (
    <details open className="mt-3 rounded-md border border-border/70 bg-muted/10">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 [&::-webkit-details-marker]:hidden">
        <ShieldAlert className="size-4 text-primary" />
        <span className="text-xs font-semibold">{t('activity:taskRisk.riskAuditQuality')}</span>
        <span
          className={`rounded px-1.5 py-0.5 text-[9px] ${assessment.score >= 90 ? 'bg-success/10 text-success' : assessment.score >= 70 ? 'bg-warning/10 text-warning' : 'bg-destructive/10 text-destructive'}`}
        >
          {t('activity:taskRisk.auditScore', { score: assessment.score })}
        </span>
        {assessment.critical > 0 && (
          <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-[9px] text-destructive">
            {t('activity:taskRisk.criticalCount', { count: assessment.critical })}
          </span>
        )}
        <ChevronDown className="ml-auto size-3.5 text-muted-foreground" />
      </summary>
      <div className="space-y-2 border-t border-border/60 p-2.5">
        <div className="grid grid-cols-3 gap-1 text-center sm:grid-cols-6">
          {[
            [t('activity:taskRisk.covEvents'), assessment.coverage.durableEvents],
            [t('activity:taskRisk.covActor'), `${assessment.coverage.actorPercent}%`],
            [t('activity:taskRisk.covSession'), `${assessment.coverage.sessionPercent}%`],
            [t('activity:taskRisk.covReasons'), `${assessment.coverage.reasonPercent}%`],
            [
              t('activity:taskRisk.covRoute'),
              assessment.coverage.hasExecutionRoute
                ? t('common:action.yes')
                : t('common:action.no'),
            ],
            [
              t('activity:taskRisk.covOutcome'),
              assessment.coverage.hasTerminalEvidence
                ? t('common:action.yes')
                : t('common:action.no'),
            ],
          ].map(([label, value]) => (
            <div key={String(label)} className="rounded border bg-background/70 px-1 py-1.5">
              <div className="text-[11px] font-semibold">{value}</div>
              <div className="text-[8px] uppercase text-muted-foreground">{label}</div>
            </div>
          ))}
        </div>
        {assessment.findings.length === 0 ? (
          <div className="flex items-center gap-2 rounded border border-success/30 bg-success/5 px-2.5 py-2 text-[11px] text-success">
            <CheckCircle2 className="size-4" />{' '}
            {t('activity:taskRisk.noDeterministicTaskRisksDetected')}
          </div>
        ) : (
          <div className="space-y-1.5">
            {findingPage.pageItems.map((finding) => (
              <section
                key={finding.id}
                className={`rounded border px-2.5 py-2 ${tone(finding.severity)}`}
              >
                <div className="flex items-center gap-1.5 text-[11px] font-semibold">
                  {finding.category === 'audit' ? (
                    <Database className="size-3.5" />
                  ) : (
                    <AlertTriangle className="size-3.5" />
                  )}
                  {t(finding.titleKey)}
                  <span className="ml-auto text-[8px] uppercase opacity-75">
                    {t(`activity:taskRisk.cat.${finding.category}`)} ·{' '}
                    {t(`activity:taskRisk.sev.${finding.severity}`)}
                  </span>
                </div>
                <p className="mt-1 text-[10px] leading-4 opacity-90">
                  {t(finding.detailKey, finding.detailParams ?? {})}
                </p>
                <p className="mt-1 text-[9px] leading-4 opacity-75">
                  <strong>{t('activity:taskRisk.next')}</strong> {t(finding.remediationKey)}
                </p>
              </section>
            ))}
            <Pagination
              page={findingPage.page}
              pageSize={findingPage.pageSize}
              totalItems={findingPage.totalItems}
              onPageChange={findingPage.setPage}
              compact
              itemLabel={t('activity:taskRisk.itemLabel')}
            />
          </div>
        )}
      </div>
    </details>
  );
}
