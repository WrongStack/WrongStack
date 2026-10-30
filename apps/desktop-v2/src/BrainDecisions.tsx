import { useCallback, useEffect, useState } from 'react';
import './brain-policy.css';
import type { EngineCommand } from './engine-operations';
import { entries, record } from './engine-values';

export interface BrainLogRow {
  at: number;
  kind: string;
  question: string;
  outcome: string;
  tier: string;
}

/** The engine's `brain.status`: ceiling, recent decisions (newest first) and seats. */
export function brainStatus(value: unknown): {
  maxAutoRisk: string;
  mode: string;
  log: BrainLogRow[];
} {
  const row = record(value);
  return {
    maxAutoRisk: typeof row['maxAutoRisk'] === 'string' ? row['maxAutoRisk'] : 'unknown',
    mode: typeof row['mode'] === 'string' ? row['mode'] : '',
    log: entries(row['log'])
      .map((entry) => ({
        at: typeof entry['at'] === 'number' ? entry['at'] : 0,
        kind: String(entry['kind'] ?? ''),
        question: String(entry['question'] ?? ''),
        outcome: String(entry['outcome'] ?? ''),
        tier: typeof entry['tier'] === 'string' ? entry['tier'] : '',
      }))
      .sort((a, b) => b.at - a.at),
  };
}

/** One readable line for a `brain.answer` decision. */
export function brainAnswerText(value: unknown): string {
  const decision = record(record(value)['decision']);
  const why = typeof decision['rationale'] === 'string' ? ` (${decision['rationale']})` : '';
  if (decision['type'] === 'answer') return `Answer: ${String(decision['text'] ?? '')}${why}`;
  if (decision['type'] === 'ask_human')
    return `The Brain would ask you: ${String(decision['prompt'] ?? '')}${why}`;
  if (decision['type'] === 'deny') return `Refused: ${String(decision['reason'] ?? '')}`;
  return 'The Brain returned no decision.';
}

/**
 * The Brain's recent decisions for this conversation (and unattributed ones), the current
 * auto-decision ceiling, and a direct question to the configured Brain. Asking spends a
 * provider call when the Brain needs a model.
 */
export function BrainDecisions({ command }: { command: EngineCommand }) {
  const [status, setStatus] = useState<ReturnType<typeof brainStatus> | null>(null),
    [question, setQuestion] = useState(''),
    [answer, setAnswer] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const load = useCallback(async () => {
    setStatus(brainStatus(await command('brain.status', {}, ['brain.status'])));
  }, [command]);
  useEffect(() => {
    void load().catch((failure) => setError(String(failure)));
  }, [load]);
  const ask = async () => {
    setBusy(true);
    setError('');
    setAnswer('');
    try {
      const reply = await command('brain.ask', { question: question.trim() }, [
        'brain.answer',
        'key.operation_result',
      ]);
      setAnswer(brainAnswerText(reply));
      await load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="brain-decisions" aria-label="Brain decisions">
      <h3>Decisions</h3>
      {status && (
        <p className="field-help">
          Decides without asking up to <strong>{status.maxAutoRisk}</strong> risk
          {status.mode ? ` · ${status.mode} mode` : ''}. Shown: this conversation's decisions and
          ones that named no conversation.
        </p>
      )}
      {status && status.log.length === 0 && <p>No decisions recorded yet.</p>}
      {status && status.log.length > 0 && (
        <ol className="brain-decision-log">
          {status.log.slice(0, 50).map((entry, index) => (
            <li key={`${entry.at}:${index}`}>
              <span>
                {entry.at ? new Date(entry.at).toLocaleTimeString() : ''} · {entry.kind}
                {entry.tier ? ` · ${entry.tier}` : ''}
              </span>
              <strong>{entry.question}</strong>
              <span>{entry.outcome}</span>
            </li>
          ))}
        </ol>
      )}
      <form
        className="brain-ask"
        onSubmit={(event) => {
          event.preventDefault();
          if (question.trim()) void ask();
        }}
      >
        <label>
          Ask the Brain
          <textarea
            value={question}
            rows={3}
            maxLength={4000}
            disabled={busy}
            placeholder="Should this project allow automatic dependency upgrades?"
            onChange={(event) => setQuestion(event.target.value)}
          />
        </label>
        <button
          type="submit"
          className="button secondary small"
          disabled={busy || !question.trim()}
        >
          {busy ? 'Asking…' : 'Ask'}
        </button>
      </form>
      {answer && <p role="status">{answer}</p>}
      {error && (
        <p role="alert" className="session-error">
          {error}
        </p>
      )}
    </section>
  );
}
