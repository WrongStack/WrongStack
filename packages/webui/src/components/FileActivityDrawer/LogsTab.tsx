import { Loader2 } from 'lucide-react';
import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { type ActivityRecord, MUTATION_PATTERN } from './types.js';

export function EmptyRow({ text }: { text: string }) {
  return <div className="px-3 py-3 text-center text-[10px] text-muted-foreground">{text}</div>;
}

export function ActivityRow({ record, raw = false }: { record: ActivityRecord; raw?: boolean }) {
  const time = new Date(record.at).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const row = (
    <div className="grid grid-cols-[62px_74px_minmax(90px,.7fr)_minmax(160px,1.5fr)] items-center gap-2 text-[9px]">
      <span className="font-mono text-muted-foreground">{time}</span>
      <span
        className={cn(
          'w-fit rounded px-1.5 py-0.5 font-mono',
          MUTATION_PATTERN.test(record.action)
            ? 'bg-warning/10 text-warning'
            : 'bg-primary/10 text-primary',
        )}
      >
        {record.action}
      </span>
      <span className="truncate" title={record.agentId}>
        {record.actor}
      </span>
      <span className="truncate text-muted-foreground" title={record.summary}>
        {record.summary}
      </span>
    </div>
  );
  if (!raw) return <div className="px-2.5 py-1.5">{row}</div>;
  return (
    <details className="group cursor-pointer px-2.5 py-1.5">
      <summary className="list-none [&::-webkit-details-marker]:hidden">{row}</summary>
      <pre className="mt-1.5 max-h-48 overflow-auto rounded border border-border/60 bg-background/60 p-2 font-mono text-[8px] leading-relaxed text-muted-foreground">
        {JSON.stringify(record.raw, null, 2)}
      </pre>
    </details>
  );
}

export function LogsTab({ records, loading }: { records: ActivityRecord[]; loading: boolean }) {
  const { t } = useAppTranslation();
  if (loading && records.length === 0)
    return (
      <div className="flex h-full items-center justify-center gap-2 text-[10px] text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {t('activity:fileActivity.loadingEvidence')}
      </div>
    );
  if (records.length === 0) return <EmptyRow text={t('activity:fileActivity.noEvidence')} />;
  return (
    <div className="divide-y divide-border/40">
      {records.map((record) => (
        <ActivityRow key={`${record.id}:${record.at}`} record={record} raw />
      ))}
    </div>
  );
}
