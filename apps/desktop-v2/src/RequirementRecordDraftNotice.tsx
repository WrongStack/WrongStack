import type { TFunction } from 'i18next';
import { useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import {
  hasRecordDraft,
  type RecordDraftState,
  type RequirementRecordDraft,
  type RequirementRecordDraftStore,
} from './requirement-record-draft';

function preview(
  draft: RequirementRecordDraft,
  questions: Record<string, unknown>[],
  t: TFunction<'desktop'>,
) {
  const parts: string[] = [];
  if (draft.fields) {
    for (const [key, value] of Object.entries(draft.fields))
      if (value) parts.push(`${key.replace(/([A-Z])/g, ' $1')}: ${value}`);
  }
  for (const [id, answer] of Object.entries(draft.answers)) {
    const question = questions.find((item) => item['id'] === id);
    parts.push(
      `${typeof question?.['question'] === 'string' ? question['question'] : t('req.record.savedAnswer')}\n${answer.text}`,
    );
  }
  return parts.join('\n\n') || t('req.record.empty');
}

export function RequirementRecordDraftNotice({
  state,
  store,
  questions,
}: {
  state: RecordDraftState;
  store: RequirementRecordDraftStore | null;
  questions: Record<string, unknown>[];
}) {
  const { t } = useDesktopText();
  const [choice, setChoice] = useState<'saved' | 'local' | null>(null);
  if (
    !store ||
    (!hasRecordDraft(state.value) &&
      !state.error &&
      state.status !== 'loading' &&
      state.status !== 'saving')
  )
    return null;
  return (
    <section className="requirement-draft-status" aria-label={t('req.record.label')}>
      <p>
        {state.status === 'loading'
          ? t('req.record.loading')
          : state.status === 'saving'
            ? t('req.record.saving')
            : state.status === 'conflict'
              ? t('req.record.conflict')
              : state.status === 'error'
                ? t('req.record.error')
                : t('req.record.saved')}
      </p>
      {state.error && (
        <p className="session-error" role="alert">
          {state.error}
        </p>
      )}
      {!state.ready && state.status === 'error' && (
        <button type="button" className="button secondary" onClick={() => void store.load()}>
          {t('req.record.retry')}
        </button>
      )}
      {state.status === 'conflict' && (
        <button
          type="button"
          className="button secondary"
          disabled={state.resolving}
          onClick={() => {
            setChoice(null);
            void store.compare();
          }}
        >
          {t('req.record.compare')}
        </button>
      )}
      {state.review && (
        <>
          <div className="requirement-draft-comparison">
            <div>
              <h4>{t('req.record.local')}</h4>
              <textarea
                aria-label={t('req.record.local')}
                readOnly
                value={preview(state.value, questions, t)}
              />
            </div>
            <div>
              <h4>{t('req.record.saved2')}</h4>
              <textarea
                aria-label={t('req.record.saved2')}
                readOnly
                value={preview(state.review.value, questions, t)}
              />
            </div>
          </div>
          <p>{t('req.record.choiceHelp')}</p>
          <div className="sdd-actions">
            {choice ? (
              <>
                <button
                  type="button"
                  className="button primary"
                  disabled={state.resolving}
                  onClick={() => void store.resolve(choice).then(() => setChoice(null))}
                >
                  {choice === 'saved' ? t('req.record.confirmSaved') : t('req.record.confirmLocal')}
                </button>
                <button type="button" disabled={state.resolving} onClick={() => setChoice(null)}>
                  {t('req.cancelChoice')}
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="button secondary"
                  disabled={state.resolving}
                  onClick={() => setChoice('saved')}
                >
                  {t('req.record.useSaved')}
                </button>
                <button
                  type="button"
                  className="button secondary"
                  disabled={state.resolving}
                  onClick={() => setChoice('local')}
                >
                  {t('req.record.keepLocal')}
                </button>
              </>
            )}
          </div>
        </>
      )}
    </section>
  );
}
