import { RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { btwReceipts, btwStatus, type PendingBtwSnapshot, readPendingBtw } from './btw-receipts';
import { useDesktopText } from './desktop-i18n';
import { displayTime } from './display-dates';
import type { EngineCommand } from './engine-operations';

/** Pending instructions only. Consumed notes remain in history, never in this panel. */
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
  const [snapshot, setSnapshot] = useState<PendingBtwSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const [failure, setFailure] = useState<{ sessionId: string; message: string } | null>(null);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const run = ++generation.current;
    setBusy(true);
    try {
      const next = await readPendingBtw(notes, sessionId, command);
      if (run !== generation.current) return false;
      setSnapshot(next);
      setFailure(null);
      return next.notes.length > 0;
    } catch (error) {
      if (run === generation.current)
        setFailure({ sessionId, message: error instanceof Error ? error.message : String(error) });
      // Keep pending entries, but stop polling a failed connection until retry/reconnect.
      return false;
    } finally {
      if (run === generation.current) setBusy(false);
    }
  }, [command, notes, sessionId]);
  useEffect(() => {
    if (!notes.length) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const pending = await refresh();
      if (!stopped && pending) timer = setTimeout(poll, 1000);
    };
    void poll();
    return () => {
      stopped = true;
      generation.current++;
      clearTimeout(timer);
    };
  }, [refresh, notes.length, mailboxEvent, retry]);

  const shown = snapshot?.sessionId === sessionId ? snapshot.notes : [];
  const error = failure?.sessionId === sessionId ? failure.message : '';
  if (!shown.length && !error && !saveError) return null;
  return (
    <div>
      {error && (
        <p role="alert" className="session-error">
          {error}{' '}
          <button
            type="button"
            className="button secondary small"
            disabled={busy}
            onClick={() => setRetry((value) => value + 1)}
          >
            {t('btw.refresh')}
          </button>
        </p>
      )}
      {saveError && (
        <p role="alert" className="session-error">
          {saveError}
        </p>
      )}
      {shown.length > 0 && (
        <details className="btw-receipts">
          <summary>{t('btw.title', { count: shown.length })}</summary>
          <section aria-label={t('btw.label')}>
            <ul className="btw-receipts-list">
              {shown.map((note) => (
                <li key={note.messageId}>
                  <span>{note.text.length > 120 ? `${note.text.slice(0, 119)}…` : note.text}</span>
                  <small>
                    {displayTime(note.sentAt)} ·{' '}
                    {t(
                      `btw.status.${note.messageId.startsWith('btw:') ? 'saved' : btwStatus(snapshot?.mail.get(note.messageId))}`,
                    )}
                  </small>
                </li>
              ))}
            </ul>
            <button
              type="button"
              className="button secondary small"
              disabled={busy}
              onClick={() => setRetry((value) => value + 1)}
            >
              <RefreshCw size={12} /> {t('btw.refresh')}
            </button>
          </section>
        </details>
      )}
    </div>
  );
}
