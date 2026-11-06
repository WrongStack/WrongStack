import type {
  CacheBreakerKind,
  CacheLane,
  CacheVerdict,
  HistoryRetention,
  RequestResidency,
  ResidencySegmentKind,
  RetentionClass,
} from '@wrongstack/core/utils/residency-labels';
import { CACHE_LANE_ORDER, RETENTION_CLASSES } from '@wrongstack/core/utils/residency-labels';
import { Archive, Database } from 'lucide-react';
import { fmtTok } from '../lib/dashboard-primitives';
import { displayLocale, useAppTranslation } from '../lib/i18n';
import { cn } from '../lib/utils';
import { SectionCard } from './context-dashboard-primitives';

/**
 * Cache residency + history retention for the WebUI context dashboard. The
 * data comes from the server's `context.debug` payload, which carries the same
 * core snapshots (`getRequestResidency` / `getHistoryRetention`) the CLI
 * `/context residency` report and the TUI Residency tab render.
 */

const LANES: Record<CacheLane, { labelKey: string; hintKey: string; bar: string; text: string }> = {
  cached: {
    labelKey: 'activity:ctxDash.laneCached',
    hintKey: 'activity:ctxDash.laneCachedHint',
    bar: 'bg-success',
    text: 'text-success',
  },
  written: {
    labelKey: 'activity:ctxDash.laneWritten',
    hintKey: 'activity:ctxDash.laneWrittenHint',
    bar: 'bg-warning',
    text: 'text-warning',
  },
  uncached: {
    labelKey: 'activity:ctxDash.laneUncached',
    hintKey: 'activity:ctxDash.laneUncachedHint',
    bar: 'bg-muted-foreground/40',
    text: 'text-muted-foreground',
  },
};

const SEGMENTS: Record<ResidencySegmentKind, { labelKey: string }> = {
  tools: { labelKey: 'activity:ctxDash.segTools' },
  system: { labelKey: 'activity:ctxDash.segSystem' },
  'history-prior': { labelKey: 'activity:ctxDash.segHistoryPrior' },
  'history-new': { labelKey: 'activity:ctxDash.segHistoryNew' },
  'live-snapshots': { labelKey: 'activity:ctxDash.segLiveSnapshots' },
  'live-tail': { labelKey: 'activity:ctxDash.segLiveTail' },
  'request-scoped': { labelKey: 'activity:ctxDash.segRequestScoped' },
};

const VERDICTS: Record<CacheVerdict, { labelKey: string; text: string }> = {
  pending: { labelKey: 'activity:ctxDash.verdictPending', text: 'text-muted-foreground' },
  cold: { labelKey: 'activity:ctxDash.verdictCold', text: 'text-warning' },
  hit: { labelKey: 'activity:ctxDash.verdictHit', text: 'text-success' },
  partial: { labelKey: 'activity:ctxDash.verdictPartial', text: 'text-warning' },
  miss: { labelKey: 'activity:ctxDash.verdictMiss', text: 'text-destructive' },
  unsupported: { labelKey: 'activity:ctxDash.verdictUnsupported', text: 'text-muted-foreground' },
};

const BREAKERS: Record<CacheBreakerKind, { labelKey: string }> = {
  route: { labelKey: 'activity:ctxDash.breakerRoute' },
  tools: { labelKey: 'activity:ctxDash.breakerTools' },
  system: { labelKey: 'activity:ctxDash.breakerSystem' },
  history: { labelKey: 'activity:ctxDash.breakerHistory' },
  idle: { labelKey: 'activity:ctxDash.breakerIdle' },
  provider: { labelKey: 'activity:ctxDash.breakerProvider' },
};

const RETENTION: Record<RetentionClass, { labelKey: string; text: string }> = {
  protected: { labelKey: 'activity:ctxDash.retProtected', text: 'text-success' },
  'elision-candidate': { labelKey: 'activity:ctxDash.retElisionCandidate', text: 'text-warning' },
  compactable: { labelKey: 'activity:ctxDash.retCompactable', text: 'text-foreground' },
  elided: { labelKey: 'activity:ctxDash.retElided', text: 'text-muted-foreground' },
  digest: { labelKey: 'activity:ctxDash.retDigest', text: 'text-info' },
};

function pct(n: number, total: number): string {
  return total > 0 ? `${Math.round((n / total) * 100)}%` : '0%';
}

