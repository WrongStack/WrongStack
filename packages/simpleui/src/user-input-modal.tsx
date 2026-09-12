import { Check, Sparkles } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { UserInputQuestion, UserInputRequest } from './types.js';

type DraftAnswer = {
  selected: string[];
  text: string;
  customSelected: boolean;
  delegated: boolean;
};
type Draft = Record<string, DraftAnswer>;
const EMPTY_ANSWER: DraftAnswer = {
  selected: [],
  text: '',
  customSelected: false,
  delegated: false,
};
export function UserInputModal({
  pending,
  queuedCount,
  send,
}: {
  pending: { request: UserInputRequest; sessionId?: string } | null;
  queuedCount: number;
  send: (type: string, payload: Record<string, unknown>) => void;
}) {
  const [round, setRound] = useState<string | null>(null);
  const [tab, setTab] = useState(0);
  const [draft, setDraft] = useState<Draft>({});
  const [validationMessage, setValidationMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  if ((pending?.request.id ?? null) !== round) {
    setRound(pending?.request.id ?? null);
    setTab(0);
    setDraft(pending ? initial(pending.request) : {});
    setValidationMessage('');
    setSubmitting(false);
  }
  const questions = useMemo(
    () => pending?.request.tabs.flatMap((item) => item.questions) ?? [],
    [pending],
  );
  if (!pending) return null;
  const active = pending.request.tabs[tab] ?? pending.request.tabs[0]!;
  const missing = questions.filter((q) => q.required && !hasAnswer(draft[q.id]));
  const valid = missing.length === 0;
  const submit = () => {
    if (!valid) {
      const first = missing[0]!;
      const targetTab = pending.request.tabs.findIndex((item) =>
        item.questions.some((question) => question.id === first.id),
      );
      setTab(Math.max(0, targetTab));
      setValidationMessage(`Answer required: ${first.prompt}`);
      window.requestAnimationFrame(() =>
        document.getElementById(`simple-user-input-${first.id}`)?.focus(),
      );
      return;
    }
    setSubmitting(true);
    send('user.input_submit', {
      sessionId: pending.sessionId,
      response: {
        requestId: pending.request.id,
        status: 'submitted',
        answers: questions.map((q) => {
          const value = draft[q.id] ?? EMPTY_ANSWER;
          const rec = q.recommendedOptionIds ?? [];
          return {
            questionId: q.id,
            selectedOptionIds: value.delegated ? [] : value.selected,
            ...(!value.delegated && (q.kind === 'text' || value.customSelected) && value.text.trim()
              ? { text: value.text.trim() }
              : {}),
            delegated: value.delegated,
            usedRecommendation:
              !value.delegated &&
              value.selected.length === rec.length &&
              value.selected.every((id) => rec.includes(id)) &&
              (q.recommendedText ?? '') ===
                (q.kind === 'text' || value.customSelected ? value.text.trim() : '') &&
              (rec.length > 0 || Boolean(q.recommendedText)),
          };
        }),
      },
    });
  };
  const applyRecommendations = (scope: 'tab' | 'all') => {
    const targets = scope === 'all' ? questions : active.questions;
    setDraft((current) => {
      const next = { ...current };
      for (const question of targets) {
        if (!question.recommendedOptionIds?.length && !question.recommendedText) continue;
        next[question.id] = {
          selected: [...(question.recommendedOptionIds ?? [])],
          text: question.recommendedText ?? '',
          customSelected: Boolean(question.recommendedText),
          delegated: false,
        };
      }
      return next;
    });
    setValidationMessage('Recommended answers applied.');
  };
  const delegateUnanswered = () => {
    setDraft((current) => {
      const next = { ...current };
      for (const question of questions) {
        const value = current[question.id] ?? EMPTY_ANSWER;
        if (!hasAnswer(value)) {
          next[question.id] = {
            ...value,
            selected: [],
            customSelected: false,
            delegated: true,
          };
        }
      }
      return next;
    });
    setValidationMessage('Unanswered decisions delegated to the model.');
  };
  return (
    <div
      className="fallback-modal-overlay user-input-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={pending.request.title}
    >
      <div className="fallback-modal user-input-modal">
        <div className="fallback-modal-header">
          <span className="fallback-modal-title">{pending.request.title}</span>
        </div>
        {pending.request.description && (
          <p className="fallback-modal-hint">{pending.request.description}</p>
        )}
        {queuedCount > 1 && <p className="fallback-modal-hint">Form 1 of {queuedCount} waiting</p>}
        {pending.request.tabs.length > 1 && (
          <div className="user-input-tabs">
            {pending.request.tabs.map((item, i) => (
              <button
                type="button"
                className={i === tab ? 'selected' : ''}
                onClick={() => setTab(i)}
                key={item.id}
              >
                {item.label} {answeredCount(item.questions, draft)}/{item.questions.length}
              </button>
            ))}
          </div>
        )}
        <div className="user-input-body" data-testid="user-input-scroll-region">
          {active.description && <p className="fallback-modal-hint">{active.description}</p>}
          <div className="user-input-progress">
            <span>
              {answeredCount(active.questions, draft)}/{active.questions.length} answered
            </span>
            <button type="button" onClick={delegateUnanswered}>
              Let model decide unanswered
            </button>
            <button type="button" onClick={() => applyRecommendations('tab')}>
              Apply tab recommendations
            </button>
            {pending.request.tabs.length > 1 && (
              <button type="button" onClick={() => applyRecommendations('all')}>
                Apply all recommendations
              </button>
            )}
          </div>
          {active.questions.map((q) => (
            <div
              id={`simple-user-input-${q.id}`}
              tabIndex={-1}
              className={`user-input-question-card ${q.required && !hasAnswer(draft[q.id]) ? 'missing' : ''}`}
              key={q.id}
            >
              <Question
                q={q}
                value={draft[q.id] ?? EMPTY_ANSWER}
                onChange={(value) => {
                  setDraft((old) => ({ ...old, [q.id]: value }));
                  setValidationMessage('');
                }}
              />
            </div>
          ))}
        </div>
        <div className="fallback-modal-footer">
          <span>
            {validationMessage ||
              (valid ? 'Ready' : `${missing.length} required answer(s) missing`)}
          </span>
          <button type="button" disabled={submitting} onClick={submit}>
            {submitting ? 'Submitting…' : (pending.request.submitLabel ?? 'Submit answers')}
          </button>
        </div>
      </div>
    </div>
  );
}
function Question({
  q,
  value,
  onChange,
}: {
  q: UserInputQuestion;
  value: DraftAnswer;
  onChange: (v: DraftAnswer) => void;
}) {
  return (
    <fieldset className="user-input-question">
      <legend>
        {q.prompt}
        {q.required ? ' *' : ''}
      </legend>
      {q.description && <p>{q.description}</p>}
      {q.recommendationReason && (
        <div className="user-input-reason">
          <Sparkles size={13} /> <b>Recommendation:</b> {q.recommendationReason}
        </div>
      )}
      {q.kind === 'text' ? (
        <textarea
          placeholder={q.placeholder}
          value={value.text}
          onChange={(e) =>
            onChange({
              ...value,
              text: e.target.value,
              customSelected: true,
              delegated: false,
            })
          }
        />
      ) : (
        <>
          {q.options?.map((option) => {
            const checked = value.selected.includes(option.id);
            const recommended = q.recommendedOptionIds?.includes(option.id);
            return (
              <label className={checked ? 'selected' : ''} key={option.id}>
                <input
                  type={q.kind === 'multi_select' ? 'checkbox' : 'radio'}
                  name={q.id}
                  checked={checked}
                  onChange={() =>
                    onChange({
                      ...value,
                      selected:
                        q.kind === 'multi_select'
                          ? checked
                            ? value.selected.filter((id) => id !== option.id)
                            : [...value.selected, option.id]
                          : [option.id],
                      customSelected: q.kind === 'single_select' ? false : value.customSelected,
                      delegated: false,
                    })
                  }
                />
                <span>
                  <b>{option.label}</b>
                  {recommended && (
                    <em>
                      <Check size={11} /> Recommended
                    </em>
                  )}
                  {option.description && <small>{option.description}</small>}
                </span>
              </label>
            );
          })}
          {q.allowCustomResponse && (
            <label
              className={
                value.customSelected ? 'selected user-input-custom-row' : 'user-input-custom-row'
              }
            >
              <input
                type={q.kind === 'multi_select' ? 'checkbox' : 'radio'}
                name={q.id}
                aria-label="Select custom answer"
                checked={value.customSelected}
                onChange={() =>
                  onChange({
                    ...value,
                    selected: q.kind === 'single_select' ? [] : value.selected,
                    customSelected: !value.customSelected,
                    delegated: false,
                  })
                }
              />
              <input
                className="user-input-custom"
                aria-label="Custom answer"
                placeholder={q.placeholder ?? 'Other / custom answer (optional)'}
                value={value.text}
                onFocus={() =>
                  onChange({
                    ...value,
                    selected: q.kind === 'single_select' ? [] : value.selected,
                    customSelected: true,
                    delegated: false,
                  })
                }
                onChange={(e) =>
                  onChange({
                    ...value,
                    selected: q.kind === 'single_select' ? [] : value.selected,
                    text: e.target.value,
                    customSelected: true,
                    delegated: false,
                  })
                }
              />
            </label>
          )}
        </>
      )}
      <button
        type="button"
        aria-pressed={value.delegated}
        className={`user-input-delegate ${value.delegated ? 'selected' : ''}`}
        onClick={() =>
          onChange({ ...value, selected: [], customSelected: false, delegated: !value.delegated })
        }
      >
        <b>You decide</b>
        <small>I do not want to answer this question. Let the model choose.</small>
      </button>
    </fieldset>
  );
}
function initial(request: UserInputRequest): Draft {
  return Object.fromEntries(
    request.tabs.flatMap((tab) =>
      tab.questions.map((q) => [
        q.id,
        {
          selected: [...(q.recommendedOptionIds ?? [])],
          text: q.recommendedText ?? '',
          customSelected: Boolean(q.recommendedText),
          delegated: false,
        },
      ]),
    ),
  );
}
function hasAnswer(value?: DraftAnswer): boolean {
  return Boolean(
    value &&
      (value.delegated || value.selected.length > 0 || (value.customSelected && value.text.trim())),
  );
}
function answeredCount(questions: UserInputQuestion[], draft: Draft): number {
  return questions.filter((question) => hasAnswer(draft[question.id])).length;
}
