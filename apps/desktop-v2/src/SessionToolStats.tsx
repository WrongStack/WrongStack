import { RefreshCw, Wrench } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import { displayLocale } from './display-dates';
import type { EngineCommand } from './engine-operations';
import type { EngineEvent } from './engine-state';
import { durationText } from './engine-values';
import {
  type CatalogToolStats,
  callCount,
  catalogToolStats,
  conversationToolStats,
  successRate,
} from './tool-stats-model';
import './tool-stats.css';

/** The conversation's tool events: every finished turn's, then the running turn's. */
export interface ToolActivity {
  turnActivity: Record<string, EngineEvent[]>;
  runTimeline: EngineEvent[];
}

/** Earlier conversations read from the project's catalog. */
const CATALOG_LIMIT = 50;

function Ratio({ ok, failed }: { ok: number; failed: number }) {
  const total = Math.max(1, ok + failed);
  return (
    <span className="tool-stats-ratio" aria-hidden="true">
      <span className="ok" style={{ width: `${(ok / total) * 100}%` }} />
      <span className="failed" style={{ width: `${(failed / total) * 100}%` }} />
    </span>
  );
}

/**
 * Tool-call statistics, as the WebUI's statistics view shows them: per tool for this conversation
 * (calls, outcome, success rate, average time, agent-to-agent calls) and, across the project's
 * conversations, the counts the session catalog keeps.
 */
export function SessionToolStats({
  activity,
  connected,
  command,
}: {
  activity: ToolActivity;
  connected: boolean;
  command: EngineCommand;
}) {
  const { t } = useDesktopText();
  const number = (value: number) => value.toLocaleString(displayLocale());
  const rate = (ok: number, failed: number) => {
    const value = successRate(ok, failed);
    return value === null ? '—' : `${value}%`;
  };
  const stats = useMemo(
    () =>
      conversationToolStats([
        ...Object.values(activity.turnActivity).flat(),
        ...activity.runTimeline,
      ]),
    [activity.turnActivity, activity.runTimeline],
  );
  const [catalog, setCatalog] = useState<CatalogToolStats | null>(null),
    [catalogError, setCatalogError] = useState(''),
    [reading, setReading] = useState(false);
  const alive = useRef(true);
  const read = useCallback(async () => {
    if (!connected) return;
    setReading(true);
    setCatalogError('');
    try {
      const reply = await command('sessions.list', { limit: CATALOG_LIMIT }, ['sessions.list']);
      if (typeof reply['error'] === 'string') throw Error(reply['error']);
      if (alive.current) setCatalog(catalogToolStats(reply));
    } catch (error) {
      if (alive.current) setCatalogError(error instanceof Error ? error.message : String(error));
    } finally {
      if (alive.current) setReading(false);
    }
  }, [command, connected]);
  useEffect(() => {
    alive.current = true;
    void read();
    return () => {
      alive.current = false;
    };
  }, [read]);
  const { totals } = stats;
  const metrics: Array<[string, string]> = [
    ['calls', number(totals.started)],
    ['ok', number(totals.ok)],
    ['failed', number(totals.failed)],
    ['rate', rate(totals.ok, totals.failed)],
    ['time', totals.totalMs ? durationText(totals.totalMs, displayLocale()) : '—'],
  ];
  if (totals.inFlight) metrics.push(['inFlight', number(totals.inFlight)]);
  return (
    <section className="usage-card tool-stats" aria-label={t('toolStats.title')}>
      <header>
        <h2>
          <Wrench size={15} /> {t('toolStats.title')}
        </h2>
      </header>
      <dl className="usage-metric-grid">
        {metrics.map(([id, value]) => (
          <div key={id}>
            <dt>{t(`toolStats.metric.${id}`)}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {stats.tools.length === 0 ? (
        <p>{t('toolStats.none')}</p>
      ) : (
        <div className="usage-table-scroll">
          <table aria-label={t('toolStats.perTool')}>
            <thead>
              <tr>
                <th>{t('toolStats.column.tool')}</th>
                <th>{t('toolStats.column.outcome')}</th>
                <th>{t('toolStats.column.calls')}</th>
                <th>{t('toolStats.column.rate')}</th>
                <th>{t('toolStats.column.average')}</th>
              </tr>
            </thead>
            <tbody>
              {stats.tools.map((tool) => {
                const done = tool.ok + tool.failed;
                return (
                  <tr key={tool.name}>
                    <th>
                      <code>{tool.name}</code>
                    </th>
                    <td>
                      <Ratio ok={tool.ok} failed={tool.failed} />
                    </td>
                    <td>{number(callCount(tool))}</td>
                    <td className={tool.failed ? 'tool-stats-failed' : undefined}>
                      {rate(tool.ok, tool.failed)}
                    </td>
                    <td>
                      {done && tool.totalMs
                        ? durationText(tool.totalMs / done, displayLocale())
                        : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {stats.agents.length > 0 && (
        <>
          <h3>{t('toolStats.agents')}</h3>
          <ul className="tool-stats-rows" aria-label={t('toolStats.agents')}>
            {stats.agents.map((agent) => (
              <li key={agent.name}>
                <code>{agent.name}</code>
                <Ratio ok={agent.ok} failed={agent.failed} />
                <span>{t('toolStats.outcome', { ok: agent.ok, failed: agent.failed })}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <header className="tool-stats-catalog">
        <h3>{t('toolStats.catalogTitle')}</h3>
        <button
          type="button"
          className="icon-button"
          title={t('toolStats.catalogRefresh')}
          aria-label={t('toolStats.catalogRefresh')}
          disabled={!connected || reading}
          onClick={() => void read()}
        >
          <RefreshCw size={13} />
        </button>
      </header>
      <p>{t('toolStats.catalogNote', { n: CATALOG_LIMIT })}</p>
      {catalogError ? (
        <p role="alert" className="session-error">
          {catalogError}
        </p>
      ) : !catalog ? (
        <p role="status">{t('toolStats.catalogReading')}</p>
      ) : catalog.sessions.length === 0 ? (
        <p>{t('toolStats.catalogNone')}</p>
      ) : (
        <>
          <p className="tool-stats-summary">
            {t('toolStats.catalogTotals', {
              calls: number(catalog.calls),
              failed: number(catalog.failed),
              rate: rate(catalog.calls - catalog.failed, catalog.failed),
              sessions: catalog.sessions.length,
            })}
          </p>
          {catalog.tools.length > 0 && (
            <p className="tool-stats-breakdown">
              {catalog.tools
                .slice(0, 12)
                .map((tool) => `${tool.name} ×${number(tool.calls)}`)
                .join(' · ')}
            </p>
          )}
          <ul className="tool-stats-rows" aria-label={t('toolStats.catalogTitle')}>
            {catalog.sessions.slice(0, 12).map((row) => (
              <li key={row.id}>
                <span title={row.id}>
                  {row.title}
                  {row.current && <small> · {t('toolStats.thisConversation')}</small>}
                </span>
                <Ratio ok={row.calls - row.failed} failed={row.failed} />
                <span>
                  {t('toolStats.sessionLine', {
                    calls: number(row.calls),
                    failed: number(row.failed),
                    rate: rate(row.calls - row.failed, row.failed),
                  })}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
