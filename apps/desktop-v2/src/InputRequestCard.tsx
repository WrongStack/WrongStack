import type { UserInputQuestion, UserInputRequest } from '@wrongstack/contracts/types';
import { LoaderCircle, MessageSquare } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import type { EngineSend } from './engine-operations';
import {
  type InputDraft,
  inputResponse,
  type QuestionDraft,
  recommendedDraft,
  unanswered,
} from './input-form-model';

export function InputRequestCard({
  request,
  draft,
  onChange,
  send,
  connected,
}: {
  request: UserInputRequest;
  draft?: InputDraft | undefined;
  onChange: (draft: InputDraft) => void;
  send: EngineSend;
  connected: boolean;
}) {
  const { t } = useDesktopText();
  const recommended = useMemo(() => recommendedDraft(request), [request]);
  const answers = draft ?? recommended;
  const [active, setActive] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => {
      setPending(false);
      setError(t('input.notConfirmed'));
    }, 15000);
    return () => clearTimeout(timer);
  }, [pending, t]);
  const submit = async (status: 'submitted' | 'cancelled') => {
    if (pending || !connected) return;
    setError('');
    try {
      const response = inputResponse(request, answers, status);
      setPending(true);
      await send('user.input_submit', { response });
    } catch (failure) {
      setPending(false);
      setError(failure instanceof Error ? failure.message : String(failure));
      const missing = unanswered(request, answers);
      if (missing)
        setActive(request.tabs.findIndex((tab) => tab.questions.some((q) => q.id === missing.id)));
    }
  };
  const tab = request.tabs[active] ?? request.tabs[0]!;
  return (
    <article className="input-request-card" aria-label={request.title}>
      <div className="input-request-heading">
        <MessageSquare size={17} />
        <span className="eyebrow">{t('input.eyebrow')}</span>
      </div>
      <h3>{request.title}</h3>
      {request.description && <p>{request.description}</p>}
      {request.tabs.length > 1 && (
        <nav className="input-request-tabs" aria-label={t('input.groups')}>
          {request.tabs.map((item, index) => (
            <button
              key={item.id}
              type="button"
              aria-current={index === active ? 'step' : undefined}
              onClick={() => setActive(index)}
            >
              {item.label}
            </button>
          ))}
        </nav>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit('submitted');
        }}
      >
        <section aria-label={tab.label}>
          {tab.description && <p>{tab.description}</p>}
          {tab.questions.map((question) => (
            <QuestionFields
              key={question.id}
              requestId={request.id}
              question={question}
              value={
                Object.hasOwn(answers, question.id)
                  ? answers[question.id]!
                  : recommended[question.id]!
              }
              disabled={pending || !connected}
              onChange={(value) => onChange({ ...answers, [question.id]: value })}
            />
          ))}
        </section>
        {error && (
          <p className="input-request-error" role="alert">
            {error}
          </p>
        )}
        <div className="input-request-actions">
          <button
            type="button"
            className="button secondary"
            disabled={pending || !connected}
            onClick={() => void submit('cancelled')}
          >
            {t('input.cancel')}
          </button>
          <button type="submit" className="button primary" disabled={pending || !connected}>
            {pending && <LoaderCircle size={13} className="spin" />}
            {pending ? t('input.waiting') : request.submitLabel || t('input.submit')}
          </button>
        </div>
        {pending && (
          <p className="provider-hint" role="status">
            {t('input.sent')}
          </p>
        )}
      </form>
    </article>
  );
}
function QuestionFields({
  question: q,
  value,
  disabled,
  onChange,
  requestId,
}: {
  question: UserInputQuestion;
  value: QuestionDraft;
  disabled: boolean;
  onChange: (value: QuestionDraft) => void;
  requestId: string;
}) {
  const { t } = useDesktopText();
  return (
    <fieldset className="input-question" disabled={disabled}>
      <legend>
        {q.prompt}
        {q.required === false && <small>{t('input.optional')}</small>}
      </legend>
      {q.description && <p>{q.description}</p>}
      {q.recommendationReason && (
        <p className="input-recommendation">
          {t('input.recommendation', { reason: q.recommendationReason })}
        </p>
      )}
      {q.kind !== 'text' && (
        <div className="input-options">
          {q.options?.map((option) => (
            <label className="input-option" key={option.id}>
              <input
                type={q.kind === 'single_select' ? 'radio' : 'checkbox'}
                name={`${requestId}:${q.id}`}
                checked={value.selectedOptionIds.includes(option.id)}
                disabled={value.delegated}
                onChange={() =>
                  onChange({
                    ...value,
                    delegated: false,
                    text: q.kind === 'single_select' ? '' : value.text,
                    selectedOptionIds:
                      q.kind === 'single_select'
                        ? [option.id]
                        : value.selectedOptionIds.includes(option.id)
                          ? value.selectedOptionIds.filter((id) => id !== option.id)
                          : [...value.selectedOptionIds, option.id],
                  })
                }
              />
              <span>
                <strong>{option.label}</strong>
                {q.recommendedOptionIds?.includes(option.id) && (
                  <small>{t('input.recommended')}</small>
                )}
                {option.description && (
                  <span className="input-option-description">{option.description}</span>
                )}
              </span>
            </label>
          ))}
        </div>
      )}
      {(q.kind === 'text' || q.allowCustomResponse !== false) && (
        <label className="input-text-label">
          {q.kind === 'text' ? t('input.yourAnswer') : t('input.writeOwn')}
          <textarea
            aria-label={q.kind === 'text' ? q.prompt : t('input.customLabel', { prompt: q.prompt })}
            value={value.text}
            placeholder={q.placeholder ?? t('input.typeAnswer')}
            disabled={value.delegated}
            onChange={(event) =>
              onChange({
                ...value,
                text: event.target.value,
                selectedOptionIds: q.kind === 'single_select' ? [] : value.selectedOptionIds,
              })
            }
          />
        </label>
      )}
      <label className="input-delegate">
        <input
          type="checkbox"
          checked={value.delegated}
          onChange={(event) => onChange({ ...value, delegated: event.target.checked })}
        />
        {t('input.delegate')}
      </label>
    </fieldset>
  );
}
