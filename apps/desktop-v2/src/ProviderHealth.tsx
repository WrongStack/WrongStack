import { RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';
import type { EngineState } from './engine-state';
import { entries, record } from './engine-values';
import './provider-health.css';

const words = (value: unknown) => (typeof value === 'string' ? value.replaceAll('_', ' ') : '');
export function quotaPercent(value: unknown, missing = 'Not reported') {
  if (typeof value !== 'number' || !Number.isFinite(value)) return missing;
  if (value > 99 && value < 100) return '99%';
  return `${Math.min(100, Math.max(0, value)).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
}
export function mergeQuotaSnapshots(
  previous: Record<string, unknown>[],
  payload: Record<string, unknown>,
) {
  const incoming = entries(payload['snapshots']);
  if (typeof payload['providerId'] !== 'string') return incoming;
  return [...previous.filter((item) => item['providerId'] !== payload['providerId']), ...incoming];
}
function date(value: unknown, seconds = false, missing = 'Not reported') {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return missing;
  const parsed = new Date(value * (seconds ? 1000 : 1));
  return Number.isNaN(parsed.getTime()) ? missing : parsed.toLocaleString();
}
export function QuotaReading({ snapshot }: { snapshot: Record<string, unknown> }) {
  const { t } = useDesktopText();
  const missing = t('providerHealth.notReported');
  const credits = record(snapshot['credits']);
  return (
    <article
      className="provider-quota-card"
      aria-label={t('providerHealth.quotaLabel', {
        provider: String(snapshot['providerId']),
        meter: String(snapshot['meterId']),
      })}
    >
      <header>
        <div>
          <span className="eyebrow">{String(snapshot['providerId'])}</span>
          <h4>
            {String(
              snapshot['meterLabel'] ?? snapshot['meterId'] ?? t('providerHealth.accountQuota'),
            )}
          </h4>
        </div>
        {typeof snapshot['planLabel'] === 'string' && (
          <span className="sdd-chip">{snapshot['planLabel']}</span>
        )}
      </header>
      {snapshot['via'] !== undefined && (
        <p>{t('providerHealth.pool', { via: String(snapshot['via']) })}</p>
      )}
      {entries(snapshot['windows']).map((window) => {
        const percent = window['usedPercent'];
        const finite = typeof percent === 'number' && Number.isFinite(percent);
        const reached = snapshot['reachedWindowId'] === window['id'];
        return (
          <div
            className={`quota-window ${reached || (finite && percent >= 90) ? 'quota-attention' : ''}`}
            key={String(window['id'])}
          >
            <div>
              <strong>{String(window['label'] ?? window['id'])}</strong>
              <span>
                {t('providerHealth.used', { percent: quotaPercent(percent, missing) })}
                {reached ? ` · ${t('providerHealth.limitReached')}` : ''}
              </span>
            </div>
            {finite && (
              <meter
                min={0}
                max={100}
                value={Math.min(100, Math.max(0, percent))}
                aria-label={t('providerHealth.windowUsed', {
                  window: String(window['label'] ?? window['id']),
                })}
              />
            )}
            <small>
              {t('providerHealth.reset', { date: date(window['resetsAt'], true, missing) })}
            </small>
            {typeof window['exhaustsAt'] === 'number' && (
              <small>
                {t('providerHealth.exhausts', { date: date(window['exhaustsAt'], true, missing) })}
              </small>
            )}
          </div>
        );
      })}
      {snapshot['credits'] !== undefined && (
        <p className="quota-balance">
          {t('providerHealth.balance')}{' '}
          <strong>
            {credits['unlimited'] === true
              ? t('providerHealth.unlimited')
              : String(
                  credits['balance'] ??
                    (credits['hasCredits'] === false
                      ? t('providerHealth.noCredits')
                      : t('providerHealth.creditsUnknown')),
                )}
          </strong>
        </p>
      )}
      {typeof snapshot['note'] === 'string' && <p>{snapshot['note']}</p>}
      <small>
        {t('providerHealth.observed', { date: date(snapshot['capturedAt'], false, missing) })}
      </small>
    </article>
  );
}
export function ProviderHealth({ state, command }: { state: EngineState; command: EngineCommand }) {
  const { t } = useDesktopText();
  const missing = t('providerHealth.notReported');
  const [snapshots, setSnapshots] = useState<Record<string, unknown>[]>([]);
  const [health, setHealth] = useState<Record<string, unknown> | null>(null);
  const [audit, setAudit] = useState<Record<string, unknown>[]>([]);
  const [outcomes, setOutcomes] = useState<Record<string, unknown>[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [filter, setFilter] = useState('');
  const [notice, setNotice] = useState('');
  const [clear, setClear] = useState<Record<string, unknown> | null>(null);
  const sequence = useRef(0);
  const busyRef = useRef(false);
  const load = useCallback(
    async (refreshAccounts = false) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      setErrors([]);
      const seq = ++sequence.current;
      const results = await Promise.allSettled([
        command(
          refreshAccounts ? 'provider.quota.refresh' : 'provider.quota.get',
          {},
          ['provider.quota'],
          { timeoutMs: refreshAccounts ? 60000 : 15000 },
        ),
        command('provider.status.get', {}, ['provider.status.snapshot']),
        command('provider.audit.get', { count: 50 }, ['provider.audit.history']),
      ]);
      if (seq !== sequence.current) return;
      const issues: string[] = [];
      if (results[0].status === 'fulfilled') {
        setSnapshots(entries(results[0].value['snapshots']));
        if (refreshAccounts) setOutcomes(entries(results[0].value['refreshed']));
      } else issues.push(t('providerHealth.quotaError', { error: String(results[0].reason) }));
      if (results[1].status === 'fulfilled') setHealth(results[1].value);
      else issues.push(t('providerHealth.trackerUnavailable'));
      if (results[2].status === 'fulfilled') setAudit(entries(results[2].value['lines']));
      else issues.push(t('providerHealth.auditError', { error: String(results[2].reason) }));
      setErrors(issues);
      setLoaded(true);
      busyRef.current = false;
      setBusy(false);
    },
    [command, t],
  );
  useEffect(() => {
    void load();
    return () => {
      sequence.current++;
      busyRef.current = false;
    };
  }, [load]);
  const quotaEvent = state.results['provider.quota'];
  useEffect(() => {
    if (quotaEvent) setSnapshots((previous) => mergeQuotaSnapshots(previous, quotaEvent));
  }, [quotaEvent]);
  const statusEvent = state.results['provider.status.snapshot'];
  useEffect(() => {
    if (statusEvent && !statusEvent['error']) setHealth(statusEvent);
  }, [statusEvent]);
  const control = async (entry: Record<string, unknown>, action: 'retry' | 'clear') => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setNotice('');
    setErrors([]);
    let acknowledged = false;
    try {
      const reply = await command(
        `provider.status.${action}`,
        { providerId: entry['providerId'], model: entry['model'] },
        ['key.operation_result'],
      );
      setNotice(String(reply['message'] ?? t('providerHealth.acknowledged')));
      setClear(null);
      acknowledged = true;
    } catch (error) {
      setErrors([String(error)]);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
    if (acknowledged) await load();
  };
  const matches = (value: unknown) =>
    String(value ?? '')
      .toLowerCase()
      .includes(filter.toLowerCase());
  const statuses = entries(health?.['statuses']);
  return (
    <section className="provider-health" aria-label={t('providerHealth.label')}>
      <header className="settings-section-heading">
        <div>
          <h2>{t('providerHealth.title')}</h2>
          <p>{t('providerHealth.intro')}</p>
        </div>
      </header>
      <div className="provider-health-toolbar">
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={() => void load()}
        >
          <RefreshCw size={14} />
          {t('providerHealth.reload')}
        </button>
        <button
          type="button"
          className="button primary"
          disabled={busy}
          onClick={() => void load(true)}
        >
          {t('providerHealth.refresh')}
        </button>
        <label>
          {t('providerHealth.filter')}
          <input
            aria-label={t('providerHealth.filterLabel')}
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        </label>
      </div>
      <p className="provider-hint">{t('providerHealth.hint')}</p>
      {busy && <p role="status">{t('providerHealth.reading')}</p>}
      {notice && (
        <p role="status" className="studio-notice">
          {notice}
        </p>
      )}
      {errors.map((error) => (
        <p className="session-error" role="alert" key={error}>
          {error}
        </p>
      ))}
      <h3>{t('providerHealth.accountQuota')}</h3>
      {loaded && !snapshots.length && <p>{t('providerHealth.noQuota')}</p>}
      <div className="provider-quota-grid">
        {snapshots
          .filter((item) => matches(item['providerId']) || matches(item['meterLabel']))
          .map((snapshot) => (
            <QuotaReading
              key={`${snapshot['providerId']}:${snapshot['meterId']}`}
              snapshot={snapshot}
            />
          ))}
      </div>
      {outcomes.length > 0 && (
        <section className="quota-refresh-outcomes" aria-label={t('providerHealth.refreshResults')}>
          {outcomes.map((outcome) => (
            <p
              key={String(outcome['providerId'])}
              className={outcome['ok'] === false ? 'session-error' : ''}
            >
              {String(outcome['providerId'])}:{' '}
              {outcome['ok'] === true ? t('providerHealth.readOk') : t('providerHealth.readFailed')}
              {outcome['throttled'] === true ? ` · ${t('providerHealth.throttled')}` : ''}
            </p>
          ))}
        </section>
      )}
      <h3>{t('providerHealth.waitingRoom')}</h3>
      {health && (
        <p>
          {t('providerHealth.counts', {
            blocked: String(health['blocked'] ?? 0),
            degraded: String(health['degraded'] ?? 0),
            healthy: String(health['healthy'] ?? 0),
          })}
        </p>
      )}
      {loaded && health && !statuses.length && <p>{t('providerHealth.noEntries')}</p>}
      <div className="provider-health-entries">
        {statuses
          .filter((entry) => matches(entry['providerId']) || matches(entry['model']))
          .map((entry) => (
            <article key={`${entry['providerId']}:${entry['model']}`}>
              <header>
                <strong>
                  {String(entry['providerId'])} / {String(entry['model'])}
                </strong>
                <span className="sdd-chip">{words(entry['state'])}</span>
              </header>
              <p>
                {words(entry['lastErrorKind']) || t('providerHealth.noError')}
                {entry['lastErrorStatus'] ? ` · HTTP ${entry['lastErrorStatus']}` : ''}
              </p>
              {typeof entry['lastErrorMessage'] === 'string' && <p>{entry['lastErrorMessage']}</p>}
              <p>
                {t('providerHealth.failures', {
                  failures: String(entry['totalFailures'] ?? 0),
                  consecutive: String(entry['consecutiveFailures'] ?? 0),
                  rateLimits: String(entry['rateLimitHits'] ?? 0),
                  successes: String(entry['totalSuccesses'] ?? 0),
                })}
              </p>
              <small>
                {t('providerHealth.lastFailure', {
                  failure: date(entry['lastFailureAt'], false, missing),
                  recovery: date(entry['stateExpiresAt'], false, missing),
                })}
              </small>
              <div className="sdd-actions">
                {entry['state'] === 'blocked' && (
                  <button
                    type="button"
                    className="button secondary"
                    disabled={busy}
                    onClick={() => void control(entry, 'retry')}
                  >
                    {t('providerHealth.release')}
                  </button>
                )}
                <button
                  type="button"
                  className="button secondary"
                  disabled={busy}
                  onClick={() => setClear(entry)}
                >
                  {t('providerHealth.clear')}
                </button>
              </div>
              <details>
                <summary>{t('providerHealth.recentErrors')}</summary>
                {entries(entry['recentErrors']).map((error, index) => (
                  <p key={index}>
                    {date(error['timestamp'], false, missing)} · {words(error['kind'])} ·{' '}
                    {String(error['message'] ?? '')}
                  </p>
                ))}
              </details>
            </article>
          ))}
      </div>
      {clear && (
        <div className="provider-management-confirm">
          <p>
            {t('providerHealth.clearConfirm', {
              provider: String(clear['providerId']),
              model: String(clear['model']),
            })}
          </p>
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() => setClear(null)}
          >
            {t('providerHealth.keep')}
          </button>
          <button
            type="button"
            className="button primary"
            disabled={busy}
            onClick={() => void control(clear, 'clear')}
          >
            {t('providerHealth.confirmClear')}
          </button>
        </div>
      )}
      <details className="provider-audit">
        <summary>{t('providerHealth.events', { number: audit.length })}</summary>
        {!audit.length && loaded && <p>{t('providerHealth.noEvents')}</p>}
        {audit.map((item, index) => (
          <article key={index}>
            <strong>
              {item['from'] && item['to']
                ? item['from'] === item['to']
                  ? words(item['to'])
                  : `${words(item['from'])} → ${words(item['to'])}`
                : t('providerHealth.event')}
            </strong>
            <small>{date(item['ts'], false, missing)}</small>
            <p>
              {String(item['providerId'] ?? item['provider'] ?? '')} {String(item['model'] ?? '')}
            </p>
            <p>
              {item['reason'] === 'manual_clear'
                ? t('providerHealth.trackingCleared')
                : item['reason'] === 'manual_retry'
                  ? t('providerHealth.released')
                  : words(item['message'] ?? item['reason'])}
            </p>
            {item['error'] !== null && typeof item['error'] === 'object' && (
              <p>
                {words(record(item['error'])['kind'])} · HTTP{' '}
                {String(record(item['error'])['status'] ?? missing)} ·{' '}
                {String(record(item['error'])['message'] ?? '')}
              </p>
            )}
          </article>
        ))}
      </details>
    </section>
  );
}
