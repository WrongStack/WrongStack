import { getWSClient } from '@/lib/ws-client';
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
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppTranslation, i18n } from '@/i18n';
import { cn } from '@/lib/utils';

/** Debug payload from context.debug WS response. */
interface ContextDebugPayload {
  total: number;
  mode?: string | undefined;
  policy?: unknown | undefined;
  systemPrompt: number;
  tools: { total: number; count: number; breakdown: Array<{ name: string; tokens: number }> };
  messages: {
    total: number;
    count: number;
    breakdown: Array<{ index: number; role: string; tokens: number; preview: string }>;
  };
}

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
  const { lastInputTokens, maxContext } = useSessionStore(
    useShallow((s) => ({ lastInputTokens: s.lastInputTokens, maxContext: s.maxContext })),
  );
  const { t } = useAppTranslation();

  const [data, setData] = useState<ContextDebugPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [animateIn, setAnimateIn] = useState(false);
  // Increment to restart the debug-data fetch (refresh button).
  const [refreshGen, setRefreshGen] = useState(0);

  // Fetch debug data when modal opens or refresh is requested
  useEffect(() => {
    if (!open) {
      setData(null);
      setError(null);
      setAnimateIn(false);
      setRefreshGen(0);
      return;
    }

    // Stagger entrance animation (only on open, not on refresh)
    if (refreshGen === 0) {
      requestAnimationFrame(() => requestAnimationFrame(() => setAnimateIn(true)));
    }

    setLoading(true);
    setError(null);
    setData(null);

    const ws = getWSClient(wsUrl);
    if (!ws?.send) {
      setError(i18n.t('activity:context.wsNotConnected'));
      setLoading(false);
      return;
    }

    ws.send({ type: 'context.debug' }, { echoToChat: false });

    let cancelled = false;

    const handler = (msg: { type: string; payload?: unknown }) => {
      if (cancelled) return;
      if (msg.type === 'context.debug') {
        cancelled = true;
        setData(msg.payload as ContextDebugPayload);
        setLoading(false);
      }
    };

    const unsubscribe = ws.on('context.debug', handler);

    const timeout = setTimeout(() => {
      if (cancelled) return;
      cancelled = true;
      setLoading(false);
      setError(i18n.t('activity:context.noData'));
      unsubscribe();
    }, 5000);

    return () => {
      cancelled = true;
      clearTimeout(timeout);
      unsubscribe();
    };
  }, [open, wsUrl, refreshGen]);

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
      { label: 'System Prompt', key: 'systemPrompt', value: data.systemPrompt, color: '#3b82f6' },
      { label: 'Tools', key: 'tools', value: data.tools.total, color: '#eab308' },
      { label: 'Messages', key: 'messages', value: data.messages.total, color: '#22c55e' },
    ];
  }, [data]);

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
              onClick={() => setRefreshGen((g) => g + 1)}
              className="p-1.5 rounded-md hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
              title="Refresh"
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
                    label="Tools registered"
                    value={String(data.tools.count)}
                    sub={`${fmtTok(data.tools.total)} tokens`}
                    accent="default"
                  />
                  <SummaryCard
                    icon={MessageSquare}
                    label="Messages"
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

                {/* ── Token allocation: composition ring + bar ── */}
                <section>
                  <div className="flex items-center gap-2 mb-2">
                    <BarChart3 className="h-4 w-4 text-primary" />
                    <span className="text-xs font-bold uppercase tracking-wider text-foreground/80">
                      Token Allocation
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
                          <circle cx="48" cy="48" r="24" fill="hsl(var(--card))" className="drop-shadow-sm" />
                          <text
                            x="48" y="48" textAnchor="middle" dominantBaseline="central"
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
                        {data.total > 0 && categories && (
                          <>
                            <span
                              className="h-full transition-all duration-700"
                              style={{ width: `${(data.systemPrompt / data.total) * 100}%`, backgroundColor: '#3b82f6' }}
                              title={`System Prompt: ${fmtTok(data.systemPrompt)}`}
                            />
                            <span
                              className="h-full transition-all duration-700"
                              style={{ width: `${(data.tools.total / data.total) * 100}%`, backgroundColor: '#eab308' }}
                              title={`Tools: ${fmtTok(data.tools.total)}`}
                            />
                            <span
                              className="h-full transition-all duration-700 rounded-r-full"
                              style={{ width: `${(data.messages.total / data.total) * 100}%`, backgroundColor: '#22c55e' }}
                              title={`Messages: ${fmtTok(data.messages.total)}`}
                            />
                          </>
                        )}
                      </div>

                      {/* Legend */}
                      <div className="grid grid-cols-3 gap-1 text-[10px]">
                        {categories?.map((cat) => {
                          const pct = data.total > 0 ? ((cat.value / data.total) * 100).toFixed(1) : '0';
                          return (
                            <div key={cat.key} className="flex items-center gap-1.5">
                              <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: cat.color }} />
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
                        Tool Breakdown
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
                            <span className="font-mono truncate flex-1 text-foreground/80">{t.name}</span>
                            <MiniTokenBar value={t.tokens} total={data.tools.total} color="#eab308" />
                            <span className={cn('tabular-nums w-16 text-right font-mono', tokenColor(t.tokens, data.tools.total))}>
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
                      Message Breakdown
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
                          <MiniTokenBar value={m.tokens} total={data.messages.total} color={
                            m.role === 'assistant' ? '#a78bfa' : m.role === 'user' ? '#60a5fa' : '#facc15'
                          } />
                          <span className={cn('tabular-nums w-14 text-right font-mono shrink-0', tokenColor(m.tokens, data.messages.total))}>
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
    <div className={cn('rounded-lg border px-3 py-2.5 transition-all duration-300 hover:shadow-sm', accentColors[accent])}>
      <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground mb-1">
        <Icon className="h-3 w-3" />
        <span className="truncate">{label}</span>
      </div>
      <div className="text-sm font-mono font-bold tabular-nums tracking-tight">{value}</div>
      <div className="text-[10px] text-muted-foreground/70 mt-0.5">{sub}</div>
    </div>
  );
}
