import { ArrowLeft, Coins, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DelegationRecord } from './delegations';
import type { EngineCommand } from './engine-operations';
import { SessionDelegations } from './SessionDelegations';
import {
  type PromptUsage,
  type UsageSnapshot,
  usageKinds,
  usageLabels,
  usageMoney,
  usageNumber,
  usageRatio,
  usageSnapshot,
} from './session-usage-model';
import './session-usage.css';

function PromptCard({
  label,
  value,
  providerReported = false,
}: {
  label: string;
  value: PromptUsage | null;
  providerReported?: boolean;
}) {
  return (
    <article className="usage-card" aria-label={label}>
      <h3>{label}</h3>
      {value ? (
        <>
          <strong className="usage-big-number">
            {usageNumber(value.input + value.cacheRead + value.cacheWrite)}{' '}
            <small>prompt tokens</small>
          </strong>
          <dl className="usage-detail-list">
            <div>
              <dt>Fresh input</dt>
              <dd>{usageNumber(value.input)}</dd>
            </div>
            <div>
              <dt>Cache read</dt>
              <dd>{usageNumber(value.cacheRead)}</dd>
            </div>
            <div>
              <dt>Cache write</dt>
              <dd>{usageNumber(value.cacheWrite)}</dd>
            </div>
            {providerReported && (
              <div>
                <dt>Request cache hit</dt>
                <dd>{usageRatio(value.hitRatio)}</dd>
              </div>
            )}
          </dl>
        </>
      ) : (
        <p>
          {providerReported
            ? 'No provider-reported request has been recorded.'
            : 'This runtime did not report a current context snapshot.'}
        </p>
      )}
      <p>
        {providerReported
          ? 'Only the most recent accounted provider response. This is separate from session totals.'
          : 'The engine’s latest context snapshot can change after compaction without another provider response.'}
      </p>
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
  return (
    <section className="session-usage" aria-label="Conversation usage and cost">
      <header className="session-usage-heading">
        <div>
          <span className="eyebrow">THIS CONVERSATION · ENGINE COUNTERS</span>
          <h1>
            Usage & cost<span className="heading-dot">.</span>
          </h1>
          <strong className="usage-conversation-title">{sessionTitle}</strong>
          <p>
            Understand token traffic, cache behavior and estimates without leaving your
            conversation.
          </p>
        </div>
        <div className="session-usage-controls">
          <button type="button" className="button secondary" onClick={onBack}>
            <ArrowLeft size={14} />
            Back to conversation
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
            Refresh usage
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
          Live usage updates
        </label>
        <span>
          {busy
            ? 'Refreshing usage…'
            : updatedAt
              ? `Last successful snapshot ${updatedAt}`
              : 'Waiting for usage'}
        </span>
      </div>
      {!connected && <p role="status">Reconnect this conversation to refresh its counters.</p>}
      {error && (
        <p className="session-error" role="alert">
          {error}
          {snapshot ? ' The last successful snapshot is retained.' : ''}
        </p>
      )}
      {snapshot && (
        <>
          <div className="usage-route">
            <Coins size={16} />
            <strong>
              {snapshot.provider || 'Provider not reported'} /{' '}
              {snapshot.model || 'Model not reported'}
            </strong>
            <span>Current route</span>
          </div>
          <section className="usage-token-overview" aria-label="Session token totals">
            <header>
              <h2>Accumulated token traffic</h2>
              <strong>{usageNumber(snapshot.total)} tokens</strong>
            </header>
            <div
              className="usage-segments"
              role="img"
              aria-label={usageKinds
                .map((kind) => `${usageLabels[kind]} ${usageNumber(snapshot.tokens[kind])}`)
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
                  <span>{usageLabels[kind]}</span>
                  <strong>{usageNumber(snapshot.tokens[kind])}</strong>
                </article>
              ))}
            </div>
            <p>
              Fresh input, cache reads and cache writes are disjoint prompt segments; output is
              counted separately. These are session counters, not a context-window size.
            </p>
          </section>
          <div className="usage-prompt-grid">
            <PromptCard
              label="Last provider-reported request"
              value={snapshot.last}
              providerReported
            />
            <PromptCard label="Current context snapshot" value={snapshot.current} />
          </div>
          <section className="usage-card" aria-label="Session cache behavior">
            <h2>Cache over this session</h2>
            <dl className="usage-metric-grid">
              <div>
                <dt>Cumulative cache hit</dt>
                <dd>{usageRatio(snapshot.cache.hitRatio)}</dd>
              </div>
              <div>
                <dt>5 minute cache writes</dt>
                <dd>{usageNumber(snapshot.cache.write5m)}</dd>
              </div>
              <div>
                <dt>1 hour cache writes</dt>
                <dd>{usageNumber(snapshot.cache.write1h)}</dd>
              </div>
              <div>
                <dt>Known cache-read discount</dt>
                <dd>{usageMoney(snapshot.cache.savedUsd)}</dd>
              </div>
            </dl>
            <p>
              The cumulative ratio includes cold requests and can lag the last request. The engine’s
              read-discount estimate may omit unresolved pricing and excludes cache-write premiums.
              Missing TTL splits stay unreported.
            </p>
            <h3>Routed providers</h3>
            {snapshot.cache.providers.length ? (
              <div className="usage-table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Provider</th>
                      <th>Fresh input</th>
                      <th>Cache read</th>
                      <th>Cache write</th>
                      <th>Cache hit</th>
                      <th>5 min / 1 hour writes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {snapshot.cache.providers.map((provider, index) => (
                      <tr key={`${provider.provider}-${index}`}>
                        <th>{provider.provider}</th>
                        <td>{usageNumber(provider.input)}</td>
                        <td>{usageNumber(provider.cacheRead)}</td>
                        <td>{usageNumber(provider.cacheWrite)}</td>
                        <td>{usageRatio(provider.hitRatio)}</td>
                        <td>
                          {usageNumber(provider.write5m)} / {usageNumber(provider.write1h)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p>No per-provider cache breakdown was reported.</p>
            )}
          </section>
          <section className="usage-card" aria-label="Usage estimate">
            <header>
              <div>
                <h2>Estimate at current model rates</h2>
                <p>
                  {snapshot.pricing
                    ? snapshot.pricing.coverage === 'complete'
                      ? 'All aggregate rate fields are available.'
                      : snapshot.pricing.coverage === 'partial'
                        ? 'Some aggregate rate fields are unavailable.'
                        : 'No catalog pricing is available.'
                    : 'Pricing detail is unavailable from this runtime.'}
                </p>
              </div>
              <strong className="usage-big-number">
                {usageMoney(snapshot.pricing?.estimateUsd)}
              </strong>
            </header>
            <p>
              Current model rates are applied to accumulated session tokens. Historical
              routing/model changes, price tiers and TTL-specific cache-write pricing are not
              reconstructed here. This estimate is not an invoice.
            </p>
            {snapshot.pricing && (
              <>
                <p>Known priced components: {usageMoney(snapshot.pricing.knownCostUsd)}</p>
                <div className="usage-table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Token category</th>
                        <th>Tokens</th>
                        <th>USD / 1M</th>
                        <th>Rate source</th>
                        <th>Estimated USD</th>
                      </tr>
                    </thead>
                    <tbody>
                      {snapshot.pricing.parts.map((part) => (
                        <tr key={part.kind}>
                          <th>{usageLabels[part.kind]}</th>
                          <td>{usageNumber(part.tokens)}</td>
                          <td>
                            {part.rateUsdPerMillion === null
                              ? 'Unpriced'
                              : usageMoney(part.rateUsdPerMillion)}
                          </td>
                          <td>
                            {part.rateSource === 'input-fallback'
                              ? 'Input rate fallback'
                              : part.rateSource === 'catalog'
                                ? 'Catalog / saved override'
                                : 'Not available'}
                          </td>
                          <td>{usageMoney(part.estimateUsd)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </section>
          <section className="usage-card" aria-label="Conversation footprint">
            <h2>Conversation footprint</h2>
            <dl className="usage-metric-grid">
              {[
                ['Messages', snapshot.messages],
                ['Files read', snapshot.readFiles],
                ['Available tools', snapshot.tools],
                ['Recorded side effects', snapshot.sideEffects],
              ].map(([label, value]) => (
                <div key={String(label)}>
                  <dt>{label}</dt>
                  <dd>{usageNumber(value as number | null)}</dd>
                </div>
              ))}
            </dl>
            <p>
              Retained live-runtime counters for this conversation. Provider account balances and
              project-wide totals have their own scope.
            </p>
          </section>
        </>
      )}
      <SessionDelegations delegations={delegations} />
    </section>
  );
}
