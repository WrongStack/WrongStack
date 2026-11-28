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
  const prompt = usage.totals.input + usage.totals.cacheRead + usage.totals.cacheWrite;
  return (
    <section className="context-live" aria-label={t('contextLive.label')}>
      <div className="context-live-tiles">
        <div className={`context-live-tile context-${zone}`}>
          <span>{t('contextLive.latest')}</span>
          <strong>
            {usage.tokens
              ? usage.tokens.toLocaleString(displayLocale())
              : t('contextLive.notReported')}
            {percent !== null ? <small> {percent}%</small> : null}
          </strong>
          {percent !== null && (
            <meter
              className="context-live-meter"
              aria-label={t('contextLive.meter')}
              min={0}
              max={100}
              value={percent}
            />
          )}
        </div>
        <div className="context-live-tile is-cache">
          <span>{t('contextLive.fromCache')}</span>
          <strong>{hit !== null ? `${hit}%` : t('contextLive.notReported')}</strong>
          {hit !== null && (
            <>
              <span className="context-live-bar" aria-hidden="true">
                <i style={{ inlineSize: `${hit}%` }} />
              </span>
              <small>
                {t('contextLive.cacheDetail', {
                  read: usage.cacheRead.toLocaleString(displayLocale()),
                  written: usage.cacheWrite.toLocaleString(displayLocale()),
                })}
              </small>
            </>
          )}
        </div>
        <div className="context-live-tile is-billed">
          <span>
            {usage.responses === 1
              ? t('contextLive.tokensOne')
              : t('contextLive.tokensMany', { number: usage.responses })}
          </span>
          <strong>
            {prompt.toLocaleString(displayLocale())}
            <small> / {usage.totals.output.toLocaleString(displayLocale())}</small>
          </strong>
          {prompt + usage.totals.output > 0 && (
            <span className="context-live-split" aria-hidden="true">
              <i style={{ flexGrow: prompt }} />
              <i style={{ flexGrow: usage.totals.output }} />
            </span>
          )}
        </div>
      </div>
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
