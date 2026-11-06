import {
  CACHE_LANE_HINTS,
  CACHE_LANE_LABELS,
  CACHE_LANE_ORDER,
  CACHE_VERDICT_LABELS,
  RESIDENCY_SEGMENT_LABELS,
  RETENTION_LABELS,
} from '@wrongstack/core/utils/residency-labels';
import {
  historyRetention,
  percent,
  requestResidency,
  retentionRows,
} from './context-residency-model';
import { useDesktopText } from './desktop-i18n';
import { displayLocale } from './display-dates';

/**
 * How the last request was laid out for the provider cache, and what the next compaction
 * keeps. Both are engine estimates; provider-reported usage is shown only when it arrived.
 */
export function ContextResidency({
  residency: rawResidency,
  retention: rawRetention,
}: {
  residency: unknown;
  retention: unknown;
}) {
  const { t } = useDesktopText();
  const word = (group: string, key: string, fallback: Record<string, string>) =>
    t(`residency.${group}.${key}`, { defaultValue: fallback[key] ?? key });
  const residency = requestResidency(rawResidency);
  const retention = historyRetention(rawRetention);
  return (
    <>
      <details>
        <summary>
          {t('residency.layout')}
          {residency
            ? ` · ${word('verdict', residency.verdict, CACHE_VERDICT_LABELS)}`
            : ` · ${t('residency.noneRecorded')}`}
        </summary>
        {!residency ? (
          <p className="field-help">{t('residency.noRequest')}</p>
        ) : (
          <section className="context-residency" aria-label={t('residency.layoutLabel')}>
            <p className="field-help">
              {t('residency.summary', {
                route: `${residency.providerId}/${residency.model}`,
                tokens: residency.total.toLocaleString(displayLocale()),
                percent: percent(residency.expectedCacheRatio, 1),
              })}
              {residency.actual
                ? t('residency.actual', {
                    read: residency.actual.cacheRead.toLocaleString(displayLocale()),
                    total: residency.actual.total.toLocaleString(displayLocale()),
                    percent: percent(residency.actual.cacheRatio, 1),
                  })
                : t('residency.notReported')}
            </p>
            {CACHE_LANE_ORDER.map((lane) => (
              <div
                className="context-token-row"
                key={lane}
                title={word('hint', lane, CACHE_LANE_HINTS)}
              >
                <span>{word('lane', lane, CACHE_LANE_LABELS)}</span>
                <meter
                  min={0}
                  max={Math.max(1, residency.total)}
                  value={residency.lanes[lane] ?? 0}
                  aria-label={t('residency.laneLabel', {
                    lane: word('lane', lane, CACHE_LANE_LABELS),
                  })}
                />
                <strong>~{(residency.lanes[lane] ?? 0).toLocaleString(displayLocale())}</strong>
              </div>
            ))}
            <section className="context-entries" aria-label={t('residency.segments')}>
              {residency.segments.map((segment, index) => (
                <div key={`${segment.kind}-${index}`}>
                  <span>
                    {word('segment', segment.kind, RESIDENCY_SEGMENT_LABELS)} ·{' '}
                    {word('lane', segment.lane, CACHE_LANE_LABELS)} · {segment.count}
                  </span>
                  <strong>~{segment.tokens.toLocaleString(displayLocale())}</strong>
                </div>
              ))}
            </section>
            {residency.breakers.length > 0 && (
              <section aria-label={t('residency.breakers')}>
                <p className="field-help">{t('residency.why')}</p>
                <ul>
                  {residency.breakers.map((breaker, index) => (
                    <li key={index}>
                      {word('breaker', breaker.kind, {})}: {breaker.detail}
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <p className="field-help">
              {t('residency.next')}
              {residency.next.rewritten ? t('residency.rewritten') : t('residency.unchanged')}
              {residency.next.pendingMessages > 0
                ? t('residency.pending', {
                    count: residency.next.pendingMessages,
                    tokens: residency.next.pendingTokens.toLocaleString(displayLocale()),
                  })
                : ''}
              .
            </p>
          </section>
        )}
      </details>
      <details>
        <summary>
          {t('residency.keeps')}
          {retention
            ? t('residency.keepsTokens', {
                tokens: retention.total.toLocaleString(displayLocale()),
              })
            : t('residency.keepsNone')}
        </summary>
        {!retention ? (
          <p className="field-help">{t('residency.noRetention')}</p>
        ) : (
          <section className="context-retention" aria-label={t('residency.retentionLabel')}>
            <p className="field-help">
              {t('residency.protectedNote', {
                keep: retention.preserveK,
                threshold: retention.eliseThreshold.toLocaleString(displayLocale()),
              })}
            </p>
            {retentionRows(retention).map((row) => (
              <div className="context-token-row" key={row.name}>
                <span>
                  {word('retention', row.name, RETENTION_LABELS)} · {row.messages}
                </span>
                <meter
                  min={0}
                  max={Math.max(1, retention.total)}
                  value={row.tokens}
                  aria-label={t('residency.retentionRow', {
                    label: word('retention', row.name, RETENTION_LABELS),
                  })}
                />
                <strong>~{row.tokens.toLocaleString(displayLocale())}</strong>
              </div>
            ))}
          </section>
        )}
      </details>
    </>
  );
}
