'use client';
import { Gauge, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { record, rows, text } from '../lib/session';
import type { SessionController } from '../lib/use-session';
import { CodePanel } from './code-panel';
import { Modal } from './dialogs';
import { usePresentation } from './presentation-mode';

// As core's formatQuotaPercent: rounding must not announce a cut-off that has
// not happened (99.6% used on a window with room reads 1% remaining, not 0%).
const remainingPercent = (used: number) =>
  used >= 100 ? 0 : 100 - Math.min(99, Math.max(0, Math.round(used)));

export function ProviderQuotas({ controller }: { controller: SessionController }) {
  const { mode } = usePresentation();
  const [open, setOpen] = useState(false);
  const [snapshots, setSnapshots] = useState<Record<string, unknown>[]>([]);
  const [providers, setProviders] = useState<string[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [outcomes, setOutcomes] = useState<Record<string, unknown>[]>([]);
  const [now, setNow] = useState(Date.now());
  const { connection, send, subscribe } = controller;
  useEffect(() => {
    if (connection !== 'open') return;
    const off = subscribe((frame) => {
      const p = record(frame.payload);
      if (frame.type === 'providers.saved')
        setProviders(rows(p.providers).map((item) => text(item.id)));
      if (frame.type !== 'provider.quota') return;
      setSnapshots((previous) => {
        const meters = new Map(
          previous.map((item) => [`${text(item.providerId)}:${text(item.meterId)}`, item]),
        );
        for (const item of rows(p.snapshots)) {
          const key = `${text(item.providerId)}:${text(item.meterId)}`;
          if (
            !meters.has(key) ||
            Number(item.capturedAt) >= Number(meters.get(key)?.capturedAt ?? 0)
          )
            meters.set(key, item);
        }
        return [...meters.values()];
      });
      if (Array.isArray(p.refreshed)) {
        setOutcomes(rows(p.refreshed));
        setRefreshing(false);
      }
    });
    send('provider.quota.get');
    send('providers.saved');
    const timer = setInterval(() => {
      send('provider.quota.get');
      setNow(Date.now());
    }, 60000);
    return () => {
      off();
      clearInterval(timer);
    };
  }, [connection, send, subscribe]);
  useEffect(() => {
    if (!open || connection !== 'open') return;
    send('provider.quota.refresh');
    const timer = setInterval(() => send('provider.quota.refresh'), 300000);
    return () => clearInterval(timer);
  }, [open, connection, send]);
  useEffect(() => {
    if (!refreshing) return;
    const timer = setTimeout(() => {
      setRefreshing(false);
      setError('Refresh was not confirmed. The last reported readings are shown.');
    }, 15000);
    return () => clearTimeout(timer);
  }, [refreshing]);
  const ids = [
    ...new Set([
      controller.state.provider,
      ...providers,
      ...snapshots.map((item) => text(item.providerId)),
    ]),
  ].filter(Boolean);
  const current = snapshots.filter(
    (item) => item.providerId === controller.state.provider && !item.via,
  );
  const known = current
    .flatMap((item) => rows(item.windows))
    .filter(
      (window) => typeof window.usedPercent === 'number' && Number.isFinite(window.usedPercent),
    );
  const remaining = known.length
    ? remainingPercent(Math.max(...known.map((window) => Number(window.usedPercent))))
    : null;
  return (
    <>
      <button
        type="button"
        className="quota-summary"
        aria-label="Provider usage and quotas"
        onClick={() => setOpen(true)}
      >
        <Gauge size={15} />
        <span>
          Usage & quotas<small>{controller.state.provider || 'Providers'}</small>
        </span>
        <strong>{remaining === null ? '—' : `${remaining}%`}</strong>
      </button>
      <Modal
        open={open}
        onOpenChange={setOpen}
        title="Provider usage & quotas"
        description="Reported account limits, balances and reset windows."
        icon={<Gauge size={20} />}
        wide
        detailToggle
      >
        <div className="provider-toolbar">
          <span>
            {connection === 'open' ? 'Live quota feed' : 'Disconnected · last reported readings'}
          </span>
          <button
            type="button"
            className="secondary-button"
            disabled={refreshing || connection !== 'open'}
            onClick={() => {
              setError('');
              if (send('provider.quota.refresh')) setRefreshing(true);
            }}
          >
            <RefreshCw size={14} />
            {refreshing ? 'Refreshing quotas…' : 'Refresh quotas'}
          </button>
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="quota-cards">
          {ids.map((id) => {
            const meters = snapshots.filter((item) => item.providerId === id);
            return (
              <section className="quota-card" key={id} aria-label={`${id} quota`}>
                <header>
                  <strong>{id}</strong>
                  {id === controller.state.provider && <small>Current provider</small>}
                </header>
                {!meters.length && (
                  <p className="panel-hint">
                    Quota not reported. Refresh to check supported account endpoints.
                  </p>
                )}
                {meters.map((meter) => (
                  <div className="quota-meter" key={text(meter.meterId)}>
                    <p>
                      {text(meter.meterLabel) || text(meter.planLabel) || 'Account allowance'}
                      {meter.via ? ` · via ${text(meter.via)}` : ''}
                    </p>
                    {rows(meter.windows).map((window) => {
                      const used =
                        typeof window.usedPercent === 'number' &&
                        Number.isFinite(window.usedPercent)
                          ? Math.max(0, Math.min(100, window.usedPercent))
                          : null;
                      const resets = Number(window.resetsAt);
                      return (
                        <div className="quota-window" key={text(window.id)}>
                          <div>
                            <span>{text(window.label) || text(window.id)}</span>
                            <strong>
                              {used === null
                                ? 'Not reported'
                                : `${remainingPercent(used)}% remaining`}
                            </strong>
                          </div>
                          {used !== null && (
                            <progress
                              aria-label={`${id} ${text(window.label) || text(window.id)} quota used`}
                              max={100}
                              value={used}
                            />
                          )}
                          {resets > 0 && (
                            <small>
                              {resets * 1000 > now
                                ? `Resets ${new Date(resets * 1000).toLocaleString()}`
                                : 'Reset time passed · waiting for a fresh reading'}
                            </small>
                          )}
                        </div>
                      );
                    })}
                    {meter.credits != null && (
                      <p className="fine-print">
                        Balance:{' '}
                        {record(meter.credits).unlimited === true
                          ? 'Unlimited'
                          : text(record(meter.credits).balance) ||
                            (record(meter.credits).hasCredits === true
                              ? 'Available'
                              : 'No credits reported')}
                      </p>
                    )}
                    {meter.note != null && <p className="fine-print">{text(meter.note)}</p>}
                    <small className="fine-print">
                      Last reported{' '}
                      {Number(meter.capturedAt) > 0
                        ? new Date(Number(meter.capturedAt)).toLocaleString()
                        : 'unknown'}
                      {now - Number(meter.capturedAt) > 900000 ? ' · may be stale' : ''}
                    </small>
                    {mode === 'extended' && (
                      <CodePanel
                        label="Quota details"
                        value={JSON.stringify(meter, null, 2)}
                        defaultView="tree"
                      />
                    )}
                  </div>
                ))}
              </section>
            );
          })}
        </div>
        {mode === 'extended' && outcomes.length > 0 && (
          <details>
            <summary>Account refresh results</summary>
            <CodePanel
              label="Refresh results"
              value={JSON.stringify(outcomes, null, 2)}
              defaultView="tree"
            />
          </details>
        )}
      </Modal>
    </>
  );
}
