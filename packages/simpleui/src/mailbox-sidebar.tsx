import {
  CheckCircle2,
  Circle,
  Mail,
  MailOpen,
  RefreshCw,
  RotateCw,
  Send,
  Server,
  Trash2,
  Users,
} from 'lucide-react';
import { useState, useSyncExternalStore } from 'react';
import { isUnreadIncomingMailboxMessage, type MailboxStore } from './lib/mailbox-store.js';

type SimpleUIMailboxAction = 'mark-read' | 'acknowledge' | 'reopen' | 'soft-delete';

interface MailboxSidebarProps {
  store: MailboxStore;
  onRefresh: () => void;
  onSend: (input: { to: string; subject: string; body: string }) => boolean;
  onAction: (mailId: string, action: SimpleUIMailboxAction) => void;
}

function timeLabel(timestamp: string): string {
  const time = Date.parse(timestamp);
  if (!Number.isFinite(time)) return '';
  const minutes = Math.max(0, Math.floor((Date.now() - time) / 60_000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1_440) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / 1_440)}d`;
}

export function MailboxSidebar({ store, onRefresh, onSend, onAction }: MailboxSidebarProps) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [compose, setCompose] = useState(false);
  const [to, setTo] = useState('leader');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const unread = snapshot.messages.filter(isUnreadIncomingMailboxMessage).length;
  const online = snapshot.agents.filter((agent) => agent.online);
  // Derive "online" from real server traffic — the WebUI server does not
  // broadcast a `mailbox.status` service-info frame, so we light the chip
  // when the store has actually consumed any mailbox.* event recently.
  // Treat anything within 5 minutes as live; older snapshots are stale.
  const STALE_AFTER_MS = 5 * 60_000;
  const isOnline =
    snapshot.lastEventAt !== null && Date.now() - snapshot.lastEventAt < STALE_AFTER_MS;

  const send = () => {
    const trimmedBody = body.trim();
    const trimmedTo = to.trim();
    if (!trimmedBody || !trimmedTo) return;
    const sent = onSend({
      to: trimmedTo,
      subject: subject.trim() || 'SimpleUI message',
      body: trimmedBody,
    });
    if (!sent) return;
    setSubject('');
    setBody('');
    setCompose(false);
  };

  return (
    <div className="simple-mailbox">
      <div className="simple-mailbox-summary">
        <span>{unread} UNREAD</span>
        <span>
          <Users size={11} /> {online.length} ONLINE
        </span>
        <button type="button" onClick={onRefresh} aria-label="Refresh mailbox">
          <RefreshCw size={12} />
        </button>
      </div>
      <div className={`simple-mailbox-health ${isOnline ? 'online' : 'offline'}`}>
        <Server size={12} />
        {isOnline ? 'Mailbox service online' : snapshot.error || 'Mailbox service offline'}
      </div>
      <button
        type="button"
        className="simple-mailbox-compose-toggle"
        onClick={() => setCompose((current) => !current)}
      >
        <Send size={12} /> {compose ? 'CANCEL' : 'SEND MESSAGE'}
      </button>
      {compose && (
        <div className="simple-mailbox-compose">
          <input
            value={to}
            onChange={(event) => setTo(event.target.value)}
            placeholder="Recipient"
          />
          <input
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
            placeholder="Subject"
          />
          <textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder="Message"
            rows={4}
          />
          <button type="button" disabled={!to.trim() || !body.trim()} onClick={send}>
            <Send size={11} /> SEND
          </button>
        </div>
      )}
      {snapshot.messages.length === 0 ? (
        <div className="tool-sidebar-empty">
          <Mail size={20} strokeWidth={1.5} />
          <span>No project mailbox messages.</span>
        </div>
      ) : (
        <div className="simple-mailbox-messages">
          {snapshot.messages.map((message) => (
            <article
              key={message.id}
              className={`simple-mailbox-message ${message.completed ? 'completed' : ''} ${message.priority}`}
            >
              <div>
                <Circle size={8} fill={message.readByCount === 0 ? 'currentColor' : 'none'} />
                <strong>{message.subject || message.type}</strong>
                <time>{timeLabel(message.timestamp)}</time>
              </div>
              <span>
                {message.from} → {message.to} · {message.type}
              </span>
              <p>{message.body}</p>
              <div className="simple-mailbox-actions">
                <button
                  type="button"
                  onClick={() => onAction(message.id, 'mark-read')}
                  aria-label="Mark mailbox message read"
                >
                  <MailOpen size={11} />
                </button>
                <button
                  type="button"
                  onClick={() => onAction(message.id, message.completed ? 'reopen' : 'acknowledge')}
                  aria-label={
                    message.completed ? 'Reopen mailbox message' : 'Acknowledge mailbox message'
                  }
                >
                  {message.completed ? <RotateCw size={11} /> : <CheckCircle2 size={11} />}
                </button>
                <button
                  type="button"
                  onClick={() => onAction(message.id, 'soft-delete')}
                  aria-label="Delete mailbox message"
                >
                  <Trash2 size={11} />
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
