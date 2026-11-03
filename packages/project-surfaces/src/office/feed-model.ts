import type {
  LiveSession,
  MailboxAgent,
  MailboxMessage,
  MailboxMessageScope,
  VizEvent,
} from './types';

/** Cap on retained mailbox messages (oldest dropped when over). Mirrors TUI `use-mailbox-view-model.ts`. */
export const MAX_MAILBOX_MESSAGES = 100;

/** Cap on retained mailbox agents (oldest dropped when over). */
export const MAX_MAILBOX_AGENTS = 50;

/** Age after which an offline agent entry is pruned. */
export const OFFLINE_AGENT_TTL_MS = 6 * 60 * 60 * 1000;

const SESSION_RECIPIENT_PREFIX = '@session:';

/**
 * Classify a mailbox recipient address for UI labeling. Mirrors the
 * server-side helper in `@wrongstack/core/hq/mailbox-mapper` so a client can
 * color messages consistently even when the server payload is stale or
 * missing the scope field.
 */
export function classifyMailboxRecipient(to: string): {
  scope: MailboxMessageScope;
  recipientSessionId?: string;
} {
  if (to === '*' || to === 'all') return { scope: 'project' };
  if (to.startsWith(SESSION_RECIPIENT_PREFIX)) {
    const recipientSessionId = to.slice(SESSION_RECIPIENT_PREFIX.length);
    if (recipientSessionId.length === 0) return { scope: 'agent' };
    return { scope: 'session', recipientSessionId };
  }
  return { scope: 'agent' };
}

/**
 * The messages a client keeps from a `mailbox.messages` reply: classified, newest first
 * (sorted explicitly before capping, so an oversized reply keeps its newest rather than its
 * oldest slice) and capped.
 */
export function retainMailboxMessages(messages: MailboxMessage[]): MailboxMessage[] {
  return messages
    .map((message) => {
      if (message.scope !== undefined) return message;
      return { ...message, ...classifyMailboxRecipient(message.to) };
    })
    .sort((a, b) => (Date.parse(b.timestamp) || 0) - (Date.parse(a.timestamp) || 0))
    .slice(0, MAX_MAILBOX_MESSAGES);
}

/**
 * The agents a client keeps from a `mailbox.agents` reply: agents offline for longer than
 * {@link OFFLINE_AGENT_TTL_MS} are pruned, then the most recently seen are kept up to the cap.
 */
export function retainMailboxAgents(agents: MailboxAgent[], now: number): MailboxAgent[] {
  const cutoff = now - OFFLINE_AGENT_TTL_MS;
  const pruned = agents.filter((agent) => {
    if (agent.online) return true;
    const seen = Date.parse(agent.lastSeenAt);
    return !Number.isFinite(seen) || seen >= cutoff;
  });
  if (pruned.length <= MAX_MAILBOX_AGENTS) return pruned;
  return [...pruned]
    .sort((a, b) => (Date.parse(b.lastSeenAt) || 0) - (Date.parse(a.lastSeenAt) || 0))
    .slice(0, MAX_MAILBOX_AGENTS);
}

function clampCtxPct(pct: number | undefined): number | undefined {
  if (pct === undefined) return undefined;
  if (!Number.isFinite(pct)) return 0;
  return Math.max(0, Math.min(100, Math.round(pct)));
}

/** A registry snapshot with every agent's context load clamped to 0–100. */
export function normalizeLiveSessions(sessions: LiveSession[]): LiveSession[] {
  return sessions.map((session) => ({
    ...session,
    agents: session.agents.map((agent) => ({
      ...agent,
      ctxPct: clampCtxPct(agent.ctxPct),
    })),
  }));
}

/**
 * The activity-feed entry for a `mailbox.event` frame. The mailbox emits `mailbox.message_sent`
 * for a send (older hosts and tests say `mailbox.sent`); agent and client heartbeats arrive
 * every few seconds and are not traffic, so they make no entry.
 */
export function mailboxVizEvent(payload: Record<string, unknown>, id: string): VizEvent | null {
  const name = typeof payload['event'] === 'string' ? payload['event'] : '';
  if (name.endsWith('_heartbeat')) return null;
  const from = typeof payload['from'] === 'string' ? payload['from'] : '?';
  const to = typeof payload['to'] === 'string' ? payload['to'] : '?';
  const subject = typeof payload['subject'] === 'string' ? payload['subject'] : '';
  const isSend = name === 'mailbox.message_sent' || name === 'mailbox.sent';
  return {
    id,
    kind: isSend ? 'mailbox:send' : 'mailbox:deliver',
    timestamp: Date.now(),
    source: from,
    target: to,
    label: subject || (isSend ? `→ ${to}` : `← ${from}`),
    magnitude: 1,
    data: payload,
    color: 'hsl(var(--success))',
    flowGroup: 'mailbox',
  };
}
