import type {
  MailboxAgentStatus,
  MailboxMessage,
  MailboxProjectServerStatus,
} from '@wrongstack/core/coordination';

export interface TuiMailboxSnapshot {
  actorId?: string | undefined;
  messages: MailboxMessage[];
  agents: MailboxAgentStatus[];
  unread: number;
  clients: { tui: number; webui: number; repl: number };
  service:
    | ({ state: 'online' } & Pick<
        MailboxProjectServerStatus,
        'storageKind' | 'pid' | 'clients' | 'pendingRequests' | 'protocolVersion'
      >)
    | { state: 'offline'; error?: string | undefined };
}
