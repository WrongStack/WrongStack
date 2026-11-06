import { DraftMergeChoices } from './DraftMergeChoices';
import { useDesktopText } from './desktop-i18n';
import { displayDateTime } from './display-dates';
import type { DurableFormState } from './durable-form-draft';
import type { MailDraft } from './mailbox-model';

/** Restore, save-failure and other-window states of the saved mailbox draft. */
export function MailboxDraftStatus({
  restoredAt,
  saved,
  localBody,
  onResolve,
  onMerge,
  onRetry,
}: {
  restoredAt: number | undefined;
  saved: DurableFormState<MailDraft> | null;
  /** This window's message body, to merge with the other window's change by change. */
  localBody: string;
  onResolve: (choice: 'local' | 'saved') => void;
  onMerge: (body: string) => void;
  onRetry: () => void;
}) {
  const { t } = useDesktopText();
  if (!saved) return null;
  if (saved.review)
    return (
      <div className="mailbox-confirm" role="alert">
        <p>
          {saved.review.value
            ? t('mailboxPage.draft.otherWithSubject', {
                subject: saved.review.value.subject || t('mailboxPage.draft.noSubject'),
              })
            : t('mailboxPage.draft.otherEmpty')}
        </p>
        <button type="button" className="button secondary" onClick={() => onResolve('local')}>
          {t('mailboxPage.draft.keepLocal')}
        </button>
        <button type="button" className="button secondary" onClick={() => onResolve('saved')}>
          {t('mailboxPage.draft.useSaved')}
        </button>
        {saved.review.value && saved.review.value.body !== localBody && (
          <>
            <p className="field-help">{t('mailboxPage.draft.mergeHint')}</p>
            <DraftMergeChoices
              mine={localBody}
              stored={saved.review.value.body}
              busy={saved.saving}
              onKeep={onMerge}
            />
          </>
        )}
      </div>
    );
  if (saved.error)
    return (
      <div className="mailbox-confirm" role="alert">
        <p>{saved.error}</p>
        {!saved.ready && (
          <button type="button" className="button secondary" onClick={onRetry}>
            {t('mailboxPage.draft.retry')}
          </button>
        )}
      </div>
    );
  if (!saved.ready)
    return (
      <p className="field-help" role="status">
        {t('mailboxPage.draft.loading')}
      </p>
    );
  if (restoredAt)
    return (
      <p className="studio-notice" role="status">
        {t('mailboxPage.draft.restored', { time: displayDateTime(restoredAt) })}
      </p>
    );
  return null;
}