function RequestResidencyView({ residency: r }: { residency: RequestResidency }) {
  const { t } = useAppTranslation();
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
        <span className="font-mono text-muted-foreground">
          #{r.seq} · {r.providerId}/{r.model} · {r.mechanism}
        </span>
        <span className={cn('font-medium', VERDICTS[r.verdict].text)}>
          {t(VERDICTS[r.verdict].labelKey)}
        </span>
      </div>

      {/* Stacked lane bar in wire order */}
      <div
        className="h-3 w-full overflow-hidden rounded-full bg-muted flex"
        role="img"
        aria-label={CACHE_LANE_ORDER.map(
          (lane) => `${t(LANES[lane].labelKey)} ${pct(r.lanes[lane], r.total)}`,
        ).join(', ')}
      >
        {r.segments.map((seg) => {
          const width = r.total > 0 ? (seg.tokens / r.total) * 100 : 0;
          if (width <= 0) return null;
          return (
            <span
              key={seg.kind}
              className={cn('h-full border-r border-background/60', LANES[seg.lane].bar)}
              style={{ width: `${width}%` }}
              title={`${t(SEGMENTS[seg.kind].labelKey)} · ${fmtTok(seg.tokens)}`}
            />
          );
        })}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
        {CACHE_LANE_ORDER.filter((lane) => r.lanes[lane] > 0).map((lane) => (
          <span key={lane} className={LANES[lane].text} title={t(LANES[lane].hintKey)}>
            {t(LANES[lane].labelKey)} {fmtTok(r.lanes[lane])} ({pct(r.lanes[lane], r.total)})
          </span>
        ))}
      </div>

      <table className="w-full text-xs">
        <tbody>
          {r.segments.map((seg) => (
            <tr key={seg.kind} className="align-top">
              <td className="py-0.5 pr-2">
                <span
                  className={cn('mr-1.5 inline-block h-2 w-2 rounded-sm', LANES[seg.lane].bar)}
                />
                {t(SEGMENTS[seg.kind].labelKey)}
                {seg.parts && seg.parts.length > 0 ? (
                  <div className="pl-3.5 text-[11px] text-muted-foreground">
                    {seg.parts.map((p) => `${p.source} ${fmtTok(p.tokens)}`).join(' · ')}
                  </div>
                ) : null}
              </td>
              <td className="py-0.5 pr-2 text-right font-mono tabular-nums">
                {fmtTok(seg.tokens)}
              </td>
              <td className={cn('py-0.5 text-right', LANES[seg.lane].text)}>
                {t(LANES[seg.lane].labelKey)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {r.actual ? (
        <div className="text-[11px] text-muted-foreground">
          {t('activity:ctxDash.residencyProvider', {
            read: fmtTok(r.actual.cacheRead),
            write: fmtTok(r.actual.cacheWrite),
            fresh: fmtTok(r.actual.input),
            pct: pct(r.actual.cacheRead, r.actual.total),
            expected: pct(r.lanes.cached, r.total),
          })}
        </div>
      ) : null}
      {r.breakers.map((b) => (
        <div key={b.kind} className="text-[11px]">
          <span className="text-warning">↯ {t(BREAKERS[b.kind].labelKey)}</span>
          <span className="text-muted-foreground"> — {b.detail}</span>
        </div>
      ))}
      <div className="text-[11px] text-muted-foreground">
        {r.next.rewritten
          ? t('activity:ctxDash.residencyNextRewritten')
          : t('activity:ctxDash.residencyNext', {
              count: r.next.pendingMessages,
              tokens: fmtTok(r.next.pendingTokens),
            })}
      </div>
    </div>
  );
}

function RetentionView({ retention: h }: { retention: HistoryRetention }) {
  const { t } = useAppTranslation();
  const present = RETENTION_CLASSES.filter((c) => h.classes[c].messages > 0);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 text-xs font-medium">
        <Archive className="h-3.5 w-3.5 text-muted-foreground" />
        {t('activity:ctxDash.retentionTitle')}
      </div>
      <div className="text-[11px] text-muted-foreground">
        {t('activity:ctxDash.retentionPolicy', {
          k: h.preserveK,
          threshold: h.eliseThreshold.toLocaleString(displayLocale()),
        })}
      </div>
      {present.length === 0 ? (
        <div className="text-xs text-muted-foreground">{t('activity:ctxDash.retentionEmpty')}</div>
      ) : (
        <table className="w-full text-xs">
          <tbody>
            {present.map((c) => (
              <tr key={c}>
                <td className={cn('py-0.5 pr-2', RETENTION[c].text)}>{t(RETENTION[c].labelKey)}</td>
                <td className="py-0.5 pr-2 text-right font-mono tabular-nums">
                  {fmtTok(h.classes[c].tokens)}
                </td>
                <td className="py-0.5 text-right text-muted-foreground">
                  {h.classes[c].messages} · {pct(h.classes[c].tokens, h.total)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function ResidencySection({
  residency,
  retention,
}: {
  residency: RequestResidency | undefined;
  retention: HistoryRetention | undefined;
}) {
  const { t } = useAppTranslation();
  return (
    <SectionCard title={t('activity:ctxDash.residencyTitle')} icon={Database}>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          {residency ? (
            <RequestResidencyView residency={residency} />
          ) : (
            <div className="text-xs text-muted-foreground py-1">
              {t('activity:ctxDash.residencyEmpty')}
            </div>
          )}
        </div>
        <div>{retention ? <RetentionView retention={retention} /> : null}</div>
      </div>
    </SectionCard>
  );
}
