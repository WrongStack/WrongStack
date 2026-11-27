import { ChevronRight, Database, GitBranch, ShieldCheck } from 'lucide-react';
import { useMemo } from 'react';
import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import type { ChronicleEventView, ChronicleGraphResult, ChronicleSummary } from '@/types';

export type Health = {
  eventLoop?: { utilization?: number; delayP95Ms?: number };
  memory?: { heapUsedBytes?: number };
  chronicle?: { pendingEvents?: number; rejectedEvents?: number; largestBatch?: number };
};
const emptyFamilies = {
  llm: 0,
  agent: 0,
  tool: 0,
  file: 0,
  memory: 0,
  task: 0,
  decision: 0,
  runtime: 0,
};
export const emptySummary: ChronicleSummary = {
  logicalRequests: 0,
  modelAttempts: 0,
  completedAttempts: 0,
  failedAttempts: 0,
  scheduledRetries: 0,
  fallbacks: 0,
  providers: 0,
  models: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  estimatedCostUsd: 0,
  providerAvgDurationMs: 0,
  providerP95DurationMs: 0,
  toolCalls: 0,
  completedTools: 0,
  failedTools: 0,
  toolAvgDurationMs: 0,
  processes: 0,
  failedProcesses: 0,
  fileEvents: 0,
  uniqueFiles: 0,
  agentEvents: 0,
  uniqueAgents: 0,
  decisions: 0,
  escalations: 0,
  failures: 0,
  cancellations: 0,
  families: { ...emptyFamilies },
  failuresByFamily: { ...emptyFamilies },
};
export function signalTotal(summary: ChronicleSummary, signal: Signal, total: number) {
  if (signal === 'all') return total;
  if (signal === 'llm') return summary.families.llm;
  if (signal === 'agents') return summary.families.agent;
  if (signal === 'tools') return summary.families.tool;
  if (signal === 'files') return summary.families.file;
  return summary.failures;
}
export function cacheRatio(summary: ChronicleSummary) {
  const total = summary.inputTokens + summary.cacheReadTokens;
  return total ? (summary.cacheReadTokens / total) * 100 : 0;
}
export function matchesSignal(event: ChronicleEventView, signal: Signal) {
  if (signal === 'all') return true;
  if (signal === 'llm') return /^(provider|token|context|compaction)\./.test(event.eventType);
  if (signal === 'agents') return /^(agent|subagent|delegate|fleet|sdd)\./.test(event.eventType);
  if (signal === 'tools') return /^(tool|process|mcp|network)\./.test(event.eventType);
  if (signal === 'files')
    return event.resource?.kind === 'file' || /^(file|worktree|storage)\./.test(event.eventType);
  return (
    event.outcome === 'failure' ||
    /(?:failed|error|retry|fallback|blocked|conflict)/i.test(event.eventType)
  );
}
function formatDuration(ns: number) {
  if (!ns) return '—';
  const ms = ns / 1e6;
  return ms < 1
    ? `${(ns / 1e3).toFixed(0)}µs`
    : ms < 1000
      ? `${ms.toFixed(1)}ms`
      : `${(ms / 1000).toFixed(1)}s`;
}
export function formatMilliseconds(ms: number) {
  if (!ms) return '—';
  return ms < 1
    ? `${(ms * 1000).toFixed(0)}µs`
    : ms < 1000
      ? `${ms.toFixed(1)}ms`
      : `${(ms / 1000).toFixed(1)}s`;
}
export function Field({
  placeholder,
  value,
  onChange,
  onEnter,
  icon,
}: {
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  onEnter: () => void;
  icon?: React.ReactNode;
}) {
  return (
    <label className="flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-2 focus-within:border-primary/60">
      {icon && <span className="text-muted-foreground [&>svg]:h-3.5 [&>svg]:w-3.5">{icon}</span>}
      <input
        className="w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground/70"
        placeholder={placeholder}
        aria-label={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onEnter();
        }}
      />
    </label>
  );
}
export function Insight({
  icon,
  label,
  value,
  detail,
  tone = 'normal',
}: {
  icon: React.ReactNode;
  label: string;
  value: number | string;
  detail: string;
  tone?: 'normal' | 'danger';
}) {
  return (
    <div className="ws-metric min-w-0 border border-border/60 px-4 py-3">
      <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        <span className="text-primary [&>svg]:h-3.5 [&>svg]:w-3.5">{icon}</span>
        {label}
      </div>
      <div className={cn('ws-metric-value mt-2', tone === 'danger' && 'text-destructive')}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
      <div className="mt-0.5 truncate text-[9px] text-muted-foreground">{detail}</div>
    </div>
  );
}
export function RuntimeStrip({ health }: { health: Health }) {
  const { t } = useAppTranslation();
  return (
    <section className="flex flex-wrap gap-x-5 gap-y-1 border-b border-border/60 bg-success/[0.025] px-4 py-1.5 font-mono text-[9px] text-muted-foreground">
      <span className="font-sans font-semibold uppercase tracking-wider text-success">
        {t('activity:chronicle.collectorHealthy')}
      </span>
      <span>
        ELU{' '}
        <b className="text-foreground">
          {((health.eventLoop?.utilization ?? 0) * 100).toFixed(1)}%
        </b>
      </span>
      <span>
        p95 <b className="text-foreground">{(health.eventLoop?.delayP95Ms ?? 0).toFixed(1)}ms</b>
      </span>
      <span>
        heap{' '}
        <b className="text-foreground">
          {((health.memory?.heapUsedBytes ?? 0) / 1048576).toFixed(0)}MB
        </b>
      </span>
      <span>
        queue <b className="text-foreground">{health.chronicle?.pendingEvents ?? 0}</b>
      </span>
      <span>
        dropped{' '}
        <b className={cn((health.chronicle?.rejectedEvents ?? 0) > 0 && 'text-destructive')}>
          {health.chronicle?.rejectedEvents ?? 0}
        </b>
      </span>
    </section>
  );
}
export function EventRow({
  event,
  active,
  onClick,
}: {
  event: ChronicleEventView;
  active: boolean;
  onClick: () => void;
}) {
  const at = event.occurredAt ?? event.observedAt;
  const actor = event.runtime?.modelId ?? event.scope.agentId ?? event.runtime?.providerId ?? '—';
  const resource =
    event.resource?.path ?? event.resource?.id ?? event.correlation.toolCallId ?? '—';
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'grid w-full grid-cols-[92px_minmax(190px,1.25fr)_110px_minmax(180px,1fr)_minmax(140px,.8fr)_24px] items-center gap-3 px-4 py-2.5 text-left hover:bg-muted/45',
        active && 'bg-primary/[0.07]',
      )}
    >
      <span className="font-mono text-[9px] text-muted-foreground">
        {new Date(at).toLocaleTimeString()}
      </span>
      <span className="flex min-w-0 items-center gap-2">
        <span
          className={cn(
            'h-1.5 w-1.5 shrink-0 rounded-full',
            event.outcome === 'failure'
              ? 'bg-destructive'
              : event.outcome === 'success'
                ? 'bg-success'
                : 'bg-primary',
          )}
        />
        <span className="truncate font-mono text-[11px] font-medium">{event.eventType}</span>
      </span>
      <span className={cn('w-fit rounded px-1.5 py-0.5 text-[9px]', outcomeClass(event.outcome))}>
        {event.outcome ?? 'unknown'}
      </span>
      <span className="truncate font-mono text-[9px] text-muted-foreground">{actor}</span>
      <span className="truncate font-mono text-[9px] text-muted-foreground">{resource}</span>
      <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
    </button>
  );
}
export function Detail({
  event,
  graph,
}: {
  event: ChronicleEventView;
  graph: ChronicleGraphResult | null;
}) {
  const { t } = useAppTranslation();
  const sections = useMemo(
    () =>
      [
        ['Scope', event.scope],
        ['Correlation', event.correlation],
        ['Runtime', event.runtime],
        ['Resource', event.resource],
        ['Attributes', event.attributes],
        ['Tags', event.tags],
      ] as const,
    [event],
  );
  return (
    <div className="p-4">
      <div className="mb-4 rounded-lg border border-border bg-background/60 p-3">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'h-2 w-2 rounded-full',
              event.outcome === 'failure'
                ? 'bg-destructive'
                : event.outcome === 'success'
                  ? 'bg-success'
                  : 'bg-primary',
            )}
          />
          <span className="font-mono text-xs font-semibold">{event.eventType}</span>
        </div>
        <div className="mt-2 flex gap-4 text-[9px] text-muted-foreground">
          <span>{new Date(event.occurredAt ?? event.observedAt).toLocaleString()}</span>
          <span>{formatDuration(Number(event.durationNs ?? 0))}</span>
        </div>
      </div>
      <div className="mb-4 grid grid-cols-2 gap-2">
        <Badge
          icon={<ShieldCheck />}
          label={t('activity:chronicle.evidenceHash')}
          value={event.hash.slice(0, 16)}
        />
        <Badge
          icon={<Database />}
          label={t('activity:chronicle.sequence')}
          value={String(event.sequence)}
        />
      </div>
      {graph && (
        <section className="mb-4">
          <h3 className="mb-1.5 flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
            <GitBranch className="h-3 w-3" />
            Lineage · {graph.nodes.length} nodes · {graph.edges.length} edges
          </h3>
          <div className="space-y-1 rounded-md border border-border bg-background/70 p-2">
            {graph.edges.slice(0, 40).map((edge, index) => (
              <div
                key={`${edge.from}-${edge.to}-${edge.kind}-${index}`}
                className="flex items-center gap-2 font-mono text-[9px]"
              >
                <span
                  className={cn(
                    'rounded px-1',
                    edge.confidence === 'explicit'
                      ? 'bg-success/10 text-success'
                      : edge.confidence === 'inferred'
                        ? 'bg-warning/10 text-warning'
                        : 'bg-primary/10 text-primary',
                  )}
                >
                  {edge.confidence}
                </span>
                <span className="text-muted-foreground">{edge.kind}</span>
                <span className="truncate">
                  {graph.nodes.find((node) => node.eventId === edge.from)?.eventType} →{' '}
                  {graph.nodes.find((node) => node.eventId === edge.to)?.eventType}
                </span>
              </div>
            ))}
          </div>
          {graph.truncated && (
            <p className="mt-1 text-[9px] text-warning">
              {t('activity:chronicle.lineageTruncatedAtSafetyLimit')}
            </p>
          )}
        </section>
      )}
      {sections.map(
        ([label, value]) =>
          value && (
            <section key={label} className="mb-4">
              <h3 className="mb-1.5 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
                {label}
              </h3>
              <pre className="overflow-auto rounded-md border border-border bg-background/70 p-3 font-mono text-[9px] leading-relaxed">
                {JSON.stringify(value, null, 2)}
              </pre>
            </section>
          ),
      )}
    </div>
  );
}
function Badge({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-md border border-border p-2">
      <div className="flex items-center gap-1 text-[8px] uppercase text-muted-foreground">
        <span className="[&>svg]:h-3 [&>svg]:w-3">{icon}</span>
        {label}
      </div>
      <div className="mt-1 truncate font-mono text-[9px]">{value}</div>
    </div>
  );
}
export function Empty({ text }: { text: string }) {
  return (
    <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
      {text}
    </div>
  );
}
function outcomeClass(outcome?: string) {
  return outcome === 'failure'
    ? 'bg-destructive/10 text-destructive'
    : outcome === 'success'
      ? 'bg-success/10 text-success'
      : outcome === 'started'
        ? 'bg-primary/10 text-primary'
        : 'bg-muted text-muted-foreground';
}

export type Signal = 'all' | 'llm' | 'agents' | 'tools' | 'files' | 'failures';
