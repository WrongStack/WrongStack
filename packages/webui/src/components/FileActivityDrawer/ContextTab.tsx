import { Bot, ListTree, Users } from 'lucide-react';
import { useAppTranslation } from '@/i18n';
import { EmptyRow } from './LogsTab.js';
import { type ActivityRecord, compactId } from './types.js';

export function ContextItem({
  title,
  subtitle,
  raw,
}: {
  title: string;
  subtitle: string;
  raw?: string | undefined;
}) {
  return (
    <div className="rounded-md border border-border/60 bg-background/45 px-2 py-1.5" title={raw}>
      <div className="truncate text-[10px] font-medium">{title}</div>
      <div className="mt-0.5 truncate font-mono text-[8px] text-muted-foreground">{subtitle}</div>
    </div>
  );
}

export function ContextColumn({
  icon,
  title,
  empty,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  empty: string;
  children: React.ReactNode;
}) {
  const hasChildren = Array.isArray(children) ? children.length > 0 : !!children;
  return (
    <section className="min-w-0 p-2">
      <h3 className="mb-1.5 flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground [&>svg]:h-3 [&>svg]:w-3">
        {icon}
        {title}
      </h3>
      <div className="space-y-1">{hasChildren ? children : <EmptyRow text={empty} />}</div>
    </section>
  );
}

export function ContextTab({
  sessions,
  agents,
  tasks,
  records,
  taskLabel,
  boardTitle,
}: {
  sessions: string[];
  agents: string[];
  tasks: string[];
  records: ActivityRecord[];
  taskLabel: (id: string) => string;
  boardTitle?: string | undefined;
}) {
  const { t } = useAppTranslation();
  return (
    <div className="grid min-h-full grid-cols-1 divide-y divide-border/50 md:grid-cols-3 md:divide-x md:divide-y-0">
      <ContextColumn
        icon={<Users />}
        title={t('activity:fileActivity.sessions')}
        empty={t('activity:fileActivity.noSessions')}
      >
        {sessions.map((id) => (
          <ContextItem
            key={id}
            title={compactId(id)}
            subtitle={`${records.filter((record) => record.sessionId === id).length} ${t('activity:fileActivity.events')}`}
            raw={id}
          />
        ))}
      </ContextColumn>
      <ContextColumn
        icon={<Bot />}
        title={t('activity:fileActivity.actors')}
        empty={t('activity:fileActivity.noActors')}
      >
        {agents.map((name) => (
          <ContextItem
            key={name}
            title={name}
            subtitle={`${records.filter((record) => record.actor === name).length} ${t('activity:fileActivity.events')}`}
          />
        ))}
      </ContextColumn>
      <ContextColumn
        icon={<ListTree />}
        title={t('activity:fileActivity.workLinks')}
        empty={t('activity:fileActivity.noWorkLinks')}
      >
        {tasks.map((id) => (
          <ContextItem
            key={id}
            title={taskLabel(id)}
            subtitle={boardTitle ?? t('activity:fileActivity.taskOrTodo')}
            raw={id}
          />
        ))}
      </ContextColumn>
    </div>
  );
}
