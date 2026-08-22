import { useConfigStore, useSessionStore } from '@/stores';
import { fmtTok } from '@/components/ChatView/utils';
import {
  AlertTriangle,
  BarChart3,
  Code2,
  MessageSquare,
  RefreshCw,
  Wrench,
  X,
  Zap,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppTranslation } from '@/i18n';
import { useLiveContextDebug } from '@/hooks/useLiveContextDebug';
import { cn } from '@/lib/utils';

interface ContextBreakdownModalProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Zone-derived color for a token value relative to the total.
 */
function tokenColor(tokens: number, total: number): string {
  if (total <= 0) return 'text-muted-foreground';
  const pct = tokens / total;
  if (pct > 0.5) return 'text-destructive';
  if (pct > 0.25) return 'text-warning';
  if (pct > 0.1) return 'text-info';
  return 'text-muted-foreground';
}

/** A compact mini progress bar sized by the item's share of total tokens. */
function MiniTokenBar({ value, total, color }: { value: number; total: number; color: string }) {
  const pct = total > 0 ? Math.max(2, (value / total) * 100) : 0;
  return (
    <span className="relative inline-block h-2 w-12 overflow-hidden rounded-full bg-muted/50 align-middle ring-1 ring-inset ring-border/20">
      <span
        className="absolute inset-y-0 left-0 rounded-full transition-all duration-700 ease-out"
        style={{ width: `${Math.min(100, pct)}%`, backgroundColor: color }}
      />
    </span>
  );
}

