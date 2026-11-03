/**
 * SAGE Doctor ("Health") tab: store metrics, the maintenance scheduler state
 * and the doctor checks, with the engine's named, idempotent repairs.
 * Mirrors `/memory doctor [--fix]` and `wstack sage doctor`.
 */
import { AlertTriangle, Check, Loader2, RefreshCw, Wrench } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SurfaceClient } from '../host';
import { useAppTranslation } from '../lib/i18n';
import { cn } from '../lib/utils';
import { Button } from '../ui/button';
import type { SageDoctorFixId, SageDoctorReport, SageDoctorSeverity } from './model-types';
import { sortDoctorChecks, suggestedFixes } from './sage-health-model';
import { relativeDate } from './shared';

/** The `hygiene` repair can take minutes on a large store (the port allows 5). */
export const DOCTOR_TIMEOUT_MS = 6 * 60_000;

const SEVERITY_CLASS: Record<SageDoctorSeverity, string> = {
  error: 'border-destructive/40 bg-destructive/10 text-destructive',
  warn: 'border-warning/40 bg-warning/10 text-warning',
  info: 'border-info/35 bg-info/10 text-info',
  ok: 'border-success/35 bg-success/10 text-success',
};
const SEVERITY_LABEL_KEY: Record<SageDoctorSeverity, string> = {
  error: 'activity:memoryManager.healthSeverityError',
  warn: 'activity:memoryManager.healthSeverityWarn',
  info: 'activity:memoryManager.healthSeverityInfo',
  ok: 'activity:memoryManager.healthSeverityOk',
};
/** SAGE memory ids: a ULID, optionally `mem_`-prefixed (recovered records). */
const MEMORY_ID_RE = /^(?:mem_)?[0-9A-HJKMNP-TV-Z]{26}$/iu;

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="border border-border/70 bg-card/55 px-3 py-2">
      <p className="text-[9px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </p>
      <p className="mt-0.5 font-mono text-sm tabular-nums text-foreground">{value}</p>
      {hint ? <p className="truncate text-[9px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

interface SageHealthPanelProps {
  /** Only the subscription surface is used. */
  client: Pick<SurfaceClient, 'on'>;
  sageDoctor: (
    opts?: { fix?: SageDoctorFixId[]; requestId?: string },
    options?: { echoToChat?: boolean },
  ) => void;
  /** True while the Health tab is shown; the first activation loads the report. */
  active: boolean;
  onOpenMemory: (id: string) => void;
  /** Latest report, so the stats bar can show injection precision. */
  onReport?: (report: SageDoctorReport) => void;
}

export function SageHealthPanel({
  client,
  sageDoctor,
  active,
  onOpenMemory,
  onReport,
}: SageHealthPanelProps) {
  const { t } = useAppTranslation();
  const [report, setReport] = useState<SageDoctorReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyFix, setBusyFix] = useState<SageDoctorFixId | 'all' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const loadedRef = useRef(false);
  const seqRef = useRef(0);
  /** Cancels in-flight waits so unmount clears their listeners and timers. */
  const pendingRef = useRef(new Set<() => void>());

  useEffect(() => {
    const pending = pendingRef.current;
    return () => {
      for (const cancel of [...pending]) cancel();
    };
  }, []);

  /** Send one doctor request and settle on the reply carrying its requestId. */
  const run = useCallback(
    (fix?: SageDoctorFixId[]) =>
      new Promise<{ report?: SageDoctorReport; error?: string }>((resolve) => {
        seqRef.current += 1;
        const requestId = `doctor_${Date.now()}_${seqRef.current}`;
        let timer: ReturnType<typeof setTimeout> | null = null;
        let off = () => {};
        const settle = (result: { report?: SageDoctorReport; error?: string }) => {
          if (timer !== null) clearTimeout(timer);
          timer = null;
          off();
          pendingRef.current.delete(cancel);
          resolve(result);
        };
        const cancel = () => settle({ error: t('activity:memoryManager.healthTimeout') });
        off = client.on('memory.sage.doctor', (message) => {
          const echoed = message.payload.requestId;
          if (echoed !== undefined && echoed !== requestId) return;
          const { report: next, error: err } = message.payload;
          settle(err ? { error: String(err) } : next ? { report: next } : { error: 'No report.' });
        });
        pendingRef.current.add(cancel);
        timer = setTimeout(cancel, DOCTOR_TIMEOUT_MS);
        sageDoctor({ ...(fix && fix.length > 0 ? { fix } : {}), requestId }, { echoToChat: false });
      }),
    [client, sageDoctor, t],
  );

  const apply = useCallback(
    (result: { report?: SageDoctorReport; error?: string }) => {
      if (result.error !== undefined) {
        setError(result.error);
        return;
      }
      if (!result.report) return;
      setError(null);
      setReport(result.report);
      onReport?.(result.report);
      const applied = result.report.fixesApplied ?? [];
      if (applied.length > 0) {
        setNotice(
          t('activity:memoryManager.healthFixesApplied', {
            details: applied
              .map((entry) => `${entry.fix}: ${entry.detail} (${entry.changed})`)
              .join('; '),
          }),
        );
      }
    },
    [onReport, t],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    setNotice(null);
    apply(await run());
    setLoading(false);
  }, [apply, run]);

  const fix = useCallback(
    async (target: SageDoctorFixId | 'all') => {
      const fixes = target === 'all' ? suggestedFixes(report) : [target];
      if (fixes.length === 0) return;
      setBusyFix(target);
      setNotice(null);
      apply(await run(fixes));
      setBusyFix(null);
    },
    [apply, report, run],
  );

  useEffect(() => {
    if (!active || loadedRef.current) return;
    loadedRef.current = true;
    void refresh();
  }, [active, refresh]);

  const busy = loading || busyFix !== null;
  const suggested = suggestedFixes(report);
  const m = report?.metrics;
  const maint = report?.maintenance;

  if (!report && loading) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        {t('activity:memoryManager.healthLoading')}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="sage-health-panel">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
        <span className="text-[11px] text-muted-foreground">
          {report
            ? t('activity:memoryManager.healthGeneratedAt', {
                time: relativeDate(report.generatedAt),
              })
            : null}
        </span>
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            className="h-7"
            disabled={busy || suggested.length === 0}
            onClick={() => void fix('all')}
          >
            {busyFix === 'all' ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <Wrench className="size-3" />
            )}
            {t('activity:memoryManager.healthFixAll')}
            {suggested.length > 0 ? ` (${suggested.length})` : ''}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7"
            disabled={busy}
            onClick={() => void refresh()}
            aria-label={t('common:action.refresh')}
          >
            <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
          </Button>
        </div>
      </div>

      {(error || notice) && (
        <div className="shrink-0 border-b border-border/60 px-3 py-1.5 text-[11px]">
          {error ? (
            <p role="alert" className="flex items-center gap-1.5 text-destructive">
              <AlertTriangle className="size-3.5" /> {error}
            </p>
          ) : null}
          {notice ? (
            <p role="status" className="flex items-center gap-1.5 text-success">
              <Check className="size-3.5" /> {notice}
            </p>
          ) : null}
        </div>
      )}

      {report && m ? (
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
          <div className="grid grid-cols-2 gap-1.5">
            <Metric
              label={t('activity:memoryManager.healthMetricActive')}
              value={`${m.active} / ${m.total}`}
            />
            <Metric label={t('activity:memoryManager.tabGraphEdges')} value={String(m.edges)} />
            <Metric
              label={t('activity:memoryManager.healthMetricPending')}
              value={String(m.pendingCandidates)}
            />
            <Metric
              label={t('activity:memoryManager.healthMetricPrecision')}
              value={m.injections > 0 ? `${Math.round(m.precision * 100)}%` : '—'}
              hint={t('activity:memoryManager.healthMetricPrecisionHint', {
                uses: m.uses,
                injections: m.injections,
              })}
            />
            <Metric
              label={t('activity:memoryManager.healthMetricNeverUsed')}
              value={String(m.injectedNeverUsed)}
            />
            <Metric
              label={t('activity:memoryManager.healthMetricUnanchored')}
              value={String(m.unanchoredActive)}
            />
            <Metric
              label={t('activity:memoryManager.healthMetricDbSize')}
              value={`${formatBytes(m.dbBytes)} / ${formatBytes(m.walBytes)}`}
            />
          </div>

          {maint ? (
            <section className="border border-border/70 bg-card/40 p-2.5 text-[11px]">
              <h3 className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
                {t('activity:memoryManager.healthMaintenance')}
              </h3>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
                <dt className="text-muted-foreground">
                  {t('activity:memoryManager.healthMaintOwner')}
                </dt>
                <dd className="font-mono">
                  {maint.owner}
                  {maint.running ? ` · ${t('activity:memoryManager.healthMaintRunning')}` : ''}
                </dd>
                <dt className="text-muted-foreground">
                  {t('activity:memoryManager.healthMaintScheduled')}
                </dt>
                <dd>
                  {maint.scheduled
                    ? t('activity:memoryManager.healthYes')
                    : t('activity:memoryManager.healthNo')}
                </dd>
                <dt className="text-muted-foreground">
                  {t('activity:memoryManager.healthMaintLastRun')}
                </dt>
                <dd>{relativeDate(maint.lastRunAt)}</dd>
                <dt className="text-muted-foreground">
                  {t('activity:memoryManager.healthMaintNextRun')}
                </dt>
                <dd>{maint.nextRunAt ? relativeDate(maint.nextRunAt) : '—'}</dd>
                {maint.lastError ? (
                  <>
                    <dt className="text-muted-foreground">
                      {t('activity:memoryManager.healthMaintLastError')}
                    </dt>
                    <dd className="text-destructive">{maint.lastError}</dd>
                  </>
                ) : null}
              </dl>
            </section>
          ) : null}

          <ul className="space-y-1.5" aria-label={t('activity:memoryManager.healthChecks')}>
            {sortDoctorChecks(report.checks).map((check) => (
              <li
                key={check.id}
                data-testid="doctor-check"
                data-check-id={check.id}
                data-severity={check.severity}
                className="border border-border/70 bg-card/50 p-2.5 text-[12px]"
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <span
                    className={cn(
                      'border px-1.5 py-0.5 font-mono text-[9px] uppercase',
                      SEVERITY_CLASS[check.severity],
                    )}
                  >
                    {t(SEVERITY_LABEL_KEY[check.severity])}
                  </span>
                  <span className="font-medium text-foreground">{check.title}</span>
                  {check.fix && (check.severity === 'warn' || check.severity === 'error') ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="ml-auto h-6 text-[10px]"
                      disabled={busy}
                      onClick={() => void fix(check.fix!)}
                      aria-label={`${t('activity:memoryManager.healthFix')} ${check.fix}`}
                    >
                      {busyFix === check.fix ? (
                        <Loader2 className="size-3 animate-spin" />
                      ) : (
                        <Wrench className="size-3" />
                      )}
                      {t('activity:memoryManager.healthFix')}
                    </Button>
                  ) : null}
                </div>
                <p className="mt-1 text-muted-foreground">{check.summary}</p>
                {check.samples && check.samples.length > 0 ? (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {check.samples.map((sample) =>
                      MEMORY_ID_RE.test(sample) ? (
                        <button
                          key={sample}
                          type="button"
                          className="rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] text-foreground hover:bg-primary/20 hover:underline"
                          onClick={() => onOpenMemory(sample)}
                          title={t('activity:memoryManager.healthOpenMemory')}
                        >
                          {sample.slice(0, 16)}…
                        </button>
                      ) : (
                        <span
                          key={sample}
                          className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                        >
                          {sample}
                        </span>
                      ),
                    )}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
