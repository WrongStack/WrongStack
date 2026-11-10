import { useMemo, useState } from 'react';
import { fmtTok } from '../lib/dashboard-primitives';
import { displayLocale, useAppTranslation } from '../lib/i18n';
import type { ChronicleEventView } from './chronicle-types';
import {
  buildContextTimeline,
  type ContextLane,
  type ContextMark,
  type ContextMarkKind,
  type ContextPoint,
  indexAt,
} from './session-context-timeline';

/**
 * Story → Context: the context window over the session. One stacked bar per
 * answered request (provider-reported cache read / cache write / fresh input),
 * the estimated request size as a line, the window as a ceiling, and markers where content
 * left the window (compaction, trims, repair, rewind). A ledger underneath
 * reads the same data as "what came in, what went out".
 */

const LANE_FILL: Record<ContextLane, string> = {
  cached: 'hsl(var(--success))',
  written: 'hsl(var(--warning))',
  uncached: 'hsl(var(--muted-foreground) / 0.45)',
};
const LANE_ORDER: ContextLane[] = ['cached', 'written', 'uncached'];
const LANE_KEY: Record<ContextLane, { labelKey: string; hintKey: string; text: string }> = {
  cached: {
    labelKey: 'activity:ctxDash.laneCached',
    hintKey: 'activity:story.contextCachedHint',
    text: 'text-success',
  },
  written: {
    labelKey: 'activity:ctxDash.laneWritten',
    hintKey: 'activity:story.contextWrittenHint',
    text: 'text-warning',
  },
  uncached: {
    labelKey: 'activity:ctxDash.laneUncached',
    hintKey: 'activity:story.contextUncachedHint',
    text: 'text-muted-foreground',
  },
};
const MARK_STYLE: Record<ContextMarkKind, { color: string; labelKey: string }> = {
  compaction: { color: 'hsl(var(--destructive))', labelKey: 'activity:story.markCompaction' },
  trim: { color: 'hsl(var(--brand-orange))', labelKey: 'activity:story.markTrim' },
  repair: { color: 'hsl(var(--info))', labelKey: 'activity:story.markRepair' },
  rewind: { color: 'hsl(var(--primary))', labelKey: 'activity:story.markRewind' },
  failed: { color: 'hsl(var(--destructive))', labelKey: 'activity:story.markFailed' },
};
const SEGMENT_KEY: Partial<Record<string, { labelKey: string }>> = {
  tools: { labelKey: 'activity:ctxDash.segTools' },
  system: { labelKey: 'activity:ctxDash.segSystem' },
  'history-prior': { labelKey: 'activity:ctxDash.segHistoryPrior' },
  'history-new': { labelKey: 'activity:ctxDash.segHistoryNew' },
  'live-snapshots': { labelKey: 'activity:ctxDash.segLiveSnapshots' },
  'live-tail': { labelKey: 'activity:ctxDash.segLiveTail' },
  'request-scoped': { labelKey: 'activity:ctxDash.segRequestScoped' },
};
/** A segment's translated name; kinds without a catalog entry show as they are. */
function segmentLabel(kind: string, t: (key: string) => string): string {
  const key = SEGMENT_KEY[kind];
  return key ? t(key.labelKey) : kind;
}
const VERDICT_KEY: Record<string, { labelKey: string }> = {
  pending: { labelKey: 'activity:ctxDash.verdictPending' },
  cold: { labelKey: 'activity:ctxDash.verdictCold' },
  hit: { labelKey: 'activity:ctxDash.verdictHit' },
  partial: { labelKey: 'activity:ctxDash.verdictPartial' },
  miss: { labelKey: 'activity:ctxDash.verdictMiss' },
  unsupported: { labelKey: 'activity:ctxDash.verdictUnsupported' },
  agent: { labelKey: 'activity:ctxDash.verdictAgent' },
};
const BREAKER_KEY: Record<string, { labelKey: string }> = {
  route: { labelKey: 'activity:ctxDash.breakerRoute' },
  tools: { labelKey: 'activity:ctxDash.breakerTools' },
  system: { labelKey: 'activity:ctxDash.breakerSystem' },
  history: { labelKey: 'activity:ctxDash.breakerHistory' },
  idle: { labelKey: 'activity:ctxDash.breakerIdle' },
  provider: { labelKey: 'activity:ctxDash.breakerProvider' },
};

