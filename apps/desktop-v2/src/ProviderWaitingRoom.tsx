import type { ModelBlackoutRule } from '@wrongstack/contracts/types/model-availability';
import { blockingCalendarRules, ruleTarget } from '@wrongstack/project-surfaces/lib/model-calendar';
import { AlertTriangle, Clock3, RefreshCw, RotateCcw, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { EngineCommand } from './engine-operations';
import type { EngineState } from './engine-state';
import { siblingTrigger, type WaitingPair, waitRemaining } from './provider-waiting';
import './provider-waiting-room.css';

function ago(at: number | undefined, now: number) {
  if (!at) return '';
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ago` : `${Math.floor(minutes / 60)}h ${minutes % 60}m ago`;
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
        <span className="waiting-state">{pair.state}</span>
        <span>{pair.reason.replaceAll('_', ' ')}</span>
        {via && <span className="waiting-via">via {via}</span>}
        <span className="waiting-left">{waitRemaining(pair.stateExpiresAt, now)}</span>
      </button>
      {open && (
        <div className="waiting-detail">
          {pair.lastErrorMessage && (
            <p className="waiting-error">Last error: {pair.lastErrorMessage.slice(0, 300)}</p>
          )}
          <p className="waiting-counts">
            {pair.totalFailures !== undefined && <span>failures: {pair.totalFailures}</span>}
            {pair.rateLimitHits ? <span>rate limits: {pair.rateLimitHits}</span> : null}
            {pair.consecutiveFailures !== undefined && (
              <span>streak: {pair.consecutiveFailures}</span>
            )}
            {pair.lastErrorStatus !== undefined && <span>HTTP {pair.lastErrorStatus}</span>}
            {pair.lastFailureAt && <span>{ago(pair.lastFailureAt, now)}</span>}
          </p>
          {pair.recentErrors?.length ? (
            <details>
              <summary>Error history ({pair.recentErrors.length})</summary>
              <ul className="waiting-history">
                {pair.recentErrors.map((error, index) => (
                  <li key={index}>
                    <span>{error.kind}</span>
                    <span>HTTP {error.status}</span>
                    <span className="waiting-message">{error.message.slice(0, 200)}</span>
                    <span>{ago(error.timestamp, now)}</span>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          {confirmClear ? (
            <div className="waiting-actions">
              <span>
                Clear tracked failures for {name}? This resets local health history; it does not
                restore account quota.
              </span>
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => setConfirmClear(false)}
              >
                Keep
              </button>
              <button
                type="button"
                className="button primary"
                disabled={busy}
                onClick={() => onControl(pair, 'clear')}
              >
                Clear tracking
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
                Release for next probe
              </button>
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => setConfirmClear(true)}
              >
                <Trash2 size={13} />
                Clear tracking
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
    <section className="waiting-room" aria-label="Provider and model availability">
      <div className="waiting-summary">
        <button type="button" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
          <AlertTriangle size={14} />
          <strong>Provider/model availability</strong>
          <span>
            {blocked} blocked · {pairs.length - blocked} degraded · {rules.length} scheduled
          </span>
          <span className="waiting-left">{expanded ? 'Hide' : 'Details'}</span>
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Refresh provider status"
          title="Refresh provider status"
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
                <span className="waiting-state scheduled">scheduled</span>
                <span>{rule.label ?? 'calendar blackout'}</span>
                <span className="waiting-left">
                  {rule.start}–{rule.end} · {rule.timezone ?? 'local time'}
                </span>
              </li>
            ))}
          </ul>
          {error && (
            <p className="session-error" role="alert">
              {error}
            </p>
          )}
          <small>
            WrongStack routes around these until their reset time or schedule ends. Settings →
            Provider health shows the full history.
          </small>
        </div>
      )}
    </section>
  );
}
