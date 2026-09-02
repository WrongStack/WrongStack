interface MailboxWireMessage {
  type: string;
  payload?: Record<string, unknown> | undefined;
}

export interface SimpleMailboxMessage {
  id: string;
  from: string;
  to: string;
  type: string;
  subject: string;
  body: string;
  priority: string;
  timestamp: string;
  completed: boolean;
  readByCount: number;
}

export interface SimpleMailboxAgent {
  agentId: string;
  name: string;
  role?: string | undefined;
  status: string;
  online: boolean;
}

export interface MailboxSnapshot {
  messages: SimpleMailboxMessage[];
  unreadCount: number;
  agents: SimpleMailboxAgent[];
  /**
   * Wall-clock ms of the most recent mailbox.* event the store consumed
   * from the server. `null` until the first event arrives. Lets the UI
   * render an "online / offline" chip from real traffic — the
   * `@wrongstack/webui-server` does not broadcast a `mailbox.status`
   * service-info payload, so we synthesize this signal locally instead.
   */
  lastEventAt: number | null;
  error: string | null;
}

export interface MailboxStore {
  getSnapshot: () => MailboxSnapshot;
  subscribe: (listener: () => void) => () => void;
  applyMessage: (message: MailboxWireMessage) => boolean;
}

export function isUnreadIncomingMailboxMessage(
  message: Pick<SimpleMailboxMessage, 'completed' | 'readByCount' | 'from'>,
): boolean {
  return (
    !message.completed &&
    message.readByCount === 0 &&
    message.from !== '' &&
    message.from !== 'webui' &&
    message.from !== 'simpleui'
  );
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function parseMessages(value: unknown): SimpleMailboxMessage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const item = record(entry);
    const id = text(item?.['id']);
    if (!item || !id) return [];
    const readBy = record(item['readBy']);
    return [
      {
        id,
        from: text(item['from']),
        to: text(item['to']),
        type: text(item['type']),
        subject: text(item['subject']),
        body: text(item['body']),
        priority: text(item['priority']) || 'normal',
        timestamp: text(item['timestamp']),
        completed: item['completed'] === true,
        readByCount:
          typeof item['readByCount'] === 'number'
            ? item['readByCount']
            : Object.keys(readBy ?? {}).length,
      },
    ];
  });
}

function parseAgents(value: unknown): SimpleMailboxAgent[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const item = record(entry);
    const agentId = text(item?.['agentId']);
    if (!item || !agentId) return [];
    return [
      {
        agentId,
        name: text(item['name']) || agentId,
        ...(text(item['role']) ? { role: text(item['role']) } : {}),
        status: text(item['status']) || 'idle',
        online: item['online'] === true,
      },
    ];
  });
}

/**
 * Cap on retained mailbox messages. Mirrors the TUI
 * `use-mailbox-view-model.ts:115` cap and the WebUI `mailbox-store.ts`
 * `MAX_MAILBOX_MESSAGES`. Without this, every distinct message id ever
 * received accumulates forever in long SimpleUI sessions.
 *
 * Applied with {@link keepNewest}, NOT `slice(-MAX)`. The server hands us
 * `mb.query()` output, which is sorted NEWEST-FIRST (SQLite `ORDER BY
 * timestamp DESC`), so a trailing slice keeps the OLDEST entries and drops
 * exactly the new mail the panel exists to show. The payload really can
 * exceed the cap: the `unreadOnly` path without an agent id asks the server
 * for `max(limit * 5, 100)`. The WebUI store hit this and fixed it; this one
 * carried the unfixed copy.
 */
const MAX_MAILBOX_MESSAGES = 100;

/**
 * Cap on retained mailbox agents. Mirrors the WebUI `MAX_MAILBOX_AGENTS` cap.
 *
 * The WebUI store drops the least-recently-seen agents, which needs
 * `lastSeenAt`; the SimpleUI agent projection does not carry it (see
 * `parseAgents`). Online agents are preferred instead — they are the ones the
 * sidebar is for — and the rest keep server order.
 */
const MAX_MAILBOX_AGENTS = 50;

/** Newest-first cap: sort by timestamp descending, then keep the head. */
function keepNewest<T extends { timestamp?: string | undefined }>(
  items: readonly T[],
  max: number,
): T[] {
  if (items.length <= max) return [...items];
  return [...items]
    .sort(
      (left, right) =>
        (Date.parse(right.timestamp ?? '') || 0) - (Date.parse(left.timestamp ?? '') || 0),
    )
    .slice(0, max);
}

export function createMailboxStore(onRefreshNeeded?: () => void): MailboxStore {
  let snapshot: MailboxSnapshot = {
    messages: [],
    unreadCount: 0,
    agents: [],
    lastEventAt: null,
    error: null,
  };
  const listeners = new Set<() => void>();
  const publish = (next: MailboxSnapshot): void => {
    snapshot = next;
    for (const listener of listeners) listener();
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    applyMessage: (message) => {
      const payload = message.payload ?? {};
      const observedAt = Date.now();
      if (message.type === 'mailbox.messages') {
        const parsed = parseMessages(payload['messages']);
        const isUnreadCountResponse = payload['unreadOnly'] === true;
        publish({
          ...snapshot,
          ...(isUnreadCountResponse
            ? { unreadCount: parsed.filter(isUnreadIncomingMailboxMessage).length }
            : { messages: keepNewest(parsed, MAX_MAILBOX_MESSAGES) }),
          lastEventAt: observedAt,
          error: text(payload['error']) || null,
        });
        return true;
      }
      if (message.type === 'mailbox.agents') {
        const parsed = parseAgents(payload['agents']);
        publish({
          ...snapshot,
          agents:
            parsed.length <= MAX_MAILBOX_AGENTS
              ? parsed
              : [...parsed.filter((a) => a.online), ...parsed.filter((a) => !a.online)].slice(
                  0,
                  MAX_MAILBOX_AGENTS,
                ),
          lastEventAt: observedAt,
          error: text(payload['error']) || null,
        });
        return true;
      }
      // `mailbox.status` was previously projected into `snapshot.service`,
      // but `@wrongstack/webui-server` never broadcasts that frame — see
      // packages/webui-server/src/server/setup-events.ts for the actual
      // server→client mailbox types. The branch is intentionally absent;
      // the sidebar derives "online" from `lastEventAt` instead.
      if (
        message.type === 'mailbox.received' ||
        message.type === 'mailbox.action_result' ||
        message.type === 'mailbox.agent_registered' ||
        message.type === 'mailbox.event' ||
        message.type === 'mailbox.sent'
      ) {
        publish({
          ...snapshot,
          lastEventAt: observedAt,
        });
        onRefreshNeeded?.();
      }
      return false;
    },
  };
}
