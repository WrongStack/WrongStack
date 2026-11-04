import { ArrowLeft, Coins, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Trans } from 'react-i18next';
import { type DelegationRecord, withWorkerEstimates } from './delegations';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';
import { SessionDelegations } from './SessionDelegations';
import {
  type PromptUsage,
  type UsageSnapshot,
  usageKinds,
  usageMoney,
  usageNumber,
  usageRatio,
  usageSnapshot,
} from './session-usage-model';
import { surfaceI18n } from './surface-i18n';
import './session-usage.css';

/** The usage formatters with the display language's words for a missing value. */
function useUsageFormat() {
  const { t } = useDesktopText();
  const notReported = t('usageView.notReported');
  return {
    t,
    number: (value: number | null | undefined) => usageNumber(value, notReported),
    money: (value: number | null | undefined) => usageMoney(value, t('usageView.unavailable')),
    ratio: (value: number | null | undefined) => usageRatio(value, notReported),
  };
}

/** The estimate above plus the engine's estimates for this conversation's workers. */
function WorkerTotal({ combined }: { combined: ReturnType<typeof withWorkerEstimates> }) {
  const { t, money } = useUsageFormat();
  if (!combined) return null;
  return (
    <p className="usage-worker-total">
      <Trans
        i18n={surfaceI18n}
        ns="desktop"
        i18nKey="usageView.workerTotal"
        values={{
          total: money(combined.totalUsd),
          workers: t(combined.priced === 1 ? 'usageView.pricedWorker' : 'usageView.pricedWorkers', {
            count: combined.priced,
          }),
          unpriced: combined.unpriced
            ? t('usageView.unpricedWorkers', { count: combined.unpriced })
            : '',
        }}
        components={{ strong: <strong /> }}
      />
    </p>
  );
}

