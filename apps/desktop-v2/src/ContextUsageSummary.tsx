import { type ContextUsage, cacheHitPercent, contextPercent, contextZone } from './context-usage';
import './session-status.css';

/** The live figures the engine reported, shown above the estimated section breakdown. */
export function ContextUsageSummary({ usage }: { usage: ContextUsage }) {
  const percent = contextPercent(usage);
  const hit = cacheHitPercent(usage);
  const zone = contextZone(percent);
  return (
    <section className="context-live" aria-label="Reported context use">
      <div className="context-summary">
        <div>
          <strong className={`context-${zone}`}>
            {usage.tokens ? usage.tokens.toLocaleString() : 'Not reported'}
            {percent !== null ? ` (${percent}%)` : ''}
          </strong>
          <span>Latest request</span>
        </div>
        <div>
          <strong>{hit !== null ? `${hit}%` : 'Not reported'}</strong>
          <span>
            From cache
            {hit !== null
              ? ` · ${usage.cacheRead.toLocaleString()} read, ${usage.cacheWrite.toLocaleString()} written`
              : ''}
          </span>
        </div>
        <div>
          <strong>
            {(
              usage.totals.input +
              usage.totals.cacheRead +
              usage.totals.cacheWrite
            ).toLocaleString()}{' '}
            / {usage.totals.output.toLocaleString()}
          </strong>
          <span>
            Prompt / completion tokens over {usage.responses}{' '}
            {usage.responses === 1 ? 'response' : 'responses'}
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
          aria-label="Context window used by the latest request"
        />
      )}
      {usage.decreasedFrom > 0 && (
        <p role="status">
          The provider accepts {usage.max.toLocaleString()} tokens, less than the{' '}
          {usage.decreasedFrom.toLocaleString()} configured for this model.
        </p>
      )}
      {usage.compaction && (
        <p>
          Last compaction: {usage.compaction.before.toLocaleString()} →{' '}
          {usage.compaction.after.toLocaleString()} message tokens, saved{' '}
          {usage.compaction.saved.toLocaleString()}.
        </p>
      )}
    </section>
  );
}
