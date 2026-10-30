import { ArrowRightLeft } from 'lucide-react';
import './session-todos.css';
import { useEffect, useState } from 'react';
import type { EngineSend } from './engine-operations';
import type { EngineState } from './engine-state';
import { entries, record } from './engine-values';

export interface FallbackPending {
  requestId: string;
  from: { providerId: string; model: string };
  status: number;
  candidates: { providerId: string; model: string }[];
  /** When the engine switches to the first candidate by itself. */
  deadline: number;
}

/** The engine's `provider.fallback_pending`; null when malformed or without candidates. */
export function fallbackPending(value: unknown): FallbackPending | null {
  const row = record(value);
  const from = record(row['from']);
  const candidates = entries(row['candidates'])
    .filter((item) => typeof item['providerId'] === 'string' && typeof item['model'] === 'string')
    .map((item) => ({ providerId: String(item['providerId']), model: String(item['model']) }));
  if (typeof row['requestId'] !== 'string' || !row['requestId'] || candidates.length === 0)
    return null;
  const seconds = typeof row['autoSwitchSeconds'] === 'number' ? row['autoSwitchSeconds'] : 0;
  const start = typeof row['timestamp'] === 'number' ? row['timestamp'] : Date.now();
  return {
    requestId: row['requestId'],
    from: { providerId: String(from['providerId'] ?? ''), model: String(from['model'] ?? '') },
    status: typeof row['status'] === 'number' ? row['status'] : 0,
    candidates,
    deadline: start + Math.max(0, seconds) * 1000,
  };
}

/**
 * Shown while the engine's fallback gate waits: the active model failed after its own retries
 * and the configured fallback chain is about to engage. Picking a candidate or "Switch now"
 * answers the gate (`model.fallback_choice`); otherwise the engine moves to the first candidate
 * when the countdown ends.
 */
export function FallbackPicker({ state, send }: { state: EngineState; send: EngineSend }) {
  const pending = fallbackPending(state.results['provider.fallback_pending']);
  const [answered, setAnswered] = useState(''),
    [now, setNow] = useState(() => Date.now()),
    [error, setError] = useState('');
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [pending?.requestId]);
  if (!pending || answered === pending.requestId || now >= pending.deadline) return null;
  const choose = (choice: Record<string, unknown>) => {
    setAnswered(pending.requestId);
    setError('');
    void send('model.fallback_choice', { requestId: pending.requestId, ...choice }).catch(
      (failure) => setError(failure instanceof Error ? failure.message : String(failure)),
    );
  };
  const remaining = Math.max(0, Math.ceil((pending.deadline - now) / 1000));
  return (
    <section className="fallback-picker" role="alert" aria-label="Model fallback">
      <p>
        <ArrowRightLeft size={14} /> {pending.from.providerId} / {pending.from.model} failed
        {pending.status ? ` (status ${pending.status})` : ''} after its retries. Switching to{' '}
        <strong>
          {pending.candidates[0]!.providerId} / {pending.candidates[0]!.model}
        </strong>{' '}
        in {remaining} s.
      </p>
      <div className="fallback-picker-actions">
        <button
          type="button"
          className="button primary small"
          onClick={() => choose({ autoSwitch: true })}
        >
          Switch now
        </button>
        {pending.candidates.slice(1, 6).map((candidate) => (
          <button
            key={`${candidate.providerId}/${candidate.model}`}
            type="button"
            className="button secondary small"
            onClick={() => choose({ providerId: candidate.providerId, model: candidate.model })}
          >
            Use {candidate.providerId} / {candidate.model}
          </button>
        ))}
      </div>
      {error && <p className="session-error">{error}</p>}
    </section>
  );
}
