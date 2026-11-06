import { type ContextUsage, cacheHitPercent, contextPercent, contextZone } from './context-usage';
import { useDesktopText } from './desktop-i18n';
import './session-status.css';
import { displayLocale } from './display-dates';

/** The live figures the engine reported, shown above the estimated section breakdown. */
export function ContextUsageSummary({ usage }: { usage: ContextUsage }) {
  const { t } = useDesktopText();
  const percent = contextPercent(usage);
  const hit = cacheHitPercent(usage);
  const zone = contextZone(percent);
  return (
    <section className="context-live" aria-label={t('contextLive.label')}>
      <div className="context-summary">
        <div>
          <strong className={`context-${zone}`}>
            {usage.tokens
              ? usage.tokens.toLocaleString(displayLocale())
              : t('contextLive.notReported')}
            {percent !== null ? ` (${percent}%)` : ''}
          </strong>
          <span>{t('contextLive.latest')}</span>
        </div>
        <div>
          <strong>{hit !== null ? `${hit}%` : t('contextLive.notReported')}</strong>
          <span>
            {t('contextLive.fromCache')}
            {hit !== null
              ? ` · ${t('contextLive.cacheDetail', {
                  read: usage.cacheRead.toLocaleString(displayLocale()),
                  written: usage.cacheWrite.toLocaleString(displayLocale()),
                })}`
              : ''}
          </span>
        </div>
        <div>
          <strong>
            {(usage.totals.input + usage.totals.cacheRead + usage.totals.cacheWrite).toLocaleString(
              displayLocale(),
            )}{' '}
            / {usage.totals.output.toLocaleString(displayLocale())}
          </strong>
          <span>
            {usage.responses === 1
              ? t('contextLive.tokensOne')
              : t('contextLive.tokensMany', { number: usage.responses })}
          </span>
        </div>
      </div>
      {percent !== null && (
        <meter
          className={`context-live-meter context-${zone}`}
          min={0}
          max={100}
          low={60}
          high={85}
          optimum={0}
          value={percent}
          aria-label={t('contextLive.meter')}
        />
      )}
      {usage.decreasedFrom > 0 && (
        <p role="status">
          {t('contextLive.limit', {
            max: usage.max.toLocaleString(displayLocale()),
            configured: usage.decreasedFrom.toLocaleString(displayLocale()),
          })}
        </p>
      )}
      {usage.compaction && usage.compaction.saved > 0 && (
        <p>
          {t('contextLive.compaction', {
            before: usage.compaction.before.toLocaleString(displayLocale()),
            after: usage.compaction.after.toLocaleString(displayLocale()),
            saved: usage.compaction.saved.toLocaleString(displayLocale()),
          })}
        </p>
      )}
    </section>
  );
}
