import type { RefObject } from 'react';
import { useCallback, useRef, useState, useSyncExternalStore } from 'react';
import { playChime } from '../lib/chime.js';
import { createMailboxStore, type MailboxStore } from '../lib/mailbox-store.js';
import type { SimplePrefs } from '../lib/prefs-model.js';
import {
  isIncomingMailboxPayload,
  messageId,
  payloadSucceeded,
  payloadText,
} from '../lib/session-helpers.js';
import type { SimpleSocket } from '../lib/ws.js';
import type { StatusNotice } from './use-status-notice.js';

/** A wire frame the mailbox store can consume (`type` + optional payload). */
interface MailboxWireMessage {
  type: string;
  payload?: Record<string, unknown> | undefined;
}

export interface UseSimpleMailboxOptions {
  socketRef: RefObject<SimpleSocket | null>;
  setNotice: (notice: StatusNotice) => void;
  prefsRef: RefObject<SimplePrefs>;
}

export interface UseSimpleMailboxResult {
  mailboxStore: MailboxStore;
  mailboxOpen: boolean;
  setMailboxOpen: React.Dispatch<React.SetStateAction<boolean>>;
  mailboxOpenRef: RefObject<boolean>;
  mailboxUnreadCount: number;
  refreshMailbox: () => void;
  sendMailboxMessage: (input: { to: string; subject: string; body: string }) => boolean;
  handleMailboxAction: (
    mailId: string,
    action: 'mark-read' | 'acknowledge' | 'reopen' | 'soft-delete',
  ) => void;
  /**
   * Apply a socket frame's mailbox concerns (store update + received/sent/
   * action_result notices). Returns `true` when the store accepted the frame,
   * so the caller can skip forwarding it to the main message handler.
   */
  applyMailboxMessage: (message: MailboxWireMessage) => boolean;
}

/**
 * Owns the SimpleUI mailbox projection: the store, open state, unread count,
 * refresh/send/action commands, and the socket-frame handling for
 * `mailbox.received` / `mailbox.sent` / `mailbox.action_result`. Extracted
 * from `simple-ui-session.tsx` (plan B1, handler modules).
 *
 * The connection-driven refresh effect stays in the session component because
 * `connection` comes from `useSimpleSocket`, which itself depends on the
 * message handler that delegates to `applyMailboxMessage`.
 */
export function useSimpleMailbox(options: UseSimpleMailboxOptions): UseSimpleMailboxResult {
  const { socketRef, setNotice, prefsRef } = options;

  const refreshMailboxRef = useRef<(() => void) | null>(null);
  const [mailboxStore] = useState(() => createMailboxStore(() => refreshMailboxRef.current?.()));
  const mailboxSnapshot = useSyncExternalStore(
    mailboxStore.subscribe,
    mailboxStore.getSnapshot,
    mailboxStore.getSnapshot,
  );
  const [mailboxOpen, setMailboxOpen] = useState(false);
  const mailboxUnreadCount = mailboxSnapshot.unreadCount;
  const pendingMailboxSendsRef = useRef<Set<string>>(new Set());
  const pendingMailboxActionsRef = useRef<Set<string>>(new Set());
  const mailboxOpenRef = useRef(false);
  mailboxOpenRef.current = mailboxOpen;

  const refreshMailbox = useCallback(() => {
    socketRef.current?.send('mailbox.messages', { limit: 30 });
    socketRef.current?.send('mailbox.messages', {
      limit: 100,
      unreadOnly: true,
      incompleteOnly: true,
    });
    socketRef.current?.send('mailbox.agents', {});
    // eslint-disable-next-line react-hooks/exhaustive-deps -- socketRef is a stable ref
  }, []);
  refreshMailboxRef.current = refreshMailbox;

  const sendMailboxMessage = useCallback(
    (input: { to: string; subject: string; body: string }): boolean => {
      const socket = socketRef.current;
      if (!socket) {
        setNotice({
          id: messageId('mailbox-send'),
          text: 'Mailbox send failed: socket is not ready',
          tone: 'error',
        });
        return false;
      }
      const requestId = messageId('mailbox-send');
      pendingMailboxSendsRef.current.add(requestId);
      socket.send('mailbox.send', {
        requestId,
        from: 'simpleui',
        to: input.to,
        type: input.to === '*' ? 'broadcast' : 'note',
        audience: 'all',
        subject: input.subject,
        body: input.body,
        priority: 'normal',
      });
      refreshMailbox();
      return true;
    },
    [refreshMailbox, setNotice],
  );

  const handleMailboxAction = useCallback(
    (mailId: string, action: 'mark-read' | 'acknowledge' | 'reopen' | 'soft-delete') => {
      const requestId = messageId('mailbox-action');
      pendingMailboxActionsRef.current.add(requestId);
      socketRef.current?.send('mailbox.action', {
        requestId,
        mailId,
        action,
        readerId: 'simpleui',
      });
      refreshMailbox();
    },
    [refreshMailbox],
  );

  const applyMailboxMessage = useCallback(
    (message: MailboxWireMessage): boolean => {
      const accepted = mailboxStore.applyMessage(message);
      if (message.type === 'mailbox.received' && isIncomingMailboxPayload(message.payload)) {
        setNotice({
          id: messageId('mail'),
          text: 'New email received',
          tone: 'info',
        });
        if (!mailboxOpenRef.current && prefsRef.current.chime) playChime();
      }
      if (message.type === 'mailbox.sent') {
        const requestId = payloadText(message.payload, 'requestId');
        const succeeded = payloadSucceeded(message.payload);
        const wasPendingSend = requestId ? pendingMailboxSendsRef.current.delete(requestId) : false;
        if (wasPendingSend || !succeeded) {
          setNotice({
            id: messageId('mail'),
            text: succeeded
              ? 'Email sent'
              : `Email failed: ${payloadText(message.payload, 'error') || 'Unknown error'}`,
            tone: succeeded ? 'info' : 'error',
          });
        }
      }
      if (message.type === 'mailbox.action_result') {
        const requestId = payloadText(message.payload, 'requestId');
        if (requestId && pendingMailboxActionsRef.current.delete(requestId)) {
          setNotice({
            id: messageId('mail'),
            text: payloadSucceeded(message.payload)
              ? 'Email action completed'
              : `Email action failed: ${payloadText(message.payload, 'error') || 'Unknown error'}`,
            tone: payloadSucceeded(message.payload) ? 'info' : 'error',
          });
        }
      }
      return accepted;
    },
    [mailboxStore, setNotice],
  );

  return {
    mailboxStore,
    mailboxOpen,
    setMailboxOpen,
    mailboxOpenRef,
    mailboxUnreadCount,
    refreshMailbox,
    sendMailboxMessage,
    handleMailboxAction,
    applyMailboxMessage,
  };
}
