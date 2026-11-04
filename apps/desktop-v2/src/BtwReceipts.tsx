import { RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { btwReceipts, btwStatus } from './btw-receipts';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';
import { entries, record } from './engine-values';

/**
 * Receipts for BTW notes this desktop sent during runs: whether the leader has read or handled
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
  const saveError = useSyncExternalStore(btwReceipts.subscribe, () => btwReceipts.error(sessionId));
  const { t } = useDesktopText();
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
      <summary>{t('btw.title', { count: notes.length })}</summary>
      <section aria-label={t('btw.label')}>
        <p className="field-help">{t('btw.help')}</p>
        {error && (
          <p role="alert" className="session-error">
            {error}
          </p>
        )}
        {saveError && (
          <p role="alert" className="session-error">
            {saveError}
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
                  {mail ? t(`btw.status.${btwStatus(found)}`) : t('btw.checking')}
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
          <RefreshCw size={12} /> {t('btw.refresh')}
        </button>
      </section>
    </details>
  );
}
