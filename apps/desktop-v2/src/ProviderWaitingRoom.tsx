import type { ModelBlackoutRule } from '@wrongstack/contracts/types/model-availability';
import { blockingCalendarRules, ruleTarget } from '@wrongstack/project-surfaces/lib/model-calendar';
import type { TFunction } from 'i18next';
import { AlertTriangle, Clock3, RefreshCw, RotateCcw, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';
import type { EngineState } from './engine-state';
import { siblingTrigger, type WaitingPair, waitRemaining } from './provider-waiting';
import './provider-waiting-room.css';

function ago(at: number | undefined, now: number, t: TFunction<'desktop'>) {
  if (!at) return '';
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  const minutes = Math.floor(seconds / 60);
  const time =
    seconds < 60
      ? `${seconds}s`
      : minutes < 60
        ? `${minutes}m`
        : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return t('waiting.ago', { time });
}

function WaitingPairRow({
  pair,
  now,
  busy,
  onControl,
}: {
  pair: WaitingPair;
  now: number;
  busy: boolean;
  onControl: (pair: WaitingPair, action: 'retry' | 'clear') => void;
}) {
  const { t } = useDesktopText();
  const [open, setOpen] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const via = siblingTrigger(pair);
  const name = `${pair.providerId}/${pair.model}`;
  return (
    <li>
      <button
        type="button"
        className="waiting-pair"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Clock3 size={13} />
        <code>{name}</code>
        <span className="waiting-state">{t(`waiting.state.${pair.state}`)}</span>
        <span>{pair.reason.replaceAll('_', ' ')}</span>
        {via && <span className="waiting-via">{t('waiting.via', { via })}</span>}
        <span className="waiting-left">
          {!pair.stateExpiresAt
            ? t('waiting.resetUnknown')
            : pair.stateExpiresAt <= now
              ? t('waiting.rechecking')
              : waitRemaining(pair.stateExpiresAt, now)}
        </span>
      </button>
      {open && (
        <div className="waiting-detail">
          {pair.lastErrorMessage && (
            <p className="waiting-error">
              {t('waiting.lastError', { message: pair.lastErrorMessage.slice(0, 300) })}
            </p>
          )}
          <p className="waiting-counts">
            {pair.totalFailures !== undefined && (
              <span>{t('waiting.failures', { count: pair.totalFailures })}</span>
            )}
            {pair.rateLimitHits ? (
              <span>{t('waiting.rateLimits', { count: pair.rateLimitHits })}</span>
            ) : null}
            {pair.consecutiveFailures !== undefined && (
              <span>{t('waiting.streak', { count: pair.consecutiveFailures })}</span>
            )}
            {pair.lastErrorStatus !== undefined && <span>HTTP {pair.lastErrorStatus}</span>}
            {pair.lastFailureAt && <span>{ago(pair.lastFailureAt, now, t)}</span>}
          </p>
          {pair.recentErrors?.length ? (
            <details>
              <summary>{t('waiting.history', { count: pair.recentErrors.length })}</summary>
              <ul className="waiting-history">
                {pair.recentErrors.map((error, index) => (
                  <li key={index}>
                    <span>{error.kind}</span>
                    <span>HTTP {error.status}</span>
                    <span className="waiting-message">{error.message.slice(0, 200)}</span>
                    <span>{ago(error.timestamp, now, t)}</span>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          {confirmClear ? (
            <div className="waiting-actions">
              <span>{t('waiting.clearConfirm', { name })}</span>
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => setConfirmClear(false)}
              >
                {t('waiting.keep')}
              </button>
              <button
                type="button"
                className="button primary"
                disabled={busy}
                onClick={() => onControl(pair, 'clear')}
              >
                {t('waiting.clear')}
              </button>
            </div>
          ) : (
            <div className="waiting-actions">
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => onControl(pair, 'retry')}
              >
                <RotateCcw size={13} />
                {t('waiting.release')}
              </button>
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => setConfirmClear(true)}
              >
                <Trash2 size={13} />
                {t('waiting.clear')}
              </button>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * The WebUI's waiting room above the composer: provider/model pairs the health tracker is
 * holding back until their limit resets, and calendar blackouts in force now. It reads the
 * room folded from the conversation's frames and asks the engine for a fresh snapshot once
 * the conversation is live, since a replayed journal can still hold pairs that recovered.
 */
export function ProviderWaitingRoom({
  state,
  command,
}: {
  state: EngineState;
  command: EngineCommand;
}) {
  const { t } = useDesktopText();
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const pairs = useMemo(
    () =>
      Object.values(state.waiting).sort(
        (a, b) => (a.stateExpiresAt ?? 0) - (b.stateExpiresAt ?? 0),
      ),
    [state.waiting],
  );
  const schedule = state.results['prefs.updated']?.['modelAvailabilitySchedule'];
  const rules = useMemo(
    () =>
      blockingCalendarRules(
        Array.isArray(schedule) ? (schedule as ModelBlackoutRule[]) : [],
        new Date(now),
      ),
    [schedule, now],
  );
  const live = state.synced && !state.hydrating;
  useEffect(() => {
    if (!live) return;
    command('provider.status.get', {}, ['provider.status.snapshot']).catch(() => undefined);
  }, [live, command]);
  const waiting = pairs.length + rules.length > 0;
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [waiting]);
  if (!waiting) return null;
  const refresh = () => {
    setError('');
    command('provider.status.get', {}, ['provider.status.snapshot']).catch((reason) =>
      setError(String(reason)),
    );
  };
  const control = async (pair: WaitingPair, action: 'retry' | 'clear') => {
    setBusy(true);
    setError('');
    try {
      await command(
        `provider.status.${action}`,
        { providerId: pair.providerId, model: pair.model },
        ['key.operation_result'],
      );
      await command('provider.status.get', {}, ['provider.status.snapshot']);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };
  const blocked = pairs.filter((pair) => pair.state === 'blocked').length;
  return (
    <section className="waiting-room" aria-label={t('waiting.label')}>
      <div className="waiting-summary">
        <button type="button" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
          <AlertTriangle size={14} />
          <strong>{t('waiting.title')}</strong>
          <span>
            {t('waiting.summary', {
              blocked,
              degraded: pairs.length - blocked,
              scheduled: rules.length,
            })}
          </span>
          <span className="waiting-left">
            {expanded ? t('waiting.hide') : t('waiting.details')}
          </span>
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label={t('waiting.refresh')}
          title={t('waiting.refresh')}
          onClick={refresh}
        >
          <RefreshCw size={13} />
        </button>
      </div>
      {expanded && (
        <div className="waiting-body">
          <ul>
            {pairs.map((pair) => (
              <WaitingPairRow
                key={`${pair.providerId}/${pair.model}`}
                pair={pair}
                now={now}
                busy={busy}
                onControl={(target, action) => void control(target, action)}
              />
            ))}
            {rules.map((rule) => (
              <li key={rule.id} className="waiting-pair">
                <Clock3 size={13} />
                <code>{ruleTarget(rule)}</code>
                <span className="waiting-state scheduled">{t('waiting.scheduled')}</span>
                <span>{rule.label ?? t('waiting.blackout')}</span>
                <span className="waiting-left">
                  {rule.start}–{rule.end} · {rule.timezone ?? t('waiting.localTime')}
                </span>
              </li>
            ))}
          </ul>
          {error && (
            <p className="session-error" role="alert">
              {error}
            </p>
          )}
          <small>{t('waiting.note')}</small>
        </div>
      )}
    </section>
  );
}
