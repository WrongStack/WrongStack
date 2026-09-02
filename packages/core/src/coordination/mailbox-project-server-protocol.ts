import type {
  IssueCredentialOptions,
  MailboxCredential,
  RedactedMailboxCredential,
} from './mailbox-credential-store.js';
import type { MailboxEvent } from './mailbox-events.js';
import type {
  AgentHeartbeatInput,
  AgentRegistrationInput,
  AutoCompactOptions,
  AutoCompactResult,
  ClientHeartbeatInput,
  ClientRegistrationInput,
  ClientStatus,
  MailboxAckBatchInput,
  MailboxAckInput,
  MailboxAgentStatus,
  MailboxMessage,
  MailboxQuery,
  MailboxSendInput,
  PurgeOptions,
  PurgeResult,
} from './mailbox-types.js';

/**
 * Wire protocol version. Embedded in the IPC endpoint path (see
 * `mailbox-project-server-endpoint.ts`), so a bump migrates clients to a fresh
 * socket and lets the `hello` handshake detect client/daemon skew loudly.
 *
 * v4: `authToken` became required on every `request` and `shutdown` (WS-027).
 * That is a breaking wire change — a pre-WS-027 client sends no token and would
 * fail every call with `UnauthorizedMailboxRequest` against a gated daemon.
 * Bumping the path keeps old clients on the old endpoint (where they spawn a
 * matching old daemon) instead of silently breaking against a new one.
 */
export const MAILBOX_PROJECT_SERVER_PROTOCOL_VERSION = 4;
export const MAILBOX_PROJECT_SERVER_MAX_FRAME_CHARS = 16 * 1024 * 1024;

/**
 * What the daemon tells a connecting client about itself. Carries NO secret —
 * see {@link MailboxProjectServerMetadata}.
 */
export interface MailboxProjectServerInfo {
  protocolVersion: number;
  pid: number;
  projectDir: string;
  endpoint: string;
  startedAt: string;
}

/**
 * The daemon's on-disk metadata file, written 0600. The auth token exists
 * here and nowhere else — never in the `hello` frame, which the daemon sends
 * to every socket that connects (the mistake WS-028 found in the SAGE daemon).
 */
export interface MailboxProjectServerMetadata extends MailboxProjectServerStatus {
  authToken: string;
}

export interface MailboxProjectServerStatus extends MailboxProjectServerInfo {
  clients: number;
  pendingRequests: number;
  /** Compatibility alias; points to databasePath for protocol v2+. */
  messagePath: string;
  databasePath: string;
  storageKind: 'sqlite' | 'legacy-test-adapter';
}

export interface MailboxServerOperations {
  ping: { args: Record<string, never>; result: MailboxProjectServerStatus };
  send: { args: { input: MailboxSendInput }; result: MailboxMessage };
  sendRuntimeControl: {
    args: { input: Omit<MailboxSendInput, 'type'> & { type?: 'control' } };
    result: MailboxMessage;
  };
  query: { args: { query: MailboxQuery }; result: MailboxMessage[] };
  ack: { args: { input: MailboxAckInput }; result: MailboxMessage | null };
  ackMany: { args: { input: MailboxAckBatchInput }; result: MailboxMessage[] };
  unreadCount: {
    args: { forAgentId: string; sessionId?: string | undefined };
    result: number;
  };
  softDelete: {
    args: { mailId: string; by: string };
    result: MailboxMessage | null;
  };
  restore: { args: { mailId: string }; result: MailboxMessage | null };
  registerAgent: { args: { input: AgentRegistrationInput }; result: void };
  deregisterAgent: { args: { agentId: string }; result: void };
  heartbeat: { args: { input: AgentHeartbeatInput }; result: void };
  getAgentStatuses: { args: Record<string, never>; result: MailboxAgentStatus[] };
  getOnlineAgents: { args: Record<string, never>; result: MailboxAgentStatus[] };
  purgeAgents: { args: { maxAgeMs?: number | undefined }; result: number };
  registerClient: { args: { input: ClientRegistrationInput }; result: void };
  deregisterClient: { args: { clientId: string }; result: void };
  clientHeartbeat: { args: { input: ClientHeartbeatInput }; result: void };
  getClientStatuses: { args: Record<string, never>; result: ClientStatus[] };
  purgeClients: { args: Record<string, never>; result: number };
  clearAll: { args: Record<string, never>; result: void };
  purgeStale: { args: { options?: PurgeOptions | undefined }; result: PurgeResult };
  autoCompact: {
    args: { options?: AutoCompactOptions | undefined };
    result: AutoCompactResult;
  };
  credentialIssue: {
    args: { options: IssueCredentialOptions };
    result: { credential: MailboxCredential; secret: string };
  };
  credentialVerify: {
    args: { credentialId: string; secret: string };
    result: {
      valid: boolean;
      credential?: RedactedMailboxCredential | undefined;
      reason?: string | undefined;
    };
  };
  credentialRevoke: {
    args: { credentialId: string; reason?: string | undefined; by?: string | undefined };
    result: boolean;
  };
  credentialRotate: {
    args: { credentialId: string; options?: Partial<IssueCredentialOptions> | undefined };
    result: { credential: MailboxCredential; secret: string } | null;
  };
  credentialGet: {
    args: { credentialId: string };
    result: RedactedMailboxCredential | null;
  };
  credentialList: {
    args: Record<string, never>;
    result: RedactedMailboxCredential[];
  };
  credentialStatusCounts: {
    args: Record<string, never>;
    result: Record<string, number>;
  };
}

export type MailboxServerOperationName = keyof MailboxServerOperations;

