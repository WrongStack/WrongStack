import { create } from 'zustand';

// ============================================
// Mailbox Store
// ============================================
// Central cache of mailbox messages + agent roster. Populated by the
// ws-handlers ('mailbox.messages' / 'mailbox.agents' responses) so the
// ActivityBar unread badge works even while MailboxPanel is unmounted.
//
// Retention caps live here so every consumer (ActivityBar, MailboxPanel,
// MailboxDetailView) inherits the same bound. Without these, every distinct
// message id ever received accumulates forever in long WebUI sessions.

/** Cap on retained mailbox messages (oldest dropped when over). Mirrors TUI `use-mailbox-view-model.ts`. */
const MAX_MAILBOX_MESSAGES = 100;

/** Cap on retained mailbox agents (oldest dropped when over). */
const MAX_MAILBOX_AGENTS = 50;

/** Age after which an offline agent entry is pruned from the store. */
const OFFLINE_AGENT_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

/** Mirrors HQ/HqMailboxMessageScope. Derived server-side, but always revalidated client-side. */
type MailboxMessageScope = 'project' | 'session' | 'agent';

const SESSION_RECIPIENT_PREFIX = '@session:';

/**
 * Classify a mailbox recipient address for UI labeling. Mirrors the
 * server-side helper in `@wrongstack/core/hq/mailbox-mapper` so the
 * WebUI can color messages consistently even when the server payload is
 * stale or missing the scope field.
 */
export function classifyMailboxRecipient(to: string): { scope: MailboxMessageScope; recipientSessionId?: string } {
  if (to === '*' || to === 'all') return { scope: 'project' };
  if (to.startsWith(SESSION_RECIPIENT_PREFIX)) {
    const recipientSessionId = to.slice(SESSION_RECIPIENT_PREFIX.length);
    if (recipientSessionId.length === 0) return { scope: 'agent' };
    return { scope: 'session', recipientSessionId };
  }
  return { scope: 'agent' };
}

export interface MailboxMessage {
  id: string;
  from: string;
  to: string;
  /** Server-derived delivery scope. Re-classified client-side as a fallback. */
  scope?: MailboxMessageScope;
  /** Session id from `to` when `scope === 'session'`. */
  recipientSessionId?: string;
  type: string;
  /** Agent delivery audience; `leaders` is not consumed by subagents. */
  audience?: 'all' | 'leaders';
  subject: string;
  body: string;
  priority: string;
  readBy: Record<string, string>;
  /** Count of agents who have marked this message as read. */
  readByCount: number;
  completed: boolean;
  completedBy?: string;
  completedAt?: string;
  outcome?: string;
  timestamp: string;
  senderSessionId?: string;
  /** ID of the message this is a reply to, if any. */
  replyTo?: string;
  /** Free-form task context attached to the message by the sender. */
  taskContext?: string;
}

export interface MailboxAgent {
  agentId: string;
  name: string;
  role?: string;
  sessionId: string;
  status: string;
  currentTool?: string;
  currentTask?: string;
  lastSeenAt: string;
  online: boolean;
  source?: string;
  /** Process ID of the agent subprocess, if tracked. */
  pid?: number;
  /** Number of iterations the agent has run. */
  iterations?: number;
  /** Number of tool calls the agent has made in the current iteration. */
  toolCalls?: number;
}

interface MailboxCompactionResult {
  readByAllRemoved: number;
  expiredRemoved: number;
  stalePurged: number;
  totalRemoved: number;
  remaining: number;
}

interface MailboxState {
  messages: MailboxMessage[];
  agents: MailboxAgent[];
  /** Result of the last auto-compact operation, if any. */
  lastCompaction: MailboxCompactionResult | null;
  setMessages: (messages: MailboxMessage[]) => void;
  setAgents: (agents: MailboxAgent[]) => void;
  setLastCompaction: (result: MailboxCompactionResult | null) => void;
  /** Drop one agent by id (mailbox.agent_deregistered push). */
  removeAgent: (agentId: string) => void;
}

export const useMailboxStore = create<MailboxState>()((set) => ({
  messages: [],
  agents: [],
  lastCompaction: null,
  setMessages: (messages) =>
    set({
      // Re-classify any message that lacks a server-derived scope, then cap
      // to the most recent MAX_MAILBOX_MESSAGES so the ActivityBar badge
      // and MailboxPanel list cannot drift past the cap over a long session.
      // Sort newest-first explicitly before capping (the sibling setAgents
      // pattern): the server returns newest-first (sqlite ORDER BY timestamp
      // DESC), so the previous `.slice(-MAX)` — written as "keep the most
      // recent" — actually kept the OLDEST slice whenever a payload
      // exceeded the cap.
      messages: messages
        .map((m) => {
          if (m.scope !== undefined) return m;
          const classified = classifyMailboxRecipient(m.to);
          return { ...m, ...classified };
        })
        .sort((a, b) => (Date.parse(b.timestamp) || 0) - (Date.parse(a.timestamp) || 0))
        .slice(0, MAX_MAILBOX_MESSAGES),
    }),
  setAgents: (agents) =>
    set(() => {
      // Cap to MAX_MAILBOX_AGENTS; prune agents that have been offline
      // for longer than OFFLINE_AGENT_TTL_MS so a long-lived WebUI session
      // does not accumulate every agent it ever saw.
      const cutoff = Date.now() - OFFLINE_AGENT_TTL_MS;
      const pruned = agents.filter((agent) => {
        if (agent.online) return true;
        const seen = Date.parse(agent.lastSeenAt);
        return !Number.isFinite(seen) || seen >= cutoff;
      });
      if (pruned.length <= MAX_MAILBOX_AGENTS) return { agents: pruned };
      // Drop oldest by lastSeenAt when still over the cap.
      const sorted = [...pruned].sort((a, b) => {
        const aSeen = Date.parse(a.lastSeenAt) || 0;
        const bSeen = Date.parse(b.lastSeenAt) || 0;
        return bSeen - aSeen;
      });
      return { agents: sorted.slice(0, MAX_MAILBOX_AGENTS) };
    }),
  setLastCompaction: (lastCompaction) => set({ lastCompaction }),
  removeAgent: (agentId) =>
    set((state) => ({
      agents: state.agents.filter((agent) => agent.agentId !== agentId),
    })),
}));

/** Incomplete messages where no agent has acted yet (readByCount === 0).
 *  Driven by `incompleteOnly: true` query — the server filters to active
 *  messages, so anything with readByCount === 0 is genuinely unread. */
export function selectUnreadCount(s: MailboxState): number {
  return s.messages.filter((m) => !m.completed && (m.readByCount ?? 0) === 0).length;
}
