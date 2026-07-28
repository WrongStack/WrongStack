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

export interface SimpleMailboxService {
  protocolVersion: number;
  pid: number;
  clients: number;
  pendingRequests: number;
  storageKind: 'sqlite' | 'legacy-test-adapter';
}

export interface MailboxSnapshot {
  messages: SimpleMailboxMessage[];
  agents: SimpleMailboxAgent[];
  service: SimpleMailboxService | null;
  error: string | null;
}

export interface MailboxStore {
  getSnapshot: () => MailboxSnapshot;
  subscribe: (listener: () => void) => () => void;
  applyMessage: (message: MailboxWireMessage) => boolean;
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

function parseService(value: unknown): SimpleMailboxService | null {
  const item = record(value);
  if (
    !item ||
    typeof item['protocolVersion'] !== 'number' ||
    typeof item['pid'] !== 'number' ||
    typeof item['clients'] !== 'number' ||
    typeof item['pendingRequests'] !== 'number' ||
    (item['storageKind'] !== 'sqlite' && item['storageKind'] !== 'legacy-test-adapter')
  ) {
    return null;
  }
  return {
    protocolVersion: item['protocolVersion'],
    pid: item['pid'],
    clients: item['clients'],
    pendingRequests: item['pendingRequests'],
    storageKind: item['storageKind'],
  };
}

/**
 * Cap on retained mailbox messages (oldest dropped when over). Mirrors the
 * TUI `use-mailbox-view-model.ts:115` cap and the WebUI `mailbox-store.ts`
 * `MAX_MAILBOX_MESSAGES`. Without this, every distinct message id ever
 * received accumulates forever in long SimpleUI sessions.
 */
const MAX_MAILBOX_MESSAGES = 100;

/**
 * Cap on retained mailbox agents (oldest dropped when over). Mirrors the
 * WebUI `MAX_MAILBOX_AGENTS` cap.
 */
const MAX_MAILBOX_AGENTS = 50;

export function createMailboxStore(onRefreshNeeded?: () => void): MailboxStore {
  let snapshot: MailboxSnapshot = { messages: [], agents: [], service: null, error: null };
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
      if (message.type === 'mailbox.messages') {
        const parsed = parseMessages(payload['messages']);
        publish({
          ...snapshot,
          messages: parsed.slice(-MAX_MAILBOX_MESSAGES),
          error: text(payload['error']) || null,
        });
        return true;
      }
      if (message.type === 'mailbox.agents') {
        const parsed = parseAgents(payload['agents']);
        publish({
          ...snapshot,
          agents: parsed.slice(-MAX_MAILBOX_AGENTS),
          error: text(payload['error']) || null,
        });
        return true;
      }
      if (message.type === 'mailbox.status') {
        publish({
          ...snapshot,
          service: parseService(payload['status']),
          error: text(payload['error']) || null,
        });
        return true;
      }
      if (
        message.type === 'mailbox.received' ||
        message.type === 'mailbox.action_result' ||
        message.type === 'mailbox.agent_registered' ||
        message.type === 'mailbox.event' ||
        message.type === 'mailbox.sent'
      ) {
        onRefreshNeeded?.();
      }
      return false;
    },
  };
}