function PromptCard({
  label,
  value,
  providerReported = false,
}: {
  label: string;
  value: PromptUsage | null;
  providerReported?: boolean;
}) {
  const { t, number, ratio } = useUsageFormat();
  return (
    <article className="usage-card" aria-label={label}>
      <h3>{label}</h3>
      {value ? (
        <>
          <strong className="usage-big-number">
            {number(value.input + value.cacheRead + value.cacheWrite)}{' '}
            <small>{t('usageView.promptTokens')}</small>
          </strong>
          <dl className="usage-detail-list">
            <div>
              <dt>{t('usageView.kind.input')}</dt>
              <dd>{number(value.input)}</dd>
            </div>
            <div>
              <dt>{t('usageView.kind.cache-read')}</dt>
              <dd>{number(value.cacheRead)}</dd>
            </div>
            <div>
              <dt>{t('usageView.kind.cache-write')}</dt>
              <dd>{number(value.cacheWrite)}</dd>
            </div>
            {providerReported && (
              <div>
                <dt>{t('usageView.requestHit')}</dt>
                <dd>{ratio(value.hitRatio)}</dd>
              </div>
            )}
          </dl>
        </>
      ) : (
        <p>{providerReported ? t('usageView.noLast') : t('usageView.noCurrent')}</p>
      )}
      <p>{providerReported ? t('usageView.lastNote') : t('usageView.currentNote')}</p>
    </article>
  );
}
export function SessionUsage({
  sessionId,
  sessionTitle,
  connected,
  command,
  onBack,
  delegations = [],
}: {
  sessionId: string;
  sessionTitle: string;
  connected: boolean;
  command: EngineCommand;
  onBack: () => void;
  /** Worker delegations the engine reported for this conversation. */
  delegations?: DelegationRecord[] | undefined;
}) {
  const { t, number, money, ratio } = useUsageFormat();
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [updatedAt, setUpdatedAt] = useState(''),
    [live, setLive] = useState(true);
  const generation = useRef(0),
    pending = useRef(false),
    alive = useRef(true);
  const load = useCallback(async () => {
    if (!connected || !sessionId || pending.current) return;
    pending.current = true;
    const version = ++generation.current;
    setBusy(true);
    try {
      const next = usageSnapshot(
        await command('stats.get', { sessionId }, ['stats.get'], { timeoutMs: 15000 }),
        sessionId,
      );
      if (alive.current && generation.current === version) {
        setSnapshot(next);
        setUpdatedAt(new Date().toLocaleTimeString());
        setError('');
      }
    } catch (error) {
      if (alive.current && generation.current === version)
        setError(error instanceof Error ? error.message : String(error));
    } finally {
      pending.current = false;
      if (alive.current && generation.current === version) setBusy(false);
    }
  }, [connected, sessionId, command]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      generation.current++;
    };
  }, [load]);
  useEffect(() => {
    let stopped = false,
      timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await load();
      if (!stopped && live) timer = setTimeout(poll, 5000);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [load, live]);
  const kindLabel = (kind: (typeof usageKinds)[number]) => t(`usageView.kind.${kind}`);
  return (
    <section className="session-usage" aria-label={t('usageView.label')}>
      <header className="session-usage-heading">
        <div>
          <h1>{t('usageView.title')}</h1>
          <strong className="usage-conversation-title">{sessionTitle}</strong>
          <p>{t('usageView.body')}</p>
        </div>
        <div className="session-usage-controls">
          <button type="button" className="button secondary" onClick={onBack}>
            <ArrowLeft size={14} />
            {t('usageView.back')}
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={busy || !connected}
            onClick={() => {
              void load();
            }}
          >
            <RefreshCw size={14} />
            {t('usageView.refresh')}
          </button>
        </div>
      </header>
      <div className="usage-snapshot-status">
        <label>
          <input
            type="checkbox"
            checked={live}
            onChange={(event) => setLive(event.target.checked)}
          />
          {t('usageView.live')}
        </label>
        <span>
          {busy
            ? t('usageView.refreshing')
            : updatedAt
              ? t('usageView.lastSnapshot', { time: updatedAt })
              : t('usageView.waiting')}
        </span>
      </div>
      {!connected && <p role="status">{t('usageView.reconnect')}</p>}
      {error && (
        <p className="session-error" role="alert">
          {error}
          {snapshot ? ` ${t('usageView.retained')}` : ''}
        </p>
      )}
      {snapshot && (
        <>
          <div className="usage-route">
            <Coins size={16} />
            <strong>
              {snapshot.provider || t('usageView.noProvider')} /{' '}
              {snapshot.model || t('usageView.noModel')}
            </strong>
            <span>{t('usageView.route')}</span>
          </div>
          <section className="usage-token-overview" aria-label={t('usageView.totalsLabel')}>
            <header>
              <h2>{t('usageView.totalsTitle')}</h2>
              <strong>{t('usageView.tokens', { value: number(snapshot.total) })}</strong>
            </header>
            <div
              className="usage-segments"
              role="img"
              aria-label={usageKinds
                .map((kind) => `${kindLabel(kind)} ${number(snapshot.tokens[kind])}`)
                .join(', ')}
            >
              {usageKinds.map((kind) => (
                <span
                  key={kind}
                  className={`usage-segment-${kind}`}
                  style={{
                    width: `${snapshot.total ? (snapshot.tokens[kind] / snapshot.total) * 100 : 0}%`,
                  }}
                />
              ))}
            </div>
            <div className="usage-total-grid">
              {usageKinds.map((kind) => (
                <article key={kind} className={`usage-total-${kind}`}>
                  <span>{kindLabel(kind)}</span>
                  <strong>{number(snapshot.tokens[kind])}</strong>
                </article>
              ))}
            </div>
            <p>{t('usageView.segmentsNote')}</p>
          </section>
          <div className="usage-prompt-grid">
            <PromptCard label={t('usageView.lastLabel')} value={snapshot.last} providerReported />
            <PromptCard label={t('usageView.currentLabel')} value={snapshot.current} />
          </div>
          <section className="usage-card" aria-label={t('usageView.cacheLabel')}>
            <h2>{t('usageView.cacheTitle')}</h2>
            <dl className="usage-metric-grid">
              <div>
                <dt>{t('usageView.cumulativeHit')}</dt>
                <dd>{ratio(snapshot.cache.hitRatio)}</dd>
              </div>
              <div>
                <dt>{t('usageView.write5m')}</dt>
                <dd>{number(snapshot.cache.write5m)}</dd>
              </div>
              <div>
                <dt>{t('usageView.write1h')}</dt>
                <dd>{number(snapshot.cache.write1h)}</dd>
              </div>
              <div>
                <dt>{t('usageView.discount')}</dt>
                <dd>{money(snapshot.cache.savedUsd)}</dd>
              </div>
            </dl>
            <p>{t('usageView.cacheNote')}</p>
            <h3>{t('usageView.providersTitle')}</h3>
            {snapshot.cache.providers.length ? (
              <div className="usage-table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>{t('usageView.column.provider')}</th>
                      <th>{t('usageView.kind.input')}</th>
                      <th>{t('usageView.kind.cache-read')}</th>
                      <th>{t('usageView.kind.cache-write')}</th>
                      <th>{t('usageView.column.cacheHit')}</th>
                      <th>{t('usageView.column.writes')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {snapshot.cache.providers.map((provider, index) => (
                      <tr key={`${provider.provider}-${index}`}>
                        <th>{provider.provider}</th>
                        <td>{number(provider.input)}</td>
                        <td>{number(provider.cacheRead)}</td>
                        <td>{number(provider.cacheWrite)}</td>
                        <td>{ratio(provider.hitRatio)}</td>
                        <td>
                          {number(provider.write5m)} / {number(provider.write1h)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p>{t('usageView.noProviders')}</p>
            )}
          </section>
          <section className="usage-card" aria-label={t('usageView.estimateLabel')}>
            <header>
              <div>
                <h2>{t('usageView.estimateTitle')}</h2>
                <p>
                  {snapshot.pricing
                    ? snapshot.pricing.coverage === 'complete'
                      ? t('usageView.coverage.complete')
                      : snapshot.pricing.coverage === 'partial'
                        ? t('usageView.coverage.partial')
                        : t('usageView.coverage.none')
                    : t('usageView.coverage.unavailable')}
                </p>
              </div>
              <strong className="usage-big-number">{money(snapshot.pricing?.estimateUsd)}</strong>
            </header>
            <p>{t('usageView.estimateNote')}</p>
            {snapshot.pricing && (
              <>
                <p>{t('usageView.knownPriced', { value: money(snapshot.pricing.knownCostUsd) })}</p>
                <WorkerTotal
                  combined={withWorkerEstimates(snapshot.pricing.estimateUsd, delegations)}
                />
                <div className="usage-table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>{t('usageView.column.category')}</th>
                        <th>{t('usageView.column.tokens')}</th>
                        <th>{t('usageView.column.rate')}</th>
                        <th>{t('usageView.column.source')}</th>
                        <th>{t('usageView.column.estimate')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {snapshot.pricing.parts.map((part) => (
                        <tr key={part.kind}>
                          <th>{kindLabel(part.kind)}</th>
                          <td>{number(part.tokens)}</td>
                          <td>
                            {part.rateUsdPerMillion === null
                              ? t('usageView.unpriced')
                              : money(part.rateUsdPerMillion)}
                          </td>
                          <td>
                            {part.rateSource === 'input-fallback'
                              ? t('usageView.source.input-fallback')
                              : part.rateSource === 'catalog'
                                ? t('usageView.source.catalog')
                                : t('usageView.source.none')}
                          </td>
                          <td>{money(part.estimateUsd)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </section>
          <section className="usage-card" aria-label={t('usageView.footprintTitle')}>
            <h2>{t('usageView.footprintTitle')}</h2>
            <dl className="usage-metric-grid">
              {(
                [
                  ['messages', snapshot.messages],
                  ['readFiles', snapshot.readFiles],
                  ['tools', snapshot.tools],
                  ['sideEffects', snapshot.sideEffects],
                ] as const
              ).map(([id, value]) => (
                <div key={id}>
                  <dt>{t(`usageView.footprint.${id}`)}</dt>
                  <dd>{number(value)}</dd>
                </div>
              ))}
            </dl>
            <p>{t('usageView.footprintNote')}</p>
          </section>
        </>
      )}
      <SessionDelegations delegations={delegations} />
    </section>
  );
}
