import type { ApiSession } from '@wrongstack/webui-protocol';
import { Megaphone } from 'lucide-react';
import { useState } from 'react';
import type { EngineHttp } from './engine-http';
import { record } from './engine-values';

/** Sessions a broadcast reaches: this project's runtimes that are running (active or idle). */
export function broadcastTargets(sessions: readonly ApiSession[]): ApiSession[] {
  return sessions.filter((session) => session.status === 'active' || session.status === 'idle');
}

/** One line for a finished broadcast. */
export function broadcastSummary(delivered: number, failed: readonly string[]): string {
  const base = `Delivered to ${delivered} session ${delivered === 1 ? 'mailbox' : 'mailboxes'}.`;
  return failed.length
    ? `${base} Not delivered: ${failed.join(', ')}. Delivery does not confirm execution.`
    : `${base} Delivery does not confirm execution.`;
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
      if (targets.length === 0) throw Error('No live runtime in this project. Nothing was sent.');
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
      setNotice(broadcastSummary(delivered, failed));
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
            Message to every live runtime in this project
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
              {busy ? 'Sending…' : 'Send to all'}
            </button>
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() => setOpen(false)}
            >
              Cancel
            </button>
          </span>
        </form>
      ) : (
        <button type="button" className="button secondary" onClick={() => setOpen(true)}>
          <Megaphone size={14} />
          Message all runtimes…
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
