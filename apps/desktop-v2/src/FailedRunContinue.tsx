import { TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { sessionAutonomy } from './autonomy-model';
import type { EngineState } from './engine-state';
import {
  automaticResumeDelayMs,
  automaticResumePrompt,
  failedRun,
  MANUAL_RESUME_PROMPT,
  nextAutomaticResume,
  RESUME_PAUSED_NOTICE,
  recordAutomaticResume,
  resetAutomaticResumes,
} from './failed-run-model';
import './failed-run.css';

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * A failed run's error with Continue, as the WebUI shows it under the failed answer. In `auto`
 * mode a run a provider killed on a recoverable error also resumes by itself after a countdown;
 * only a failure that arrives while the conversation is open arms it, so reopening an old
 * failure never sends anything on its own.
 */
export function FailedRunContinue({
  state,
  send,
  report,
}: {
  state: EngineState;
  /** Sends a prompt as it is; resolves with the composer notice. */
  send: (text: string) => Promise<string>;
  report: (notice: string, problem: string) => void;
}) {
  const result = state.results['run.result'];
  const failure = failedRun(state);
  const live = state.connected && !state.hydrating;
  const automatic = sessionAutonomy(state.results['prefs.updated']).mode === 'auto';
  const seen = useRef<{ session: string; result: unknown } | null>(null);
  const [armed, setArmed] = useState<{ result: unknown; attempt: number; at: number } | null>(null);
  const [paused, setPaused] = useState<unknown>(null);
  const [sent, setSent] = useState<unknown>(null);
  const [now, setNow] = useState(() => Date.now());
  const latest = useRef({ state, automatic });
  latest.current = { state, automatic };
  useEffect(() => {
    const previous = seen.current;
    seen.current = { session: state.sessionId, result };
    if (!live || previous?.session !== state.sessionId || previous.result === result) return;
    if (result?.['status'] === 'done') resetAutomaticResumes(state.sessionId);
    const current = failedRun(latest.current.state);
    if (!current?.resumable || !latest.current.automatic) return;
    const attempt = nextAutomaticResume(state.sessionId);
    if (attempt === null) setPaused(result);
    else setArmed({ result, attempt, at: Date.now() + automaticResumeDelayMs(attempt) });
  }, [result, live, state.sessionId]);
  const countdown = armed?.result === result && failure && automatic && live ? armed : null;
  const fire = (resume: { attempt: number } | null) => {
    setArmed(null);
    if (!failure || latest.current.state.running) return;
    const text = resume ? automaticResumePrompt(resume.attempt, failure) : MANUAL_RESUME_PROMPT;
    if (resume) recordAutomaticResume(state.sessionId);
    setSent(result);
    send(text).then(
      (notice) => report(notice, ''),
      (error: unknown) => {
        setSent(null);
        report('', reason(error));
      },
    );
  };
  const fireRef = useRef(fire);
  fireRef.current = fire;
  useEffect(() => {
    if (!countdown) return;
    const timer = setInterval(() => {
      setNow(Date.now());
      if (Date.now() >= countdown.at) {
        clearInterval(timer);
        fireRef.current(countdown);
      }
    }, 250);
    return () => clearInterval(timer);
  }, [countdown]);
  if (!failure || sent === result) return null;
  const [headline, ...rest] = failure.message.split('\n');
  const seconds = countdown ? Math.max(0, Math.ceil((countdown.at - now) / 1000)) : null;
  return (
    <div className="failed-run" role="status">
      <TriangleAlert size={15} />
      <div>
        <strong>The run stopped on an error</strong>
        <span>{headline}</span>
        {rest.join('\n').trim() && (
          <details>
            <summary>Details</summary>
            <pre>{rest.join('\n').trim()}</pre>
          </details>
        )}
        {paused === result && <small>{RESUME_PAUSED_NOTICE}</small>}
      </div>
      <button
        type="button"
        className="button small"
        disabled={!state.connected}
        onClick={() => fire(null)}
      >
        Continue{seconds === null ? '' : ` · ${seconds} s`}
      </button>
      {seconds !== null && (
        <button type="button" className="button secondary small" onClick={() => setArmed(null)}>
          Cancel
        </button>
      )}
    </div>
  );
}
