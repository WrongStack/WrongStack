export type ConnectionHealthStatus = 'healthy' | 'degraded' | 'offline' | 'unavailable' | 'error';

export interface ConnectionHealthService {
  id: 'webui' | 'chronicle' | 'codebase-index' | 'sage' | 'kanban' | 'mailbox' | 'governance';
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

export interface ServiceActionResult {
  serviceId: ConnectionHealthService['id'] | null;
  action: 'shutdown' | 'restart';
  success: boolean;
  message: string;
}

/** Server→client auto-heal visibility event (`connections.auto_heal_status`). */
export type AutoHealStatusPhase = 'restarting' | 'restarted' | 'failed' | 'escalated' | 'refused';

export interface AutoHealStatusEvent {
  serviceId: ConnectionHealthService['id'] | null;
  phase: AutoHealStatusPhase;
  message: string;
  at: number;
  /** 1-based attempt number within the current failure streak. */
  attempt: number;
}
