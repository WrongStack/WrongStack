import type {
  HqAlertMessage,
  HqCommandAuditEntry,
  HqEventEnvelope,
  HqSnapshot,
} from '@wrongstack/core/hq';
import type { ProtocolEnvelope } from './types.js';

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function finite(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** When a key is present it must be an array; when absent it is acceptable. */
function optionalArray(value: unknown): boolean {
  return value === undefined || Array.isArray(value);
}

/** Validate that all required numeric fields of a totals object are finite. */
function isValidHqTotals(totals: Record<string, unknown>): boolean {
  return (
    finite(totals['activeProjects']) === totals['activeProjects'] &&
    finite(totals['activeClients']) === totals['activeClients'] &&
    finite(totals['activeSessions']) === totals['activeSessions'] &&
    finite(totals['activeSubagents']) === totals['activeSubagents'] &&
    finite(totals['unreadMailboxMessages']) === totals['unreadMailboxMessages'] &&
    finite(totals['incompleteMailboxMessages']) === totals['incompleteMailboxMessages'] &&
    finite(totals['totalCostUsd']) === totals['totalCostUsd']
  );
}

export interface SessionProjection {
  kind: 'session';
  id: string;
  provider: string;
  model: string;
  projectName: string;
  cwd: string;
  maxContext: number;
  reset: boolean;
  replayMessages: unknown[] | null;
  /** Audit markers replayed alongside the conversation. */
  replayMarkers: unknown[] | null;
  replayUsage: Record<string, unknown> | null;
}

export function projectSessionMessage(message: ProtocolEnvelope): SessionProjection | null {
  if (message.type !== 'session.start') return null;
  const payload = record(message.payload);
  if (!payload) return null;
  return {
    kind: 'session',
    id: text(payload['sessionId']),
    provider: text(payload['provider']),
    model: text(payload['model']),
    projectName: text(payload['projectName'], 'Project'),
    cwd: text(payload['cwd']),
    maxContext: finite(payload['maxContext']),
    reset: payload['reset'] === true,
    replayMessages: Array.isArray(payload['replayMessages']) ? payload['replayMessages'] : null,
    replayMarkers: Array.isArray(payload['replayMarkers']) ? payload['replayMarkers'] : null,
    replayUsage: record(payload['replayUsage']),
  };
}

export type ChatProjection =
  | { kind: 'thinking-delta'; text: string }
  | { kind: 'text-delta'; text: string; messageId: string }
  /** `stopReason` distinguishes the turn's final response from a mid-turn one
   *  that stopped to call a tool — surfaces gate `<nextsteps>` on it. */
  | { kind: 'response'; content: unknown; stopReason: string }
  | { kind: 'run-result'; status: string; iterations: number; finalText?: string | undefined }
  | { kind: 'error'; message: string };

export function projectChatMessage(message: ProtocolEnvelope): ChatProjection | null {
  const payload = record(message.payload);
  if (!payload) return null;
  switch (message.type) {
    case 'provider.thinking_delta': {
      const value = text(payload['text']);
      return value ? { kind: 'thinking-delta', text: value } : null;
    }
    case 'provider.text_delta': {
      const value = text(payload['text']);
      return value
        ? { kind: 'text-delta', text: value, messageId: text(payload['messageId']) }
        : null;
    }
    case 'provider.response':
      return {
        kind: 'response',
        content: payload['content'],
        stopReason: text(payload['stopReason']),
      };
    case 'run.result':
      return {
        kind: 'run-result',
        status: text(payload['status']),
        iterations: finite(payload['iterations'], 1),
        ...(typeof payload['finalText'] === 'string' ? { finalText: payload['finalText'] } : {}),
      };
    case 'error':
      return { kind: 'error', message: text(payload['message'], 'Run failed') };
    default:
      return null;
  }
}

export type ToolProjection =
  | { kind: 'started'; id: string; name: string; input: unknown; messageId: string }
  | { kind: 'progress'; id: string; name: string; eventType: string; text: string }
  | {
      kind: 'executed';
      id: string;
      name: string;
      ok: boolean;
      output?: string | undefined;
      /**
       * SAGE Memory Injector block (header line first) split off the tool text
       * at the emit site. Clients render it as a memory card — it must never be
       * concatenated back into `output`.
       */
      sage?: string[] | undefined;
      durationMs: number;
    };

export function projectToolMessage(message: ProtocolEnvelope): ToolProjection | null {
  const payload = record(message.payload);
  if (!payload) return null;
  if (message.type === 'tool.started') {
    const name = text(payload['name'], 'tool');
    return {
      kind: 'started',
      id: text(payload['id'], name),
      name,
      input: payload['input'],
      messageId: text(payload['messageId']),
    };
  }
  if (message.type === 'tool.progress') {
    const event = record(payload['event']);
    return {
      kind: 'progress',
      id: text(payload['id']),
      name: text(payload['name'], 'tool'),
      eventType: text(event?.['type']),
      text: text(event?.['text']).trim(),
    };
  }
  if (message.type === 'tool.executed') {
    return {
      kind: 'executed',
      id: text(payload['id']),
      name: text(payload['name']),
      ok: payload['ok'] !== false,
      durationMs: finite(payload['durationMs']),
      ...(typeof payload['output'] === 'string' ? { output: payload['output'] } : {}),
      ...(Array.isArray(payload['sage'])
        ? { sage: payload['sage'].filter((line): line is string => typeof line === 'string') }
        : {}),
    };
  }
  return null;
}

export type FleetProjection =
  | {
      kind: 'concurrency';
      active: number;
      maximum: number;
      maxSpawns?: number | undefined;
      usedSpawns?: number | undefined;
      remainingSpawns?: number | undefined;
      maxSpawnsSource?: string | undefined;
      maxConcurrentSource?: string | undefined;
      effectiveSource?: string | undefined;
      checkpointMaxSpawns?: number | undefined;
      ceilingMismatch?: boolean | undefined;
    }
  | { kind: 'client-status'; status: Record<string, unknown> }
  | { kind: 'sessions'; sessions: unknown[] }
  | { kind: 'coordinator'; agents: Array<Record<string, unknown>> };

function optionalFinite(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function projectFleetMessage(message: ProtocolEnvelope): FleetProjection | null {
  const payload = record(message.payload);
  if (!payload) return null;
  switch (message.type) {
    case 'fleet.concurrency_update':
      return {
        kind: 'concurrency',
        active: finite(payload['fleetConcurrency']),
        maximum: finite(payload['fleetConcurrencyMax']),
        maxSpawns: optionalFinite(payload['maxSpawns']),
        usedSpawns: optionalFinite(payload['usedSpawns']),
        remainingSpawns: optionalFinite(payload['remainingSpawns']),
        maxSpawnsSource: optionalString(payload['maxSpawnsSource']),
        maxConcurrentSource: optionalString(payload['maxConcurrentSource']),
        effectiveSource: optionalString(payload['effectiveSource']),
        checkpointMaxSpawns: optionalFinite(payload['checkpointMaxSpawns']),
        ceilingMismatch: payload['ceilingMismatch'] === true ? true : undefined,
      };
    case 'client.status_update':
      return { kind: 'client-status', status: payload };
    case 'sessions.status_update':
      return {
        kind: 'sessions',
        sessions: Array.isArray(payload['sessions']) ? payload['sessions'] : [],
      };
    case 'coordinator.stats':
      return {
        kind: 'coordinator',
        agents: Array.isArray(payload['subagentStatuses'])
          ? payload['subagentStatuses'].filter(
              (item): item is Record<string, unknown> => record(item) !== null,
            )
          : [],
      };
    default:
      return null;
  }
}

export interface HqFleetProjection {
  kind: 'hq-snapshot';
  snapshot: HqSnapshot;
}

/**
 * Validate the stable outer shape of an HQ fleet snapshot before a browser
 * surface commits it to state. Domain-specific records remain owned by Core;
 * this boundary only rejects truncated or unrelated wire frames.
 */
export function projectHqFleetMessage(message: {
  type: string;
  snapshot?: unknown;
}): HqFleetProjection | null {
  if (message.type !== 'hq.snapshot') return null;
  const snapshot = record(message.snapshot);
  const totals = snapshot ? record(snapshot['totals']) : null;
  if (
    !snapshot ||
    typeof snapshot['generatedAt'] !== 'string' ||
    !Array.isArray(snapshot['clients']) ||
    !Array.isArray(snapshot['projects']) ||
    !Array.isArray(snapshot['sessions']) ||
    !Array.isArray(snapshot['fleets']) ||
    !Array.isArray(snapshot['mailboxes']) ||
    !totals ||
    !isValidHqTotals(totals) ||
    !optionalArray(snapshot['machines']) ||
    !optionalArray(snapshot['liveSessions']) ||
    !optionalArray(snapshot['mcpServers'])
  ) {
    return null;
  }
  return { kind: 'hq-snapshot', snapshot: snapshot as unknown as HqSnapshot };
}

// ── HQ sibling projections (event, alert, command_status) ─────────────────
//
// These mirrors of projectHqFleetMessage validate the outer envelope shape of
// hq.event / hq.alert / hq.command_status frames before the browser surface
// commits them to store state, closing the trust-boundary gap flagged in
// review — every branch now passes through a projection, not just hq.snapshot.

export interface HqEventProjection {
  kind: 'hq-event';
  event: HqEventEnvelope;
}

export function projectHqEventMessage(message: {
  type: string;
  event?: unknown;
}): HqEventProjection | null {
  if (message.type !== 'hq.event') return null;
  const event = record(message.event);
  if (
    !event ||
    typeof event['id'] !== 'string' ||
    typeof event['type'] !== 'string' ||
    typeof event['timestamp'] !== 'string' ||
    typeof event['clientId'] !== 'string' ||
    typeof event['projectId'] !== 'string' ||
    typeof event['seq'] !== 'number'
  ) {
    return null;
  }
  return { kind: 'hq-event', event: event as unknown as HqEventEnvelope };
}

export interface HqAlertProjection {
  kind: 'hq-alert';
  alert: HqAlertMessage;
}

export function projectHqAlertMessage(message: {
  type: string;
  severity?: unknown;
  message?: unknown;
  timestamp?: unknown;
}): HqAlertProjection | null {
  if (message.type !== 'hq.alert') return null;
  if (
    typeof message['severity'] !== 'string' ||
    !['info', 'warn', 'error'].includes(message['severity']) ||
    typeof message['message'] !== 'string' ||
    typeof message['timestamp'] !== 'string'
  ) {
    return null;
  }
  return { kind: 'hq-alert', alert: message as unknown as HqAlertMessage };
}

export interface HqCommandStatusProjection {
  kind: 'hq-command-status';
  command: HqCommandAuditEntry;
}

export function projectHqCommandStatusMessage(message: {
  type: string;
  command?: unknown;
}): HqCommandStatusProjection | null {
  if (message.type !== 'hq.command_status') return null;
  const command = record(message.command);
  if (
    !command ||
    typeof command['commandId'] !== 'string' ||
    typeof command['type'] !== 'string' ||
    typeof command['clientId'] !== 'string' ||
    typeof command['enqueuedBy'] !== 'string' ||
    typeof command['enqueuedAt'] !== 'string' ||
    typeof command['status'] !== 'string' ||
    !['queued', 'delivered', 'acked'].includes(command['status'])
  ) {
    return null;
  }
  return { kind: 'hq-command-status', command: command as unknown as HqCommandAuditEntry };
}