const WIDTH = 1100;
const MIN_BAR_SLOT = 36;
const HEIGHT = 260;
const LEFT = 56;
const RIGHT = 16;
const TOP = 22;
const BOTTOM = 26;

function clock(at: number): string {
  return new Date(at).toLocaleTimeString(displayLocale(), {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}
function pct(n: number, total: number): string {
  return total > 0 ? `${Math.round((n / total) * 100)}%` : '—';
}
function laneTokens(point: ContextPoint, laneId: ContextLane): number {
  if (laneId === 'cached') return point.cacheRead;
  if (laneId === 'written') return point.cacheWrite;
  return Math.max(0, point.usage - point.cacheRead - point.cacheWrite);
}

type LedgerRow = { at: number; point?: ContextPoint; mark?: ContextMark };

export function ContextTimeline({ events }: { events: readonly ChronicleEventView[] }) {
  const { t } = useAppTranslation();
  const [agent, setAgent] = useState<string | undefined>(undefined);
  const [scale, setScale] = useState<'fit' | 'window'>('fit');
  const [selected, setSelected] = useState<string | null>(null);
  const timeline = useMemo(() => buildContextTimeline(events, agent), [events, agent]);
  const { points, marks } = timeline;

  const ledger = useMemo<LedgerRow[]>(
    () =>
      [
        ...points.map((point) => ({ at: point.at, point })),
        ...marks.map((mark) => ({ at: mark.at, mark })),
      ]
        .sort((a, b) => b.at - a.at)
        .slice(0, 80),
    [points, marks],
  );

  if (points.length === 0) {
    return (
      <section className="rounded-2xl border border-border bg-card p-6 text-sm text-muted-foreground">
        <h2 className="mb-1 font-semibold text-foreground">{t('activity:story.contextTitle')}</h2>
        {t('activity:story.contextEmpty')}
      </section>
    );
  }

  const ceiling =
    scale === 'window' && timeline.maxContext > 0
      ? Math.max(timeline.maxContext, timeline.peak)
      : Math.max(1, timeline.peak) * 1.12;
  const chartWidth = Math.max(WIDTH, LEFT + RIGHT + points.length * MIN_BAR_SLOT);
  const plotW = chartWidth - LEFT - RIGHT;
  const plotH = HEIGHT - TOP - BOTTOM;
  const slot = plotW / points.length;
  const barW = Math.max(1, Math.min(28, slot * 0.72));
  const xAt = (index: number) => LEFT + (index + 0.5) * slot;
  const yAt = (tokens: number) => TOP + plotH - (Math.min(tokens, ceiling) / ceiling) * plotH;
  const windowVisible = timeline.maxContext > 0 && timeline.maxContext <= ceiling;
  const layoutLine = points
    .map((p, i) => (p.total > 0 ? `${xAt(i).toFixed(1)},${yAt(p.total).toFixed(1)}` : ''))
    .filter(Boolean)
    .join(' ');
  const focus = points.find((p) => p.id === selected) ?? points[points.length - 1];
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * ceiling);

  return (
    <section className="space-y-4 rounded-2xl border border-border bg-card p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">{t('activity:story.contextTitle')}</h2>
          <p className="text-xs text-muted-foreground">{t('activity:story.contextSubtitle')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {timeline.agents.length > 1 && (
            <label className="flex items-center gap-1.5">
              {t('activity:story.contextAgent')}
              <select
                value={timeline.agent}
                onChange={(event) => {
                  setAgent(event.target.value);
                  setSelected(null);
                }}
                className="rounded-md border bg-background px-2 py-1"
              >
                {timeline.agents.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="flex rounded-md border p-0.5">
            {(['fit', 'window'] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={scale === value}
                disabled={value === 'window' && timeline.maxContext <= 0}
                onClick={() => setScale(value)}
                className={`rounded px-2 py-0.5 ${scale === value ? 'bg-info/15 text-info' : 'text-muted-foreground'}`}
              >
                {value === 'fit'
                  ? t('activity:story.contextScaleFit')
                  : t('activity:story.contextScaleWindow')}
              </button>
            ))}
          </div>
        </div>
      </header>

      <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-5">
        {[
          [t('activity:story.contextRequests'), points.length.toLocaleString(displayLocale())],
          [t('activity:story.contextPeak'), fmtTok(timeline.peak)],
          [
            t('activity:story.contextWindow'),
            timeline.maxContext > 0 ? fmtTok(timeline.maxContext) : '—',
          ],
          [t('activity:story.contextCacheRead'), `${Math.round(timeline.cacheRate * 100)}%`],
          [t('activity:story.contextRemoved'), fmtTok(timeline.removedTotal)],
        ].map(([label, value]) => (
          <div key={label} className="rounded-xl border border-border/70 bg-background/60 p-2">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="text-base font-semibold tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>

      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${chartWidth} ${HEIGHT}`}
          className="min-w-[640px] w-full"
          style={chartWidth > WIDTH ? { minWidth: chartWidth } : undefined}
          role="img"
          aria-label={t('activity:story.contextTitle')}
        >
          {ticks.map((tick) => (
            <g key={tick}>
              <line
                x1={LEFT}
                x2={chartWidth - RIGHT}
                y1={yAt(tick)}
                y2={yAt(tick)}
                stroke="hsl(var(--border))"
                strokeWidth={0.6}
              />
              <text
                x={LEFT - 6}
                y={yAt(tick) + 3}
                textAnchor="end"
                fontSize={10}
                fill="hsl(var(--muted-foreground))"
              >
                {fmtTok(tick)}
              </text>
            </g>
          ))}
          {windowVisible && (
            <g>
              <line
                x1={LEFT}
                x2={chartWidth - RIGHT}
                y1={yAt(timeline.maxContext)}
                y2={yAt(timeline.maxContext)}
                stroke="hsl(var(--destructive))"
                strokeDasharray="6 4"
                strokeWidth={1}
              />
              <text
                x={chartWidth - RIGHT}
                y={yAt(timeline.maxContext) - 4}
                textAnchor="end"
                fontSize={10}
                fill="hsl(var(--destructive))"
              >
                {t('activity:story.contextWindowLine')}
              </text>
            </g>
          )}
          {points.map((point, index) => {
            let base = 0;
            return (
              // biome-ignore lint/a11y/useSemanticElements: SVG has no native button; bars support keyboard input and the ledger provides equivalent HTML buttons.
              <g
                key={point.id}
                className="cursor-pointer"
                role="button"
                tabIndex={0}
                aria-label={`#${point.seq} · ${fmtTok(point.usage)}`}
                onClick={() => setSelected(point.id)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return;
                  event.preventDefault();
                  setSelected(point.id);
                }}
                opacity={focus && focus.id !== point.id && selected ? 0.55 : 1}
              >
                <title>
                  {`#${point.seq} · ${clock(point.at)} · ${fmtTok(point.usage)} · ${t(
                    VERDICT_KEY[point.verdict]?.labelKey ?? 'activity:ctxDash.verdictPending',
                  )}`}
                </title>
                {LANE_ORDER.map((laneId) => {
                  const tokens = laneTokens(point, laneId);
                  if (tokens <= 0) return null;
                  const y0 = yAt(base);
                  base += tokens;
                  const y1 = yAt(base);
                  return (
                    <rect
                      key={laneId}
                      x={xAt(index) - barW / 2}
                      y={y1}
                      width={barW}
                      height={Math.max(0.5, y0 - y1)}
                      fill={LANE_FILL[laneId]}
                    />
                  );
                })}
              </g>
            );
          })}
          {layoutLine && (
            <polyline
              points={layoutLine}
              fill="none"
              stroke="hsl(var(--primary))"
              strokeWidth={1.5}
              strokeLinejoin="round"
            />
          )}
          {marks.map((mark) => {
            const x = xAt(indexAt(points, mark.at));
            const style = MARK_STYLE[mark.kind];
            return (
              <g key={mark.id}>
                <title>
                  {`${t(style.labelKey)} · ${clock(mark.at)}${mark.removed > 0 ? ` · −${fmtTok(mark.removed)}` : ''}`}
                </title>
                <line
                  x1={x}
                  x2={x}
                  y1={TOP}
                  y2={TOP + plotH}
                  stroke={style.color}
                  strokeWidth={1.2}
                  strokeDasharray="2 3"
                />
                <path
                  d={`M${x - 5},${TOP - 10} L${x + 5},${TOP - 10} L${x},${TOP - 2} Z`}
                  fill={style.color}
                />
              </g>
            );
          })}
          <text x={LEFT} y={HEIGHT - 8} fontSize={10} fill="hsl(var(--muted-foreground))">
            {clock(points[0]?.at ?? 0)}
          </text>
          <text
            x={chartWidth - RIGHT}
            y={HEIGHT - 8}
            textAnchor="end"
            fontSize={10}
            fill="hsl(var(--muted-foreground))"
          >
            {clock(points[points.length - 1]?.at ?? 0)}
          </text>
        </svg>
      </div>

      <div className="grid gap-2 text-xs sm:grid-cols-2 xl:grid-cols-4">
        {LANE_ORDER.map((laneId) => (
          <div key={laneId} className="rounded-lg border border-border/70 bg-background/60 p-2">
            <div className={`flex items-center gap-1.5 font-medium ${LANE_KEY[laneId].text}`}>
              <span
                className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
                style={{ background: LANE_FILL[laneId] }}
              />
              {t(LANE_KEY[laneId].labelKey)}
            </div>
            <p className={`mt-1 text-[11px] ${LANE_KEY[laneId].text}`}>
              {t(LANE_KEY[laneId].hintKey)}
            </p>
          </div>
        ))}
        <div className="rounded-lg border border-border/70 bg-background/60 p-2">
          <div className="flex items-center gap-1.5 font-medium text-primary">
            <span className="inline-block h-0.5 w-4 shrink-0 bg-primary" />
            {t('activity:story.contextUsageLine')}
          </div>
          <p className="mt-1 text-[11px] text-primary">{t('activity:story.contextUsageHint')}</p>
        </div>
      </div>
      {marks.length > 0 && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
          {(Object.keys(MARK_STYLE) as ContextMarkKind[])
            .filter((kind) => marks.some((m) => m.kind === kind))
            .map((kind) => (
              <span key={kind} className="flex items-center gap-1.5">
                <span style={{ color: MARK_STYLE[kind].color }}>▼</span>
                {t(MARK_STYLE[kind].labelKey)}
              </span>
            ))}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {focus && (
          <div
            data-testid="context-request-detail"
            className="rounded-xl border border-border/70 bg-background/60 p-3 text-xs"
          >
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-mono text-muted-foreground">
                #{focus.seq} · {clock(focus.at)} · {focus.provider}/{focus.model}
              </span>
              <span className="font-medium">
                {t(VERDICT_KEY[focus.verdict]?.labelKey ?? 'activity:ctxDash.verdictPending')}
              </span>
            </div>
            <div className="mb-3 space-y-1.5">
              {LANE_ORDER.map((laneId) => {
                const tokens = laneTokens(focus, laneId);
                return (
                  <div key={laneId} className="rounded-md border border-border/60 px-2 py-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <span
                        className={`flex items-center gap-1.5 font-medium ${LANE_KEY[laneId].text}`}
                      >
                        <span
                          className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
                          style={{ background: LANE_FILL[laneId] }}
                        />
                        {t(LANE_KEY[laneId].labelKey)}
                      </span>
                      <span className={`font-mono tabular-nums ${LANE_KEY[laneId].text}`}>
                        {fmtTok(tokens)} · {pct(tokens, focus.usage)}
                      </span>
                    </div>
                    <p className={`mt-0.5 text-[11px] ${LANE_KEY[laneId].text}`}>
                      {t(LANE_KEY[laneId].hintKey)}
                    </p>
                  </div>
                );
              })}
              <div className="flex items-center justify-between gap-2 px-2 text-primary">
                <span>{t('activity:story.contextUsageLine')}</span>
                <span className="font-mono tabular-nums">{fmtTok(focus.total)}</span>
              </div>
              <p className="px-2 text-[11px] text-primary">
                {t('activity:story.contextUsageHint')}
              </p>
            </div>
            {focus.mechanism === 'agent' ? (
              // An agent that keeps its own context got only the user's text:
              // there is no WrongStack layout to show, only what it reported.
              <p data-testid="context-agent-owned" className="text-[11px] text-muted-foreground">
                {t('activity:story.contextAgentOwned', {
                  read: fmtTok(focus.cacheRead),
                  write: fmtTok(focus.cacheWrite),
                  fresh: fmtTok(Math.max(0, focus.usage - focus.cacheRead - focus.cacheWrite)),
                })}
              </p>
            ) : (
              <>
                <h3 className="mb-1 font-medium">{t('activity:story.contextEstimatedLayout')}</h3>
                <table className="w-full">
                  <tbody>
                    {focus.segments.map((seg) => (
                      <tr key={seg.kind}>
                        <td className="py-0.5 pr-2">
                          <span
                            className="mr-1.5 inline-block h-2 w-2 rounded-sm"
                            style={{ background: LANE_FILL[seg.lane] }}
                          />
                          {segmentLabel(seg.kind, t)}
                        </td>
                        <td className="py-0.5 pr-2 text-right font-mono tabular-nums">
                          {fmtTok(seg.tokens)}
                        </td>
                        <td className="py-0.5 text-right text-muted-foreground">×{seg.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {focus.live.length > 0 && (
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {focus.live.map((p) => `${p.source} ${fmtTok(p.tokens)}`).join(' · ')}
                  </p>
                )}
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {t('activity:ctxDash.residencyProvider', {
                    read: fmtTok(focus.cacheRead),
                    write: fmtTok(focus.cacheWrite),
                    fresh: fmtTok(Math.max(0, focus.usage - focus.cacheRead - focus.cacheWrite)),
                    pct: pct(focus.cacheRead, focus.usage),
                    expected: pct(focus.cached, focus.total),
                  })}
                </p>
              </>
            )}
            {focus.breakers.map((b) => (
              <p key={b} className="text-[11px] text-warning">
                ↯ {BREAKER_KEY[b] ? t(BREAKER_KEY[b].labelKey) : b}
              </p>
            ))}
            {!selected && (
              <p className="mt-1 text-[11px] text-muted-foreground">
                {t('activity:story.contextSelectHint')}
              </p>
            )}
          </div>
        )}

        <div className="rounded-xl border border-border/70 bg-background/60 p-3 text-xs">
          <h3 className="mb-2 font-medium">{t('activity:story.contextLedger')}</h3>
          <ol className="max-h-72 space-y-1 overflow-y-auto">
            {ledger.map((row) =>
              row.point ? (
                <li key={row.point.id}>
                  <button
                    type="button"
                    onClick={() => setSelected(row.point?.id ?? null)}
                    className="flex w-full flex-wrap items-baseline gap-x-2 text-left hover:text-foreground"
                  >
                    <span className="font-mono text-muted-foreground">{clock(row.at)}</span>
                    <span className="text-success">
                      {t('activity:story.contextIn', { tokens: fmtTok(row.point.added) })}
                    </span>
                    <span className="text-muted-foreground">
                      {fmtTok(row.point.total)} · {pct(row.point.cacheRead, row.point.usage)}{' '}
                      {t('activity:story.contextCacheRead')}
                    </span>
                    {row.point.breakers.length > 0 && (
                      <span className="text-warning">↯ {row.point.breakers.join(', ')}</span>
                    )}
                  </button>
                </li>
              ) : row.mark ? (
                <li key={row.mark.id} className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-mono text-muted-foreground">{clock(row.at)}</span>
                  <span style={{ color: MARK_STYLE[row.mark.kind].color }}>
                    ▼ {t(MARK_STYLE[row.mark.kind].labelKey)}
                  </span>
                  {row.mark.removed > 0 && (
                    <span className="text-destructive">
                      {t('activity:story.contextOut', { tokens: fmtTok(row.mark.removed) })}
                    </span>
                  )}
                  {row.mark.before !== undefined && row.mark.after !== undefined && (
                    <span className="text-muted-foreground">
                      {fmtTok(row.mark.before)} → {fmtTok(row.mark.after)}
                    </span>
                  )}
                  {row.mark.facts.length > 0 && (
                    <span className="text-muted-foreground">{row.mark.facts.join(' · ')}</span>
                  )}
                </li>
              ) : null,
            )}
          </ol>
        </div>
      </div>
    </section>
  );
}
