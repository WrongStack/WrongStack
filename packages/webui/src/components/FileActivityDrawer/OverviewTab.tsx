import { Bot, FileClock, FileDiff, ListTree, ShieldAlert, Users } from 'lucide-react';
import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { ActivityRow, EmptyRow } from './LogsTab.js';
import type { ActivityRecord, FileActivityAnalysis, FileLineageSummary } from './types.js';

export function LifetimeLineage({ lifetime }: { lifetime: FileLineageSummary }) {
  const { t } = useAppTranslation();
  const stats: Array<{ value: number; label: string }> = [
    { value: lifetime.mutations, label: t('activity:fileActivity.lifetimeChanges') },
    { value: lifetime.sessions, label: t('activity:fileActivity.lifetimeSessions') },
    { value: lifetime.tasks, label: t('activity:fileActivity.lifetimeTasks') },
    { value: lifetime.boards, label: t('activity:fileActivity.lifetimeBoards') },
  ];
  const since = lifetime.firstAt ? new Date(lifetime.firstAt).toLocaleDateString() : undefined;
  return (
    <div className="rounded-md border border-primary/15 bg-primary/[0.03] px-2.5 py-2">
      <div className="flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-wider text-primary [&>svg]:h-3 [&>svg]:w-3">
        <FileClock />
        {t('activity:fileActivity.lifetimeTitle')}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[9px] text-muted-foreground">
        {stats.map((stat) => (
          <span key={stat.label}>
            <b className="text-foreground">{stat.value.toLocaleString()}</b> {stat.label}
          </span>
        ))}
        {since && <span>{t('activity:fileActivity.lifetimeSince', { date: since })}</span>}
      </div>
      {lifetime.tools.length > 0 && (
        <div
          className="mt-1 truncate font-mono text-[8px] text-muted-foreground"
          title={lifetime.tools.join(', ')}
        >
          {t('activity:fileActivity.lifetimeTools', {
            tools: lifetime.tools.slice(0, 6).join(', '),
          })}
        </div>
      )}
    </div>
  );
}

export function OverviewTab({
  analysis,
  lifetime,
  records,
  sessions,
  agents,
  tasks,
  taskLabel,
}: {
  analysis: FileActivityAnalysis;
  lifetime: FileLineageSummary;
  records: ActivityRecord[];
  sessions: string[];
  agents: string[];
  tasks: string[];
  taskLabel: (id: string) => string;
}) {
  const { t } = useAppTranslation();
  const cards = [
    {
      label: t('activity:fileActivity.mutations30m'),
      value: analysis.mutationCount,
      icon: <FileDiff />,
    },
    { label: t('activity:fileActivity.sessions'), value: sessions.length, icon: <Users /> },
    { label: t('activity:fileActivity.actors'), value: agents.length, icon: <Bot /> },
    { label: t('activity:fileActivity.linkedWork'), value: tasks.length, icon: <ListTree /> },
  ];
  return (
    <div className="grid min-h-full grid-cols-1 gap-2 p-2 lg:grid-cols-[minmax(360px,.9fr)_minmax(420px,1.35fr)]">
      <div className="space-y-2">
        <div className="grid grid-cols-4 gap-1.5">
          {cards.map((card) => (
            <div
              key={card.label}
              className="rounded-md border border-border/70 bg-background/45 px-2 py-1.5"
            >
              <div className="flex items-center gap-1 text-[9px] text-muted-foreground [&>svg]:h-3 [&>svg]:w-3">
                {card.icon}
                <span className="truncate">{card.label}</span>
              </div>
              <div className="mt-0.5 font-mono text-sm font-semibold">{card.value}</div>
            </div>
          ))}
        </div>
        {lifetime.mutations > 0 && <LifetimeLineage lifetime={lifetime} />}
        <div
          className={cn(
            'flex items-start gap-2 rounded-md border px-2.5 py-2 text-[10px]',
            analysis.level === 'churn'
              ? 'border-destructive/25 bg-destructive/[0.055]'
              : 'border-border/70 bg-background/45',
          )}
        >
          <ShieldAlert
            className={cn(
              'mt-0.5 h-3.5 w-3.5 shrink-0',
              analysis.level === 'churn' ? 'text-destructive' : 'text-primary',
            )}
          />
          <div>
            <div className="font-semibold">
              {t(`activity:fileActivity.analysisTitle.${analysis.level}`)}
            </div>
            <p className="mt-0.5 text-muted-foreground">
              {t(`activity:fileActivity.analysisBody.${analysis.level}`, {
                mutations: analysis.mutationCount,
                actors: analysis.actorCount,
                sessions: analysis.sessionCount,
              })}
            </p>
          </div>
        </div>
        {tasks.length > 0 && (
          <div className="flex flex-wrap items-center gap-1 text-[9px]">
            <span className="text-muted-foreground">{t('activity:fileActivity.workLinks')}:</span>
            {tasks.slice(0, 4).map((id) => (
              <span
                key={id}
                className="max-w-[180px] truncate rounded border border-primary/20 bg-primary/5 px-1.5 py-0.5 text-primary"
                title={id}
              >
                {taskLabel(id)}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="min-w-0 rounded-md border border-border/70 bg-background/35">
        <div className="border-b border-border/60 px-2.5 py-1.5 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
          {t('activity:fileActivity.recentActivity')}
        </div>
        <div className="divide-y divide-border/40">
          {records.length === 0 ? (
            <EmptyRow text={t('activity:fileActivity.noEvidence')} />
          ) : (
            records
              .slice(0, 5)
              .map((record) => <ActivityRow key={`${record.id}:${record.at}`} record={record} />)
          )}
        </div>
      </div>
    </div>
  );
}
