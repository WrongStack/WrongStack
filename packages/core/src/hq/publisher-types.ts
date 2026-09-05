import type { Logger } from '../types/logger.js';
import type {
  HqClientCapability,
  HqClientIdentity,
  HqEventType,
  HqKanbanSnapshotPayload,
  HqProjectIdentity,
  HqQueuedCommand,
  HqRedactionPolicy,
} from './protocol.js';

export interface HqSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener?(
    type: 'open' | 'close' | 'error' | 'message',
    listener: (event: unknown) => void,
  ): void;
  removeEventListener?(
    type: 'open' | 'close' | 'error' | 'message',
    listener: (event: unknown) => void,
  ): void;
  on?(type: 'open' | 'close' | 'error' | 'message', listener: (event: unknown) => void): void;
  off?(type: 'open' | 'close' | 'error' | 'message', listener: (event: unknown) => void): void;
}

export type HqSocketFactory = (url: string, init: { token?: string }) => HqSocketLike;

export interface HqPublisherCommandResult {
  commandId: string;
  status: 'accepted' | 'completed' | 'failed' | 'rejected';
  message?: string;
}

export type HqPublisherCommandHandler = (
  command: HqQueuedCommand,
) => void | HqPublisherCommandResult | Promise<void | HqPublisherCommandResult>;

export interface HqPublisherOptions {
  url: string;
  token?: string;
  client: HqClientIdentity;
  project: HqProjectIdentity;
  capabilities?: readonly HqClientCapability[];
  socketFactory?: HqSocketFactory;
  now?: () => string;
  idFactory?: () => string;
  reconnect?: boolean;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  connectWarnAfterFailures?: number;
  connectWarnCooldownMs?: number;
  maxQueuedMessages?: number;
  maxQueuedBytes?: number;
  redactionPolicy?: Partial<HqRedactionPolicy>;
  commandPollIntervalMs?: number;
  commandPollLimit?: number;
  onCommand?: HqPublisherCommandHandler;
  onKanbanSnapshot?: (snapshot: HqKanbanSnapshotPayload) => void | Promise<void>;
  resolveEndpoint?: () => { url: string; token?: string | undefined } | undefined;
  discoveryPollMs?: number;
  heartbeatIntervalMs?: number;
  warn?: (message: string) => void;
  logger?: Logger | undefined;
}

export interface HqPublishEventOptions {
  type: HqEventType | (string & {});
  payload: unknown;
  sessionId?: string;
  runId?: string;
  timestamp?: string;
  maxSummaryLength?: number;
}
