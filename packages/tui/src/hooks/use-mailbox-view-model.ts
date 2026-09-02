import { type Dispatch, type SetStateAction, useEffect, useState } from 'react';
import type { AppProps } from '../app-props.js';
import type { MailboxAgentEntry, MailboxMessageEntry } from '../components/mailbox-panel.js';
import type { MailboxStatus } from '../components/status-bar.js';
import type { TuiMailboxSnapshot } from '../mailbox-view-model-types.js';

/** Owns mailbox status subscriptions and the lightweight panel projection. */
export function useMailboxViewModel(events: AppProps['events']): {
  mailboxStatus: MailboxStatus;
  mailboxPanelOpen: boolean;
  setMailboxPanelOpen: Dispatch<SetStateAction<boolean>>;
  mailboxMessages: MailboxMessageEntry[];
  mailboxAgents: MailboxAgentEntry[];
} {
  const [mailboxStatus, setMailboxStatus] = useState<MailboxStatus>({
    unread: 0,
    onlineAgents: 0,
    onlineClients: { tui: 0, webui: 0, repl: 0 },
  });
  const [mailboxPanelOpen, setMailboxPanelOpen] = useState(false);
  const [mailboxMessages, setMailboxMessages] = useState<MailboxMessageEntry[]>([]);
  const [mailboxAgents, setMailboxAgents] = useState<MailboxAgentEntry[]>([]);

  useEffect(() => {
    // Track last-seen time per agent, not an append-only "ever seen" Set. The
    // old Set grew one entry per unique agentId for the whole session (fed by
    // recurring heartbeats) AND made `onlineAgents` monotonic — it never dropped
    // an agent that went away. A TTL map bounds memory to currently-live agents
    // and makes the count reflect who is actually online.
    const AGENT_ONLINE_TTL_MS = 120_000;
    const lastSeen = new Map<string, number>();
    const unsubUnread = events.onPattern('mailbox.unread_count', (_event, payload) => {
      const data = payload as { count: number } | undefined;
      setMailboxStatus((previous) => ({ ...previous, unread: data?.count ?? 0 }));
    });
    const unsubReceived = events.onPattern('mailbox.received', (_event, payload) => {
      const data = payload as { subject?: string; from?: string } | undefined;
      setMailboxStatus((previous) => ({
        ...previous,
        lastSubject: data?.subject ?? previous.lastSubject,
        lastFrom: data?.from ?? previous.lastFrom,
      }));
    });
    const updateAgentCount = (payload: unknown) => {
      const data = payload as { agentId?: string } | undefined;
      const now = Date.now();
      if (data?.agentId) lastSeen.set(data.agentId, now);
      // Prune agents whose last heartbeat aged out — bounds the map and lets the
      // count decay as agents stop reporting.
      for (const [id, ts] of lastSeen) {
        if (now - ts > AGENT_ONLINE_TTL_MS) lastSeen.delete(id);
      }
      setMailboxStatus((previous) => ({ ...previous, onlineAgents: lastSeen.size }));
    };
    const unsubRegistered = events.onPattern('mailbox.agent_registered', (_event, payload) => {
      updateAgentCount(payload);
    });
    const unsubHeartbeat = events.onPattern('mailbox.agent_heartbeat', (_event, payload) => {
      updateAgentCount(payload);
    });
    const unsubClients = events.onPattern('mailbox.sync_clients', (_event, payload) => {
      const data = payload as { tui?: number; webui?: number; repl?: number } | undefined;
      if (!data) return;
      setMailboxStatus((previous) => ({
        ...previous,
        onlineClients: {
          tui: data.tui ?? 0,
          webui: data.webui ?? 0,
          repl: data.repl ?? 0,
        },
      }));
    });
    const unsubSnapshot = events.onPattern('mailbox.snapshot', (_event, payload) => {
      const snapshot = payload as TuiMailboxSnapshot;
      const latest = snapshot.messages[0];
      setMailboxStatus({
        unread: snapshot.unread,
        onlineAgents: snapshot.agents.filter((agent) => agent.online).length,
        onlineClients: snapshot.clients,
        lastSubject: latest?.subject ?? null,
        lastFrom: latest?.from ?? null,
      });
    });
    return () => {
      unsubUnread();
      unsubReceived();
      unsubRegistered();
      unsubHeartbeat();
      unsubClients();
      unsubSnapshot();
    };
  }, [events]);

  useEffect(() => {
    const unsubMessage = events.onPattern('mailbox.received', (_event, payload) => {
      const data = payload as
        | {
            messageId?: string;
            from?: string;
            subject?: string;
            type?: string;
            audience?: 'all' | 'leaders';
          }
        | undefined;
      if (!data?.messageId) return;
      const messageId = data.messageId;
      setMailboxMessages((previous) => {
        if (previous.some((message) => message.id === messageId)) return previous;
        return [
          {
            id: messageId,
            from: data.from ?? 'unknown',
            to: '*',
            type: data.type ?? 'note',
            audience: data.audience ?? 'all',
            subject: data.subject ?? '',
            body: '',
            priority: 'normal',
            timestamp: new Date().toISOString(),
            readByCount: 0,
            readByMe: false,
            completed: false,
          },
          ...previous,
        ].slice(0, 50);
      });
    });
    const unsubAgent = events.onPattern('mailbox.agent_registered', (_event, payload) => {
      const data = payload as
        | { agentId?: string; name?: string; role?: string; sessionId?: string; source?: string }
        | undefined;
      if (!data?.agentId) return;
      const agentId = data.agentId;
      setMailboxAgents((previous) => {
        if (previous.some((agent) => agent.agentId === agentId)) return previous;
        return [
          ...previous,
          {
            agentId,
            name: data.name ?? agentId,
            role: data.role,
            sessionId: data.sessionId ?? '?',
            status: 'idle',
            lastSeenAt: new Date().toISOString(),
            online: true,
            source: data.source,
          },
        ].slice(0, 30);
      });
    });
    const unsubSnapshot = events.onPattern('mailbox.snapshot', (_event, payload) => {
      const snapshot = payload as TuiMailboxSnapshot;
      // Same retention caps as the incremental handlers above (50 messages /
      // 30 agents). This handler used to put the FULL snapshot lists into
      // state — the consumer half of the measured mailbox.snapshot storm:
      // every mailbox event triggers a full-list snapshot publish, so an
      // uncapped write here re-rendered the panel with an ever-growing
      // array. Sort newest-first before capping instead of trusting wire
      // order (the mailbox-store slice(-MAX) lesson).
      setMailboxMessages(
        [...snapshot.messages]
          .sort((a, b) => (Date.parse(b.timestamp) || 0) - (Date.parse(a.timestamp) || 0))
          .slice(0, 50)
          .map((message) => ({
            id: message.id,
            from: message.from,
            to: message.to,
            type: message.type,
            ...(message.audience !== undefined ? { audience: message.audience } : {}),
            subject: message.subject,
            body: message.body,
            priority: message.priority,
            timestamp: message.timestamp,
            readByCount: Object.keys(message.readBy).length,
            readByMe: snapshot.actorId !== undefined && snapshot.actorId in message.readBy,
            completed: message.completed,
            ...(message.completedBy !== undefined ? { completedBy: message.completedBy } : {}),
            ...(message.outcome !== undefined ? { outcome: message.outcome } : {}),
          })),
      );
      setMailboxAgents(
        [...snapshot.agents]
          .sort((a, b) => {
            if (a.online !== b.online) return a.online ? -1 : 1;
            return (Date.parse(b.lastSeenAt) || 0) - (Date.parse(a.lastSeenAt) || 0);
          })
          .slice(0, 30)
          .map((agent) => ({
            agentId: agent.agentId,
            name: agent.name,
            ...(agent.role !== undefined ? { role: agent.role } : {}),
            sessionId: agent.sessionId,
            status: agent.status,
            ...(agent.currentTool !== undefined ? { currentTool: agent.currentTool } : {}),
            ...(agent.currentTask !== undefined ? { currentTask: agent.currentTask } : {}),
            lastSeenAt: agent.lastSeenAt,
            online: agent.online,
            ...(agent.source !== undefined ? { source: agent.source } : {}),
          })),
      );
    });
    return () => {
      unsubMessage();
      unsubAgent();
      unsubSnapshot();
    };
  }, [events]);

  return {
    mailboxStatus,
    mailboxPanelOpen,
    setMailboxPanelOpen,
    mailboxMessages,
    mailboxAgents,
  };
}
