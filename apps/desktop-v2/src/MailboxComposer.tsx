import { Send, X } from 'lucide-react';
import { useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import { MarkdownContent } from './MarkdownContent';
import { Modal } from './Modal';
import { emptyMailDraft, type MailDraft, mailboxSendTypes } from './mailbox-model';

export function MailboxComposer({
  draft,
  setDraft,
  busy,
  replacement,
  setReplacement,
  setComposing,
  send,
  displayedError,
}: {
  draft: MailDraft;
  setDraft: (draft: MailDraft) => void;
  busy: boolean;
  replacement: MailDraft | null;
  setReplacement: (draft: MailDraft | null) => void;
  setComposing: (value: boolean) => void;
  send: () => void;
  displayedError: string;
}) {
  const { t } = useDesktopText();
  const [preview, setPreview] = useState(false);
  const [discard, setDiscard] = useState(false);
  return (
    <Modal
      onClose={() => {
        if (busy) return;
        setComposing(false);
        setReplacement(null);
        setDiscard(false);
      }}
    >
      <header>
        <div>
          <span className="eyebrow">{t('mailboxPage.compose.eyebrow')}</span>
          <h2 id="dialog-title">
            {draft.replyTo ? t('mailboxPage.compose.replyTitle') : t('mailboxPage.composeMessage')}
          </h2>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label={t('mailboxPage.compose.close')}
          disabled={busy}
          onClick={() => {
            setComposing(false);
            setReplacement(null);
          }}
        >
          <X size={16} />
        </button>
      </header>
      <form
        className="mailbox-composer"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        <p>{t('mailboxPage.compose.saved')}</p>
        <p>{t('mailboxPage.compose.recipients')}</p>
        {replacement && (
          <div className="mailbox-confirm">
            <p>{t('mailboxPage.compose.replaceAsk')}</p>
            <button type="button" className="button secondary" onClick={() => setReplacement(null)}>
              {t('mailboxPage.compose.keepCurrent')}
            </button>
            <button
              type="button"
              className="button secondary"
              onClick={() => {
                setDraft(replacement);
                setReplacement(null);
              }}
            >
              {t('mailboxPage.compose.replace')}
            </button>
          </div>
        )}
        <fieldset disabled={busy || !!replacement}>
          <div className="mailbox-controls">
            <label>
              {t('mailboxPage.compose.to')}
              <input
                aria-label={t('mailboxPage.compose.toLabel')}
                required
                value={draft.type === 'broadcast' ? '*' : draft.to}
                disabled={draft.type === 'broadcast'}
                list="mailbox-actors"
                onChange={(event) => setDraft({ ...draft, to: event.target.value })}
              />
            </label>
            <label>
              {t('mailboxPage.compose.type')}
              <select
                aria-label={t('mailboxPage.compose.typeLabel')}
                value={draft.type}
                onChange={(event) => setDraft({ ...draft, type: event.target.value })}
              >
                {mailboxSendTypes.map((type) => (
                  <option key={type} value={type}>
                    {t(`mailboxPage.type.${type}`, { defaultValue: type })}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="mailbox-controls">
            <label>
              {t('mailboxPage.compose.priority')}
              <select
                aria-label={t('mailboxPage.compose.priorityLabel')}
                value={draft.priority}
                onChange={(event) => setDraft({ ...draft, priority: event.target.value })}
              >
                {['low', 'normal', 'high'].map((priority) => (
                  <option key={priority} value={priority}>
                    {t(`mailboxPage.priority.${priority}`)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t('mailboxPage.compose.audience')}
              <select
                aria-label={t('mailboxPage.compose.audienceLabel')}
                value={draft.audience}
                onChange={(event) => setDraft({ ...draft, audience: event.target.value })}
              >
                <option value="all">{t('mailboxPage.audienceAll')}</option>
                <option value="leaders">{t('mailboxPage.audienceLeaders')}</option>
              </select>
            </label>
          </div>
          <label>
            {t('mailboxPage.compose.subject')}
            <input
              aria-label={t('mailboxPage.compose.subjectLabel')}
              required
              value={draft.subject}
              onChange={(event) => setDraft({ ...draft, subject: event.target.value })}
            />
          </label>
          <label>
            {t('mailboxPage.compose.body')}
            <textarea
              aria-label={t('mailboxPage.compose.bodyLabel')}
              required
              rows={8}
              value={draft.body}
              onChange={(event) => setDraft({ ...draft, body: event.target.value })}
            />
          </label>
          <label className="provider-checkbox">
            <input
              type="checkbox"
              checked={preview}
              onChange={(event) => setPreview(event.target.checked)}
            />
            {t('mailboxPage.compose.preview')}
          </label>
          {preview && <MarkdownContent text={draft.body} />}
          {draft.replyTo && (
            <small>{t('mailboxPage.compose.reference', { id: draft.replyTo })}</small>
          )}
        </fieldset>
        {displayedError && (
          <p role="alert" className="session-error">
            {displayedError}
          </p>
        )}
        {discard ? (
          <div className="mailbox-confirm">
            <p>{t('mailboxPage.compose.discardAsk')}</p>
            <button type="button" className="button secondary" onClick={() => setDiscard(false)}>
              {t('mailboxPage.compose.keepDraft')}
            </button>
            <button
              type="button"
              className="button secondary danger"
              onClick={() => {
                setDraft(emptyMailDraft());
                setDiscard(false);
                setComposing(false);
              }}
            >
              {t('mailboxPage.compose.confirmDiscard')}
            </button>
          </div>
        ) : (
          <footer>
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() => setDiscard(true)}
            >
              {t('mailboxPage.compose.discard')}
            </button>
            <button type="submit" className="button primary" disabled={busy || !!replacement}>
              <Send size={14} />
              {busy ? t('mailboxPage.compose.recording') : t('mailboxPage.compose.send')}
            </button>
          </footer>
        )}
      </form>
    </Modal>
  );
}