export type MailboxProjectServerClientMessage =
  | {
      type: 'request';
      id: number;
      op: MailboxServerOperationName;
      args: unknown;
      /**
       * WS-027: this daemon owns the project's message bus and its credential
       * store, and it had no handshake credential at all — any process that
       * could open the socket could send mail as any agent, read every
       * message, and issue or revoke credentials. The socket is 0600, but
       * that only excludes OTHER users, and on Windows it does not even do
       * that. The token comes from the daemon's owner-only metadata file.
       */
      authToken?: string | undefined;
    }
  | { type: 'heartbeat' }
  | {
      type: 'shutdown';
      id: number;
      reason?: string | undefined;
      /** Gated for the same reason as `request` — this stops the bus. */
      authToken?: string | undefined;
    };

const MAILBOX_SERVER_OPERATION_NAMES: Readonly<Record<MailboxServerOperationName, true>> = {
  ping: true,
  send: true,
  sendRuntimeControl: true,
  query: true,
  ack: true,
  ackMany: true,
  unreadCount: true,
  softDelete: true,
  restore: true,
  registerAgent: true,
  deregisterAgent: true,
  heartbeat: true,
  getAgentStatuses: true,
  getOnlineAgents: true,
  purgeAgents: true,
  registerClient: true,
  deregisterClient: true,
  clientHeartbeat: true,
  getClientStatuses: true,
  purgeClients: true,
  clearAll: true,
  purgeStale: true,
  autoCompact: true,
  credentialIssue: true,
  credentialVerify: true,
  credentialRevoke: true,
  credentialRotate: true,
  credentialGet: true,
  credentialList: true,
  credentialStatusCounts: true,
};

function isRequestId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasString(record: Record<string, unknown>, key: string): boolean {
  return typeof record[key] === 'string' && (record[key] as string).length > 0;
}

function hasRecord(record: Record<string, unknown>, key: string): boolean {
  return isRecord(record[key]);
}

function isMailboxServerOperationArgs(op: MailboxServerOperationName, value: unknown): boolean {
  if (!isRecord(value)) return false;
  switch (op) {
    case 'ping':
    case 'getAgentStatuses':
    case 'getOnlineAgents':
    case 'getClientStatuses':
    case 'purgeClients':
    case 'clearAll':
    case 'credentialList':
    case 'credentialStatusCounts':
      return true;
    case 'send':
    case 'sendRuntimeControl':
    case 'ack':
    case 'ackMany':
    case 'registerAgent':
    case 'heartbeat':
    case 'registerClient':
    case 'clientHeartbeat':
      return hasRecord(value, 'input');
    case 'query':
      return hasRecord(value, 'query');
    case 'unreadCount':
      return hasString(value, 'forAgentId');
    case 'softDelete':
      return hasString(value, 'mailId') && hasString(value, 'by');
    case 'restore':
      return hasString(value, 'mailId');
    case 'deregisterAgent':
      return hasString(value, 'agentId');
    case 'purgeAgents':
    case 'purgeStale':
    case 'autoCompact':
      return true;
    case 'deregisterClient':
      return hasString(value, 'clientId');
    case 'credentialIssue':
      return hasRecord(value, 'options');
    case 'credentialVerify':
      return hasString(value, 'credentialId') && hasString(value, 'secret');
    case 'credentialRevoke':
    case 'credentialRotate':
    case 'credentialGet':
      return hasString(value, 'credentialId');
  }
}

/** Runtime boundary guard for untrusted newline-delimited IPC frames. */
export function isMailboxProjectServerClientMessage(
  value: unknown,
): value is MailboxProjectServerClientMessage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  if (message['type'] === 'heartbeat') return true;
  if (message['type'] === 'shutdown') {
    return (
      isRequestId(message['id']) &&
      (message['reason'] === undefined || typeof message['reason'] === 'string')
    );
  }
  if (message['type'] !== 'request' || !isRequestId(message['id'])) return false;
  const op = message['op'];
  return (
    typeof op === 'string' &&
    Object.hasOwn(MAILBOX_SERVER_OPERATION_NAMES, op) &&
    isMailboxServerOperationArgs(op as MailboxServerOperationName, message['args'])
  );
}

export type MailboxProjectServerMessage =
  | ({ type: 'hello' } & MailboxProjectServerInfo)
  | { type: 'mailbox-event'; event: MailboxEvent }
  | { type: 'event'; event: string; payload: unknown }
  | { type: 'response'; id: number; ok: true; result: unknown }
  | {
      type: 'response';
      id: number;
      ok: false;
      error: string;
      errorName?: string | undefined;
    };

/** Runtime guard for server frames before the client touches discriminants. */
export function isMailboxProjectServerMessage(
  value: unknown,
): value is MailboxProjectServerMessage {
  if (!isRecord(value) || typeof value['type'] !== 'string') return false;
  if (value['type'] === 'hello') {
    return (
      Number.isInteger(value['protocolVersion']) &&
      Number.isInteger(value['pid']) &&
      hasString(value, 'projectDir') &&
      hasString(value, 'endpoint') &&
      hasString(value, 'startedAt')
    );
  }
  if (value['type'] === 'event') return hasString(value, 'event');
  if (value['type'] === 'mailbox-event') return isRecord(value['event']);
  if (value['type'] !== 'response' || !isRequestId(value['id'])) return false;
  if (value['ok'] === true) return Object.hasOwn(value, 'result');
  return value['ok'] === false && typeof value['error'] === 'string';
}

export function encodeMailboxProjectServerMessage(message: object): string {
  return `${JSON.stringify(message)}\n`;
}