export function ContextBreakdownModal({ open, onClose }: ContextBreakdownModalProps) {
  const wsUrl = useConfigStore((s) => s.wsUrl);
  const { lastInputTokens, maxContext, cacheStats } = useSessionStore(
    useShallow((s) => ({
      lastInputTokens: s.lastInputTokens,
      maxContext: s.maxContext,
      cacheStats: s.cacheStats,
    })),
  );
  const { t } = useAppTranslation();

  // Subscribe-and-poll the server's `context.debug` payload for the
  // lifetime of the open modal. The hook owns the WS subscription,
  // visibility-paused polling cadence, and refresh-button lifecycle;
  // cacheStats / lastInputTokens / maxContext flow in reactively from
  // useSessionStore (the /stats slash command and provider.response
  // events keep those store fields fresh).
  const { data, loading, error, refresh } = useLiveContextDebug(wsUrl, { active: open });

  const [animateIn, setAnimateIn] = useState(false);

  // Stagger entrance animation only on the open transition, not on a
  // refresh that bumps the hook's internal generation counter.
  useEffect(() => {
    if (!open) {
      setAnimateIn(false);
      return;
    }
    requestAnimationFrame(() => requestAnimationFrame(() => setAnimateIn(true)));
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // ── Category tokens for the composition ring ──
  const categories = useMemo(() => {
    if (!data) return null;
    return [
      {
        label: t('activity:ctxDash.systemPrompt'),
        key: 'systemPrompt',
        value: data.systemPrompt,
        color: 'hsl(var(--info))',
      },
      {
        label: t('activity:ctxDash.tools'),
        key: 'tools',
        value: data.tools.total,
        color: 'hsl(var(--warning))',
      },
      {
        label: t('activity:ctxDash.messages'),
        key: 'messages',
        value: data.messages.total,
        color: 'hsl(var(--success))',
      },
    ];
  }, [data]);

  // ── Cache coverage section (hoisted to keep the JSX parser happy). ──
  const cacheCoverageSection =
    cacheStats && cacheStats.coverageTokens > 0 && maxContext > 0 ? (
      <section>
        <div className="flex items-center gap-2 mb-2">
          <Zap className="h-4 w-4 text-success" />
          <span className="text-xs font-bold uppercase tracking-wider text-foreground/80">
            Cache coverage
          </span>
          <span className="text-[10px] text-muted-foreground ml-auto">
            {fmtTok(cacheStats.coverageTokens)} of {fmtTok(maxContext)} (
            {((cacheStats.coverageTokens / maxContext) * 100).toFixed(1)}%)
          </span>
        </div>
        <div className="h-3 w-full overflow-hidden rounded-full bg-muted/50 ring-1 ring-inset ring-border/20">
          <div
            className="h-full rounded-full bg-success transition-all duration-700 ease-out"
            style={{ width: `${Math.max(2, (cacheStats.coverageTokens / maxContext) * 100)}%` }}
            title={`Cached prefix: ${fmtTok(cacheStats.coverageTokens)} of ${fmtTok(maxContext)}`}
          />
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">
          The first {fmtTok(cacheStats.coverageTokens)} of this prompt are served from the provider
          cache; everything past that boundary is fresh and billed at full input rate.
        </p>
      </section>
    ) : null;

  if (!open) return null;

  const ctxPct =
    maxContext > 0 && lastInputTokens > 0
      ? Math.min(100, Math.round((lastInputTokens / maxContext) * 100))
      : 0;

  return (
    <div
      className={cn(
        'fixed inset-0 z-50 flex items-start justify-center pt-[6dvh] bg-black/40 backdrop-blur-sm transition-opacity duration-300',
        animateIn ? 'opacity-100' : 'opacity-0',
      )}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('activity:context.title')}
        className={cn(
          'w-full max-w-3xl max-h-[85dvh] overflow-hidden rounded-xl border bg-card shadow-2xl',
          'flex flex-col',
          'transition-all duration-300',
          animateIn ? 'translate-y-0 scale-100' : 'translate-y-4 scale-[0.97]',
        )}
      >
        {/* ── Header ── */}
        <div className="flex items-center justify-between border-b px-4 py-3 shrink-0">
          <h3 className="text-sm font-semibold flex items-center gap-2">
            <BarChart3 className="h-4 w-4 text-primary" />
            {t('activity:context.title')}
          </h3>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={refresh}
              className="p-1.5 rounded-md hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
              title={t('activity:ctxBreakdown.refresh')}
            >
              <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label={t('common:action.close')}
              className="p-1.5 rounded-md hover:bg-accent hover:text-accent-foreground transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* ── Scrollable body ── */}
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
          <div className="p-4 space-y-5">
            {/* ── Quick summary cards ── */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <SummaryCard
                icon={AlertTriangle}
                label={t('activity:context.windowUsage')}
                value={`${fmtTok(lastInputTokens)} / ${fmtTok(maxContext)}`}
                sub={`${ctxPct}%`}
                accent={ctxPct > 85 ? 'destructive' : ctxPct > 60 ? 'warning' : 'success'}
              />
              <SummaryCard
                icon={Zap}
                label="Cache hit"
                value={
                  cacheStats && cacheStats.readTokens + cacheStats.writeTokens > 0
                    ? `${(cacheStats.hitRatio * 100).toFixed(1)}%`
                    : '—'
                }
                sub={
                  cacheStats && cacheStats.coverageTokens > 0 && maxContext > 0
                    ? `covers ${fmtTok(cacheStats.coverageTokens)}`
                    : 'prompt-cache'
                }
                accent={
                  cacheStats && cacheStats.readTokens + cacheStats.writeTokens > 0
                    ? 'success'
                    : 'default'
                }
              />
              <SummaryCard
                icon={Code2}
                label={t('activity:context.contextMode')}
                value={data?.mode ?? '—'}
                sub="mode"
                accent="default"
              />
              {data && (
                <>
                  <SummaryCard
                    icon={Wrench}
                    label={t('activity:ctxBreakdown.toolsRegistered')}
                    value={String(data.tools.count)}
                    sub={`${fmtTok(data.tools.total)} tokens`}
                    accent="default"
                  />
                  <SummaryCard
                    icon={MessageSquare}
                    label={t('activity:ctxDash.messages')}
                    value={String(data.messages.count)}
                    sub={`${fmtTok(data.messages.total)} tokens`}
                    accent="default"
                  />
                </>
              )}
            </div>

            {/* ── Loading / Error / Data ── */}
            {loading ? (
              <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground py-8">
                <RefreshCw className="h-4 w-4 animate-spin" />
                {t('activity:context.fetching')}
              </div>
            ) : error ? (
              <div className="rounded-md bg-destructive/10 border border-destructive/20 p-3 text-sm text-destructive">
                {error}
              </div>
            ) : data ? (
              <>
                {/* ── Cache coverage: how far the prompt cache extends ── */}
                {cacheCoverageSection}

                {/* ── Token allocation: composition ring + bar ── */}
                <section>
                  <div className="flex items-center gap-2 mb-2">
                    <BarChart3 className="h-4 w-4 text-primary" />
                    <span className="text-xs font-bold uppercase tracking-wider text-foreground/80">
                      {t('activity:ctxBreakdown.tokenAllocation')}
                    </span>
                    <span className="text-[10px] text-muted-foreground ml-auto">
                      {fmtTok(data.total)} total
                    </span>
                  </div>

                  <div className="flex flex-col sm:flex-row gap-4 items-start">
                    {/* Donut ring */}
                    {categories && (
                      <div className="relative shrink-0 flex items-center justify-center">
                        <svg width="96" height="96" viewBox="0 0 96 96" className="drop-shadow-md">
                          <title>Token allocation: {ctxPct}% context usage</title>
                          {(() => {
                            const total = categories.reduce((s, c) => s + c.value, 0) || 1;
                            let offset = 0;
                            const r = 36;
                            const circ = 2 * Math.PI * r;
                            return categories.map((cat) => {
                              const pct = cat.value / total;
                              const len = pct * circ;
                              const dash = `${len} ${circ - len}`;
                              const seg = (
                                <circle
                                  key={cat.key}
                                  cx="48"
                                  cy="48"
                                  r={r}
                                  fill="none"
                                  stroke={cat.color}
                                  strokeWidth="10"
                                  strokeDasharray={dash}
                                  strokeDashoffset={-offset}
                                  className="transition-all duration-1000 ease-out"
                                  style={{ transformOrigin: 'center', transform: 'rotate(-90deg)' }}
                                />
                              );
                              offset += len;
                              return seg;
                            });
                          })()}
                          <circle
                            cx="48"
                            cy="48"
                            r="24"
                            fill="hsl(var(--card))"
                            className="drop-shadow-sm"
                          />
                          <text
                            x="48"
                            y="48"
                            textAnchor="middle"
                            dominantBaseline="central"
                            fill="currentColor"
                            className="text-[10px] font-bold font-mono tabular-nums"
                          >
                            {ctxPct}%
                          </text>
                        </svg>
                      </div>
                    )}

                    {/* Legend + fill bar */}
                    <div className="flex-1 min-w-0 space-y-2 w-full">
                      {/* Segmented fill bar */}
                      <div className="h-3 w-full overflow-hidden rounded-full bg-muted/50 flex ring-1 ring-inset ring-border/20">
                        {data.total > 0 &&
                          categories &&
                          categories.map((category) => (
                            <span
                              key={category.key}
                              className="h-full transition-all duration-700 last:rounded-r-full"
                              style={{
                                width: `${(category.value / data.total) * 100}%`,
                                backgroundColor: category.color,
                              }}
                              title={`${category.label}: ${fmtTok(category.value)}`}
                            />
                          ))}
                      </div>

                      {/* Legend */}
                      <div className="grid grid-cols-3 gap-1 text-[10px]">
                        {categories?.map((cat) => {
                          const pct =
                            data.total > 0 ? ((cat.value / data.total) * 100).toFixed(1) : '0';
                          return (
                            <div key={cat.key} className="flex items-center gap-1.5">
                              <span
                                className="w-2 h-2 rounded-full shrink-0"
                                style={{ backgroundColor: cat.color }}
                              />
                              <span className="text-muted-foreground truncate">{cat.label}</span>
                              <span className="font-mono tabular-nums ml-auto">{pct}%</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                </section>

                {/* ── Tool breakdown (unpaginated, scrollable) ── */}
                {data.tools.breakdown.length > 0 && (
                  <section>
                    <div className="flex items-center gap-2 mb-2">
                      <Wrench className="h-4 w-4 text-warning" />
                      <span className="text-xs font-bold uppercase tracking-wider text-foreground/80">
                        {t('activity:ctxBreakdown.toolBreakdown')}
                      </span>
                      <span className="text-[10px] text-muted-foreground ml-auto">
                        {data.tools.breakdown.length} tools · {fmtTok(data.tools.total)} tokens
                      </span>
                    </div>
                    <div className="max-h-48 overflow-y-auto overscroll-contain space-y-0.5 rounded-lg border bg-muted/20 p-2">
                      {data.tools.breakdown.map((t) => {
                        const pct = data.tools.total > 0 ? (t.tokens / data.tools.total) * 100 : 0;
                        return (
                          <div
                            key={t.name}
                            className={cn(
                              'flex items-center gap-2 text-xs py-1 px-2 rounded',
                              'hover:bg-muted/40 transition-colors',
                            )}
                          >
                            <span className="font-mono truncate flex-1 text-foreground/80">
                              {t.name}
                            </span>
                            <MiniTokenBar
                              value={t.tokens}
                              total={data.tools.total}
                              color="hsl(var(--warning))"
                            />
                            <span
                              className={cn(
                                'tabular-nums w-16 text-right font-mono',
                                tokenColor(t.tokens, data.tools.total),
                              )}
                            >
                              {t.tokens.toLocaleString()}
                            </span>
                            <span className="tabular-nums w-10 text-right text-[10px] text-muted-foreground">
                              {pct.toFixed(1)}%
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </section>
                )}

                {/* ── Message breakdown (unpaginated, scrollable) ── */}
                <section>
                  <div className="flex items-center gap-2 mb-2">
                    <MessageSquare className="h-4 w-4 text-success" />
                    <span className="text-xs font-bold uppercase tracking-wider text-foreground/80">
                      {t('activity:ctxBreakdown.messageBreakdown')}
                    </span>
                    <span className="text-[10px] text-muted-foreground ml-auto">
                      {data.messages.count} messages · {fmtTok(data.messages.total)} tokens
                    </span>
                  </div>
                  <div className="max-h-64 overflow-y-auto overscroll-contain space-y-0.5 rounded-lg border bg-muted/20 p-2">
                    {data.messages.breakdown.map((m) => {
                      return (
                        <div
                          key={m.index}
                          className={cn(
                            'flex items-center gap-2 text-xs py-1 px-2 rounded',
                            'hover:bg-muted/40 transition-colors',
                          )}
                        >
                          <span className="font-mono text-muted-foreground w-6 text-right shrink-0">
                            {m.index}
                          </span>
                          <span
                            className={cn(
                              'font-mono w-14 shrink-0 px-1 rounded text-center text-[10px] font-semibold',
                              m.role === 'assistant'
                                ? 'bg-accent/30 text-accent-foreground'
                                : m.role === 'user'
                                  ? 'bg-primary/10 text-primary'
                                  : m.role === 'tool'
                                    ? 'bg-warning/10 text-warning'
                                    : 'bg-muted/50 text-muted-foreground',
                            )}
                          >
                            {m.role}
                          </span>
                          <MiniTokenBar
                            value={m.tokens}
                            total={data.messages.total}
                            color={
                              m.role === 'assistant'
                                ? 'hsl(var(--accent-foreground))'
                                : m.role === 'user'
                                  ? 'hsl(var(--primary))'
                                  : 'hsl(var(--warning))'
                            }
                          />
                          <span
                            className={cn(
                              'tabular-nums w-14 text-right font-mono shrink-0',
                              tokenColor(m.tokens, data.messages.total),
                            )}
                          >
                            {m.tokens.toLocaleString()}
                          </span>
                          <span className="text-muted-foreground/70 truncate flex-1 min-w-0">
                            {m.preview.slice(0, 100)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </section>
              </>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Small summary stat card. */
function SummaryCard({
  icon: Icon,
  label,
  value,
  sub,
  accent,
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  sub: string;
  accent: 'default' | 'destructive' | 'warning' | 'success';
}) {
  const accentColors: Record<string, string> = {
    destructive: 'border-destructive/30 bg-destructive/5 text-destructive',
    warning: 'border-warning/30 bg-warning/5 text-warning',
    success: 'border-success/30 bg-success/5 text-success',
    default: 'border-border/50 bg-muted/30 text-muted-foreground',
  };
  return (
    <div
      className={cn(
        'rounded-lg border px-3 py-2.5 transition-all duration-300 hover:shadow-sm',
        accentColors[accent],
      )}
    >
      <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground mb-1">
        <Icon className="h-3 w-3" />
        <span className="truncate">{label}</span>
      </div>
      <div className="text-sm font-mono font-bold tabular-nums tracking-tight">{value}</div>
      <div className="text-[10px] text-muted-foreground/70 mt-0.5">{sub}</div>
    </div>
  );
}
