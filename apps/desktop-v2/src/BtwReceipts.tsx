import { RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { BTW_STATUS_LABELS, btwReceipts, btwStatus } from './btw-receipts';
import type { EngineCommand } from './engine-operations';
import { entries, record } from './engine-values';

/**
 * Receipts for BTW notes this window sent during runs: whether the leader has read or handled
 * each one, read from the project mailbox on demand and when mailbox events arrive.
 */
export function BtwReceipts({
  sessionId,
  command,
  mailboxEvent,
}: {
  sessionId: string;
  command: EngineCommand;
  mailboxEvent: unknown;
}) {
  const notes = useSyncExternalStore(btwReceipts.subscribe, () => btwReceipts.list(sessionId));
  const [mail, setMail] = useState<Map<string, Record<string, unknown>> | null>(null),
    [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const refresh = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const result = await command('mailbox.messages', { limit: 200 }, ['mailbox.messages']);
      setMail(new Map(entries(result['messages']).map((item) => [String(item['id']), item])));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [command]);
  // Mailbox events and new notes trigger a re-read while the list is open.
  useEffect(() => {
    if (open && notes.length) void refresh();
  }, [open, notes.length, mailboxEvent, refresh]);
  if (!notes.length) return null;
  return (
    <details
      className="btw-receipts"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>BTW notes · {notes.length}</summary>
      <section aria-label="BTW receipts">
        <p className="field-help">
          Notes sent to this session's leader while it was working. Saved means it is in the
          mailbox; it does not mean it has been read.
        </p>
        {error && (
          <p role="alert" className="session-error">
            {error}
          </p>
        )}
        <ul className="btw-receipts-list">
          {notes.map((note) => {
            const found = mail?.get(note.messageId);
            const readers = Object.keys(record(found?.['readBy']));
            return (
              <li key={note.messageId}>
                <span>{note.text.length > 120 ? `${note.text.slice(0, 119)}…` : note.text}</span>
                <small>
                  {new Date(note.sentAt).toLocaleTimeString()} ·{' '}
                  {mail ? BTW_STATUS_LABELS[btwStatus(found)] : 'Checking receipts…'}
                  {readers.length ? ` · ${readers.join(', ')}` : ''}
                </small>
              </li>
            );
          })}
        </ul>
        <button
          type="button"
          className="button secondary small"
          disabled={busy}
          onClick={() => void refresh()}
        >
          <RefreshCw size={12} /> Refresh receipts
        </button>
      </section>
    </details>
  );
}
