import type { ApiSession } from '@wrongstack/webui-protocol';
import { Megaphone } from 'lucide-react';
import { useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import type { EngineHttp } from './engine-http';
import { record } from './engine-values';

/** Sessions a broadcast reaches: this project's runtimes that are running (active or idle). */
export function broadcastTargets(sessions: readonly ApiSession[]): ApiSession[] {
  return sessions.filter((session) => session.status === 'active' || session.status === 'idle');
}

const englishSummary = {
  delivered: (count: number) =>
    `Delivered to ${count} session ${count === 1 ? 'mailbox' : 'mailboxes'}.`,
  failed: (ids: string) => `Not delivered: ${ids}.`,
  unconfirmed: 'Delivery does not confirm execution.',
};

/** One line for a finished broadcast. */
export function broadcastSummary(
  delivered: number,
  failed: readonly string[],
  words = englishSummary,
): string {
  const base = words.delivered(delivered);
  return failed.length
    ? `${base} ${words.failed(failed.join(', '))} ${words.unconfirmed}`
    : `${base} ${words.unconfirmed}`;
}

/**
 * One steering message to every live runtime of this project, sent session by session through
 * the same per-session mailbox route as a single message. The project's own session list is
 * read again right before sending, so a runtime that exited is not addressed. The engine's
 * fleet-wide broadcast route is not used: it falls back to every project's sessions when its
 * host is not a registered session.
 */
export function FleetBroadcast({
  http,
  read,
  onSent,
}: {
  http: EngineHttp;
  /** This project's live runtimes, read fresh. */
  read: () => Promise<ApiSession[]>;
  onSent: () => void;
}) {
  const { t } = useDesktopText();
  const [open, setOpen] = useState(false),
    [text, setText] = useState(''),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(''),
    [error, setError] = useState('');
  const send = async () => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const targets = broadcastTargets(await read());
      if (targets.length === 0) throw Error(t('liveFleet.broadcast.none'));
      const failed: string[] = [];
      let delivered = 0;
      for (const session of targets) {
        try {
          const result = record(
            await http(`/api/sessions/${encodeURIComponent(session.sessionId)}/message`, 'POST', {
              text: text.trim(),
              type: 'steer',
              from: 'human@desktop',
              priority: 'high',
              subject: 'Broadcast from the desktop',
            }),
          );
          if (result['ok'] === true) delivered += 1;
          else failed.push(session.sessionId);
        } catch {
          failed.push(session.sessionId);
        }
      }
      setNotice(
        broadcastSummary(delivered, failed, {
          delivered: (n) =>
            t(n === 1 ? 'liveFleet.broadcast.deliveredOne' : 'liveFleet.broadcast.deliveredMany', {
              n,
            }),
          failed: (ids) => t('liveFleet.broadcast.failed', { ids }),
          unconfirmed: t('liveFleet.broadcast.unconfirmed'),
        }),
      );
      if (failed.length === 0) {
        setText('');
        setOpen(false);
      }
      onSent();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="fleet-broadcast">
      {open ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (text.trim()) void send();
          }}
        >
          <label>
            {t('liveFleet.broadcast.field')}
            <textarea
              rows={3}
              maxLength={4000}
              value={text}
              disabled={busy}
              onChange={(event) => setText(event.target.value)}
            />
          </label>
          <span className="feature-actions">
            <button type="submit" className="button primary" disabled={busy || !text.trim()}>
              {busy ? t('liveFleet.broadcast.sending') : t('liveFleet.broadcast.send')}
            </button>
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() => setOpen(false)}
            >
              {t('liveFleet.broadcast.cancel')}
            </button>
          </span>
        </form>
      ) : (
        <button type="button" className="button secondary" onClick={() => setOpen(true)}>
          <Megaphone size={14} />
          {t('liveFleet.broadcast.open')}
        </button>
      )}
      {notice && (
        <p className="feature-notice" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="session-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
