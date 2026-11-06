import { useCallback, useEffect, useState } from 'react';
import { Trans } from 'react-i18next';
import './brain-policy.css';
import { useDesktopText } from './desktop-i18n';
import { displayTime } from './display-dates';
import type { EngineCommand } from './engine-operations';
import { entries, record } from './engine-values';
import { surfaceI18n } from './surface-i18n';

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

/** English wording of an answer; the desktop passes the display-language catalog. */
const ANSWER_WORDS = {
  answer: 'Answer: {{text}}{{why}}',
  ask: 'The Brain would ask you: {{prompt}}{{why}}',
  deny: 'Refused: {{reason}}',
  none: 'The Brain returned no decision.',
  why: ' ({{rationale}})',
} as const;
export type BrainAnswerSay = (
  word: keyof typeof ANSWER_WORDS,
  values?: Record<string, string>,
) => string;
const english: BrainAnswerSay = (word, values = {}) =>
  ANSWER_WORDS[word].replace(/\{\{(\w+)\}\}/g, (_, name: string) => values[name] ?? '');

/** One readable line for a `brain.answer` decision. */
export function brainAnswerText(value: unknown, say: BrainAnswerSay = english): string {
  const decision = record(record(value)['decision']);
  const why =
    typeof decision['rationale'] === 'string'
      ? say('why', { rationale: decision['rationale'] })
      : '';
  if (decision['type'] === 'answer')
    return say('answer', { text: String(decision['text'] ?? ''), why });
  if (decision['type'] === 'ask_human')
    return say('ask', { prompt: String(decision['prompt'] ?? ''), why });
  if (decision['type'] === 'deny') return say('deny', { reason: String(decision['reason'] ?? '') });
  return say('none');
}

/**
 * The Brain's recent decisions for this conversation (and unattributed ones), the current
 * auto-decision ceiling, and a direct question to the configured Brain. Asking spends a
 * provider call when the Brain needs a model.
 */
export function BrainDecisions({ command }: { command: EngineCommand }) {
  const { t } = useDesktopText();
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
      setAnswer(
        brainAnswerText(reply, (word, values) => t(`brainDecisions.answer.${word}`, values ?? {})),
      );
      await load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="brain-decisions" aria-label={t('brainDecisions.label')}>
      <h3>{t('brainDecisions.title')}</h3>
      {status && (
        <p className="field-help">
          <Trans
            i18n={surfaceI18n}
            ns="desktop"
            i18nKey="brainDecisions.summary"
            values={{
              risk: status.maxAutoRisk,
              mode: status.mode ? t('brainDecisions.mode', { mode: status.mode }) : '',
            }}
            components={{ strong: <strong /> }}
          />
        </p>
      )}
      {status && status.log.length === 0 && <p>{t('brainDecisions.none')}</p>}
      {status && status.log.length > 0 && (
        <ol className="brain-decision-log">
          {status.log.slice(0, 50).map((entry, index) => (
            <li key={`${entry.at}:${index}`}>
              <span>
                {entry.at ? displayTime(entry.at) : ''} · {entry.kind}
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
          {t('brainDecisions.ask')}
          <textarea
            value={question}
            rows={3}
            maxLength={4000}
            disabled={busy}
            placeholder={t('brainDecisions.placeholder')}
            onChange={(event) => setQuestion(event.target.value)}
          />
        </label>
        <button
          type="submit"
          className="button secondary small"
          disabled={busy || !question.trim()}
        >
          {busy ? t('brainDecisions.asking') : t('brainDecisions.submit')}
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
