import { Check, Copy, MessageSquare, RotateCcw, X } from 'lucide-react';
import { useState } from 'react';
import { type ReviewNote, withReply, withResolved } from './review-notes-store';

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
  const [showResolved, setShowResolved] = useState(false),
    [replyTo, setReplyTo] = useState<number | null>(null),
    [reply, setReply] = useState(''),
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
          {notes.length - resolved} open review notes
          {resolved ? ` · ${resolved} resolved` : ''}
        </strong>
        {resolved > 0 && (
          <label className="file-review-show-resolved">
            <input
              type="checkbox"
              checked={showResolved}
              onChange={(event) => setShowResolved(event.target.checked)}
            />{' '}
            Show resolved
          </label>
        )}
        <button type="button" disabled={busy} onClick={onReload}>
          Reload saved review notes
        </button>
        <button type="button" disabled={notes.length === resolved} onClick={onReview}>
          <Copy size={13} />
          {reviewLabel}
        </button>
      </header>
      {error && <p role="alert">{error}</p>}
      {message && <p role="alert">{message}</p>}
      <small>
        {busy
          ? 'Saving or loading review notes…'
          : ready
            ? 'Saved per project on this desktop. Line anchors refer to the reviewed file version. Resolved notes are not sent with the review.'
            : 'Review notes are unavailable.'}
      </small>
      <div>
        {notes.map((note, index) =>
          note.resolved && !showResolved ? null : (
            <article key={index}>
              <span>
                {note.path}:{note.line}
                {note.resolved ? ' · Resolved' : ''}
              </span>
              <p className={note.resolved ? 'file-review-resolved-text' : undefined}>{note.text}</p>
              {!!note.replies?.length && (
                <ol
                  className="file-review-replies"
                  aria-label={`Replies to review note ${index + 1}`}
                >
                  {note.replies.map((item, replyIndex) => (
                    <li key={replyIndex}>
                      <p className="file-review-reply-text">{item.text}</p>
                      <time dateTime={item.at}>{new Date(item.at).toLocaleString()}</time>
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
                    aria-label={`Reply to review note ${index + 1}`}
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
                    Add reply
                  </button>
                  <button
                    type="button"
                    className="button secondary small"
                    onClick={() => setReplyTo(null)}
                  >
                    Cancel
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
                    <MessageSquare size={12} /> Reply
                  </button>
                  <button
                    type="button"
                    aria-label={`${note.resolved ? 'Reopen' : 'Resolve'} review note ${index + 1}`}
                    disabled={locked}
                    onClick={() => void save(() => withResolved(notes, index, !note.resolved))}
                  >
                    {note.resolved ? <RotateCcw size={12} /> : <Check size={12} />}{' '}
                    {note.resolved ? 'Reopen' : 'Resolve'}
                  </button>
                </div>
              )}
              <button
                type="button"
                className="file-review-remove"
                aria-label={`Remove review note ${index + 1}`}
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
