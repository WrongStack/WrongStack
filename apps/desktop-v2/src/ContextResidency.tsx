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
  const residency = requestResidency(rawResidency);
  const retention = historyRetention(rawRetention);
  return (
    <>
      <details>
        <summary>
          Last request cache layout
          {residency
            ? ` · ${CACHE_VERDICT_LABELS[residency.verdict] ?? residency.verdict}`
            : ' · none recorded'}
        </summary>
        {!residency ? (
          <p className="field-help">
            No request has been recorded for this session yet, or the engine did not report one.
          </p>
        ) : (
          <section className="context-residency" aria-label="Request cache layout">
            <p className="field-help">
              {residency.providerId}/{residency.model} · ~{residency.total.toLocaleString()}{' '}
              estimated request tokens · layout allows {percent(residency.expectedCacheRatio, 1)}%
              from cache
              {residency.actual
                ? ` · provider read ${residency.actual.cacheRead.toLocaleString()} of ${residency.actual.total.toLocaleString()} from cache (${percent(residency.actual.cacheRatio, 1)}%)`
                : ' · provider usage not reported yet'}
            </p>
            {CACHE_LANE_ORDER.map((lane) => (
              <div className="context-token-row" key={lane} title={CACHE_LANE_HINTS[lane]}>
                <span>{CACHE_LANE_LABELS[lane]}</span>
                <meter
                  min={0}
                  max={Math.max(1, residency.total)}
                  value={residency.lanes[lane] ?? 0}
                  aria-label={`Cache lane ${CACHE_LANE_LABELS[lane]}`}
                />
                <strong>~{(residency.lanes[lane] ?? 0).toLocaleString()}</strong>
              </div>
            ))}
            <section className="context-entries" aria-label="Request segments">
              {residency.segments.map((segment, index) => (
                <div key={`${segment.kind}-${index}`}>
                  <span>
                    {RESIDENCY_SEGMENT_LABELS[segment.kind] ?? segment.kind} ·{' '}
                    {CACHE_LANE_LABELS[segment.lane] ?? segment.lane} · {segment.count}
                  </span>
                  <strong>~{segment.tokens.toLocaleString()}</strong>
                </div>
              ))}
            </section>
            {residency.breakers.length > 0 && (
              <section aria-label="Cache breakers">
                <p className="field-help">Why cached bytes were not reused:</p>
                <ul>
                  {residency.breakers.map((breaker, index) => (
                    <li key={index}>
                      {breaker.kind}: {breaker.detail}
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <p className="field-help">
              Next request:{' '}
              {residency.next.rewritten
                ? 'history was rewritten, so the cached history prefix is lost'
                : 'history prefix unchanged'}
              {residency.next.pendingMessages > 0
                ? ` · ${residency.next.pendingMessages} new messages (~${residency.next.pendingTokens.toLocaleString()} tokens) waiting`
                : ''}
              .
            </p>
          </section>
        )}
      </details>
      <details>
        <summary>
          What the next compaction keeps
          {retention ? ` · ${retention.total.toLocaleString()} tokens` : ' · not reported'}
        </summary>
        {!retention ? (
          <p className="field-help">The engine did not report retention for this context.</p>
        ) : (
          <section className="context-retention" aria-label="Compaction retention">
            <p className="field-help">
              The last {retention.preserveK} turns are protected; long tool output above ~
              {retention.eliseThreshold.toLocaleString()} tokens can be elided first.
            </p>
            {retentionRows(retention).map((row) => (
              <div className="context-token-row" key={row.name}>
                <span>
                  {RETENTION_LABELS[row.name]} · {row.messages}
                </span>
                <meter
                  min={0}
                  max={Math.max(1, retention.total)}
                  value={row.tokens}
                  aria-label={`Retention ${RETENTION_LABELS[row.name]}`}
                />
                <strong>~{row.tokens.toLocaleString()}</strong>
              </div>
            ))}
          </section>
        )}
      </details>
    </>
  );
}
