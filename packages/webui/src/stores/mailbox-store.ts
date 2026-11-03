import { isMailboxMessageUnread } from '@wrongstack/contracts/types/mailbox';
import {
  retainMailboxAgents,
  retainMailboxMessages,
} from '@wrongstack/project-surfaces/office/feed-model';
import type { MailboxAgent, MailboxMessage } from '@wrongstack/project-surfaces/office/types';
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

export { classifyMailboxRecipient } from '@wrongstack/project-surfaces/office/feed-model';

export type {
  MailboxAgent,
  MailboxMessage,
} from '@wrongstack/project-surfaces/office/types';

interface MailboxCompactionResult {
  readByAllRemoved: number;
  expiredRemoved: number;
  stalePurged: number;
  totalRemoved: number;
  remaining: number;
}

/** Lifecycle of the message-list query (MailboxPanel loading/error branches). */
export type MailboxListStatus = 'idle' | 'loading' | 'ready' | 'error';

interface MailboxState {
  messages: MailboxMessage[];
  agents: MailboxAgent[];
  /** Result of the last auto-compact operation, if any. */
  lastCompaction: MailboxCompactionResult | null;
  /** Query lifecycle for the messages list ('mailbox.messages' request). */
  listStatus: MailboxListStatus;
  /** Friendly error from the last failed list load, if any. */
  listError: string | null;
  setMessages: (messages: MailboxMessage[]) => void;
  setAgents: (agents: MailboxAgent[]) => void;
  setLastCompaction: (result: MailboxCompactionResult | null) => void;
  /** Drop one agent by id (mailbox.agent_deregistered push). */
  removeAgent: (agentId: string) => void;
  /** Mark the list query as in flight (called when the panel sends it). */
  beginListLoad: () => void;
  /** Mark the list query failed (ws payload error path). */
  failListLoad: (error: string) => void;
}

export const useMailboxStore = create<MailboxState>()((set) => ({
  messages: [],
  agents: [],
  lastCompaction: null,
  listStatus: 'idle',
  listError: null,
  setMessages: (messages) =>
    set({
      listStatus: 'ready',
      listError: null,
      messages: retainMailboxMessages(messages),
    }),
  setAgents: (agents) => set({ agents: retainMailboxAgents(agents, Date.now()) }),
  setLastCompaction: (lastCompaction) => set({ lastCompaction }),
  beginListLoad: () => set({ listStatus: 'loading' }),
  failListLoad: (error) => set({ listStatus: 'error', listError: error }),
  removeAgent: (agentId) =>
    set((state) => ({
      agents: state.agents.filter((agent) => agent.agentId !== agentId),
    })),
}));

/** Incomplete messages where no agent has acted yet (readByCount === 0).
 *  Driven by `incompleteOnly: true` query — the server filters to active
 *  messages, so anything with readByCount === 0 is genuinely unread. */
export function selectUnreadCount(s: MailboxState): number {
  return s.messages.filter((m) => isMailboxMessageUnread(m)).length;
}
