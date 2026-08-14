import type { TrustBoundary } from '@wrongstack/core/security';
import type { WebSocket } from 'ws';
import type { authorizeWebUIAction } from '../privileged-actions.js';
import type { WSServerMessage } from '../types.js';

export type ConnectionHealthStatus = 'healthy' | 'degraded' | 'offline' | 'unavailable' | 'error';

export interface ConnectionHealthService {
  id:
    | 'webui'
    | 'session-catalog'
    | 'chronicle'
    | 'codebase-index'
    | 'sage'
    | 'kanban'
    | 'mailbox'
    | 'governance';
  label: string;
  status: ConnectionHealthStatus;
  required: boolean;
  mode: string;
  detail: string;
  ownerPid?: number | undefined;
  endpoint?: string | undefined;
  storage?: string | undefined;
  uptimeMs?: number | undefined;
  latencyMs?: number | undefined;
  clients?: number | undefined;
  activeRequests?: number | undefined;
  queuedWork?: number | undefined;
  watcher?: { active: boolean; watchedFiles?: number | undefined } | undefined;
  lastError?: string | undefined;
  control?: 'shutdown' | 'none' | undefined;
  advisory?:
    | {
        code: string;
        operatorAction: 'none' | 'observe' | 'investigate';
        executionDisposition: 'continue';
      }
    | undefined;
}

export interface ConnectionsHealthReport {
  checkedAt: number;
  overall: 'healthy' | 'degraded' | 'error';
  backend: 'standalone' | 'cli-embedded';
  projectRoot: string;
  services: ConnectionHealthService[];
}

export interface ConnectionsHealthContext {
  getProjectRoot(): string;
  getIndexDir(): string | undefined;
  send(ws: WebSocket, message: WSServerMessage): void;
  backend: ConnectionsHealthReport['backend'];
  collect?: (() => Promise<ConnectionsHealthReport>) | undefined;
  trustBoundary?: TrustBoundary | undefined;
  logger?: Parameters<typeof authorizeWebUIAction>[2];
}

export interface ServiceActionResult {
  serviceId: ConnectionHealthService['id'] | null;
  action: 'shutdown' | 'restart';
  success: boolean;
  message: string;
}
