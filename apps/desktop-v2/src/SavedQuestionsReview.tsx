import { useDesktopText } from './desktop-i18n';
import type { EngineSend } from './engine-operations';
import type { EngineState } from './engine-state';
import { InputRequestCard } from './InputRequestCard';
import { inputAnswerDraft } from './input-answer-draft';
import type { InputDraft } from './input-form-model';
import { Modal } from './Modal';
import { native } from './platform';

/** Archived questions stay readable while the leader and live worker transcripts are open. */
export function SavedQuestionsReview({
  id,
  projectId,
  requests,
  drafts,
  send,
  onClose,
}: {
  id: string;
  projectId: string;
  requests: EngineState['archivedInputs'];
  drafts: Record<string, InputDraft>;
  send: EngineSend;
  onClose: () => void;
}) {
  const { t } = useDesktopText();
  return (
    <Modal title={t('input.savedTitle')} onClose={onClose}>
      <header className="input-recovery-heading">
        <h2>{t('input.savedTitle')}</h2>
        <button type="button" className="button secondary small" onClick={onClose}>
          {t('input.closeSaved')}
        </button>
      </header>
      <p>{t('input.savedHelp')}</p>
      {requests.map((request) => (
        <InputRequestCard
          key={request.id}
          request={request}
          draft={drafts[`${id}:${request.id}`]}
          onChange={() => {}}
          send={send}
          connected={false}
          readOnly
          persistence={
            native && projectId
              ? inputAnswerDraft({ projectId, sessionId: id, requestId: request.id })
              : undefined
          }
        />
      ))}
    </Modal>
  );
}
