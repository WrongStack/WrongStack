import { useAppTranslation } from '@/i18n';
import type { KanbanTask } from '@wrongstack/kanban';
import type { ReactNode } from 'react';
import { kanbanMetadataText } from '@/lib/kanban-metadata';
import { cn } from '@/lib/utils';

// Colored badge classes per real KanbanAgentRunStatus.
const RUN_STATUS_STYLE: Record<string, string> = {
  assigned: 'bg-info/10 text-info',
  queued: 'bg-info/10 text-info',
  running: 'bg-warning/10 text-warning',
  completed: 'bg-success/10 text-success',
  failed: 'bg-destructive/10 text-destructive',
  cancelled: 'bg-muted text-muted-foreground',
};

function fmtElapsed(fromIso?: string, toIso?: string): string | null {
  if (!fromIso) return null;
  const from = Date.parse(fromIso);
  if (Number.isNaN(from)) return null;
  const to = toIso ? Date.parse(toIso) : Date.now();
  if (Number.isNaN(to)) return null;
  const secs = Math.max(0, Math.round((to - from) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}

export function AgentRunPanel({
  assignment,
}: {
  assignment: NonNullable<KanbanTask['assignment']>;
}) {
  const { t } = useAppTranslation();
  const running = assignment.status === 'running';
  const elapsed = fmtElapsed(assignment.dispatchedAt, assignment.completedAt);
  const agentName = kanbanMetadataText(assignment.name) ?? kanbanMetadataText(assignment.agentId);
  const role = kanbanMetadataText(assignment.role);
  const provider = kanbanMetadataText(assignment.provider);
  const model = kanbanMetadataText(assignment.model);
  const rows: Array<{ label: string; value: ReactNode }> = [];
  if (agentName) rows.push({ label: t('activity:kanbanRun.agent'), value: agentName });
  if (role) rows.push({ label: t('activity:kanbanRun.role'), value: role });
  if (assignment.modelRouting)
    rows.push({ label: t('activity:kanbanRun.modelSource'), value: assignment.modelRouting });
  if (provider || model) {
    rows.push({
      label: t('activity:kanbanRun.model'),
      value: (
        <span className="font-mono text-[11px]">
          {provider ? `${provider}/` : ''}
          {model ?? '—'}
        </span>
      ),
    });
  }
  if (assignment.subagentId) {
    rows.push({
      label: t('activity:kanban.subagent'),
      value: <span className="font-mono text-[11px]">{assignment.subagentId}</span>,
    });
  }
  if (elapsed) {
    rows.push({
      label: assignment.completedAt ? t('activity:kanban.duration') : t('activity:kanban.elapsed'),
      value: elapsed,
    });
  }
  if (typeof assignment.attempt === 'number') {
    rows.push({
      label: t('activity:kanbanRun.attempt'),
      value: `${assignment.attempt}${assignment.maxAttempts ? ` / ${assignment.maxAttempts}` : ''}`,
    });
  }
  if (assignment.costCeilingUsd) {
    rows.push({
      label: t('activity:kanbanRun.costCeiling'),
      value: `$${assignment.costCeilingUsd.toFixed(2)}`,
    });
  }
  if (assignment.fallbackProfile) {
    rows.push({
      label: t('activity:kanbanRun.fallbackProfile'),
      value: assignment.fallbackProfile,
    });
  }
  if (assignment.fallbackModels?.length) {
    rows.push({
      label: t('activity:kanbanRun.fallbacks'),
      value: assignment.fallbackModels.join(' → '),
    });
  }
  if (assignment.skills?.length)
    rows.push({ label: t('activity:kanbanRun.skills'), value: assignment.skills.join(', ') });
  if (assignment.tools?.length)
    rows.push({ label: t('activity:kanbanRun.tools'), value: assignment.tools.join(', ') });
  if (assignment.leaseExpiresAt) {
    rows.push({
      label: t('activity:kanbanRun.leaseExpires'),
      value: new Date(assignment.leaseExpiresAt).toLocaleString(),
    });
  }

  return (
    <div className="mt-4 rounded-md border bg-background p-2.5">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          {t('activity:kanban.liveRun')}
        </span>
        <span
          className={cn(
            'ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium capitalize',
            RUN_STATUS_STYLE[assignment.status] ?? 'bg-muted text-muted-foreground',
          )}
        >
          {running && (
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" aria-hidden />
          )}
          {assignment.status}
        </span>
      </div>
      {rows.length > 0 && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          {rows.map((row) => (
            <div key={row.label} className="contents">
              <dt className="text-muted-foreground">{row.label}</dt>
              <dd className="min-w-0 truncate text-right text-foreground">{row.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {assignment.lastResult && (
        <div className="mt-2">
          <div className="mb-1 text-[10px] uppercase text-muted-foreground">
            {t('activity:kanban.lastResult')}
          </div>
          <div className="max-h-24 overflow-y-auto whitespace-pre-wrap rounded bg-muted px-2 py-1 text-[11px] leading-relaxed text-foreground">
            {assignment.lastResult}
          </div>
        </div>
      )}
      {assignment.error && (
        <div className="mt-2 rounded border border-destructive/30 bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
          {assignment.error}
        </div>
      )}
    </div>
  );
}
