import { Check, Copy, MessageSquare, RotateCcw, X } from 'lucide-react';
import { useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import { displayDateTime } from './display-dates';
import { type ReviewNote, withReply, withReplyChange, withResolved } from './review-notes-store';

/**
 * Saved review notes for the changes view: each note keeps a short discussion and can be
 * resolved. Resolved notes are hidden unless asked for and are left out of the review sent on.
 */
export function ReviewNotesTray({
  notes,
  busy,
  ready,
  error,
  reviewLabel,
  onReload,
  onSave,
  onReview,
}: {
  notes: ReviewNote[];
  busy: boolean;
  ready: boolean;
  error: string;
  reviewLabel: string;
  onReload: () => void;
  onSave: (notes: ReviewNote[]) => Promise<void>;
  onReview: () => void;
}) {
  const { t } = useDesktopText();
  const [showResolved, setShowResolved] = useState(false),
    [replyTo, setReplyTo] = useState<number | null>(null),
    [reply, setReply] = useState(''),
    [editing, setEditing] = useState<{ note: number; reply: number; text: string } | null>(null),
    [message, setMessage] = useState('');
  const resolved = notes.filter((note) => note.resolved).length;
  const locked = !ready || busy;
  const save = (next: () => ReviewNote[]) => {
    setMessage('');
    let value: ReviewNote[];
    try {
      value = next();
    } catch (refusal) {
      setMessage(String(refusal instanceof Error ? refusal.message : refusal));
      return Promise.resolve(false);
    }
    // A failed save is shown by the store's own error; the typed reply stays for a retry.
    return onSave(value).then(
      () => true,
      () => false,
    );
  };
  return (
    <section className="file-review-tray">
      <header>
        <strong>
          {t('notes.open', { count: notes.length - resolved })}
          {resolved ? ` · ${t('notes.resolvedCount', { count: resolved })}` : ''}
        </strong>
        {resolved > 0 && (
          <label className="file-review-show-resolved">
            <input
              type="checkbox"
              checked={showResolved}
              onChange={(event) => setShowResolved(event.target.checked)}
            />{' '}
            {t('notes.showResolved')}
          </label>
        )}
        <button type="button" disabled={busy} onClick={onReload}>
          {t('notes.reload')}
        </button>
        <button type="button" disabled={notes.length === resolved} onClick={onReview}>
          <Copy size={13} />
          {reviewLabel}
        </button>
      </header>
      {error && <p role="alert">{error}</p>}
      {message && <p role="alert">{message}</p>}
      <small>{busy ? t('notes.busy') : ready ? t('notes.ready') : t('notes.unavailable')}</small>
      <div>
        {notes.map((note, index) =>
          note.resolved && !showResolved ? null : (
            <article key={index}>
              <span>
                {note.path}:{note.line}
                {note.resolved ? ` · ${t('notes.resolvedTag')}` : ''}
              </span>
              <p className={note.resolved ? 'file-review-resolved-text' : undefined}>{note.text}</p>
              {!!note.replies?.length && (
                <ol
                  className="file-review-replies"
                  aria-label={t('notes.replies', { n: index + 1 })}
                >
                  {note.replies.map((item, replyIndex) => (
                    <li key={replyIndex}>
                      {editing?.note === index && editing.reply === replyIndex ? (
                        <form
                          className="file-review-reply"
                          onSubmit={(event) => {
                            event.preventDefault();
                            void save(() =>
                              withReplyChange(notes, index, replyIndex, editing.text),
                            ).then((saved) => {
                              if (saved) setEditing(null);
                            });
                          }}
                        >
                          <textarea
                            aria-label={t('notes.editReply', {
                              reply: replyIndex + 1,
                              n: index + 1,
                            })}
                            value={editing.text}
                            rows={2}
                            onChange={(event) =>
                              setEditing({ ...editing, text: event.target.value })
                            }
                          />
                          <button type="submit" className="button small" disabled={locked}>
                            {t('notes.saveReply')}
                          </button>
                          <button
                            type="button"
                            className="button secondary small"
                            onClick={() => setEditing(null)}
                          >
                            {t('fileView.cancel')}
                          </button>
                        </form>
                      ) : (
                        <>
                          <p className="file-review-reply-text">{item.text}</p>
                          <time dateTime={item.at}>{displayDateTime(item.at)}</time>
                          <span className="file-review-reply-actions">
                            <button
                              type="button"
                              disabled={locked}
                              aria-label={t('notes.editReply', {
                                reply: replyIndex + 1,
                                n: index + 1,
                              })}
                              onClick={() =>
                                setEditing({ note: index, reply: replyIndex, text: item.text })
                              }
                            >
                              {t('notes.edit')}
                            </button>
                            <button
                              type="button"
                              disabled={locked}
                              aria-label={t('notes.deleteReply', {
                                reply: replyIndex + 1,
                                n: index + 1,
                              })}
                              onClick={() =>
                                void save(() => withReplyChange(notes, index, replyIndex, null))
                              }
                            >
                              {t('fileView.delete')}
                            </button>
                          </span>
                        </>
                      )}
                    </li>
                  ))}
                </ol>
              )}
              {replyTo === index ? (
                <form
                  className="file-review-reply"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void save(() => withReply(notes, index, reply, new Date().toISOString())).then(
                      (saved) => {
                        if (!saved) return;
                        setReplyTo(null);
                        setReply('');
                      },
                    );
                  }}
                >
                  <textarea
                    aria-label={t('notes.replyTo', { n: index + 1 })}
                    value={reply}
                    rows={2}
                    // biome-ignore lint/a11y/noAutofocus: the field opens on an explicit Reply request.
                    autoFocus
                    onChange={(event) => setReply(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') setReplyTo(null);
                    }}
                  />
                  <button type="submit" className="button small" disabled={locked || !reply.trim()}>
                    {t('notes.addReply')}
                  </button>
                  <button
                    type="button"
                    className="button secondary small"
                    onClick={() => setReplyTo(null)}
                  >
                    {t('fileView.cancel')}
                  </button>
                </form>
              ) : (
                <div className="file-review-note-actions">
                  <button
                    type="button"
                    disabled={locked}
                    onClick={() => {
                      setReplyTo(index);
                      setReply('');
                    }}
                  >
                    <MessageSquare size={12} /> {t('notes.reply')}
                  </button>
                  <button
                    type="button"
                    aria-label={t(note.resolved ? 'notes.reopenNote' : 'notes.resolveNote', {
                      n: index + 1,
                    })}
                    disabled={locked}
                    onClick={() => void save(() => withResolved(notes, index, !note.resolved))}
                  >
                    {note.resolved ? <RotateCcw size={12} /> : <Check size={12} />}{' '}
                    {note.resolved ? t('notes.reopen') : t('notes.resolve')}
                  </button>
                </div>
              )}
              <button
                type="button"
                className="file-review-remove"
                aria-label={t('notes.remove', { n: index + 1 })}
                disabled={locked}
                onClick={() => void save(() => notes.filter((_, i) => i !== index))}
              >
                <X size={12} />
              </button>
            </article>
          ),
        )}
      </div>
    </section>
  );
}
