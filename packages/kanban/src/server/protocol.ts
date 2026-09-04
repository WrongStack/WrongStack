/**
 * Kanban Project Server — wire protocol
 *
 * Line-delimited JSON frames over a persistent net.Socket connection
 * (named pipe on Windows, Unix domain socket on other platforms).
 *
 * Framing:
 *   Client → Server  { id, method, params }
 *   Server → Client  { id, ok?, error?, result? }
 *   Server → Client  { type: 'event', event, data }
 *   Server → Client  { type: 'hello', ...info }
 *
 * Server → Client (errors):
 *   { id, error: { code, message } }
 *   code values: NOT_FOUND | READ_FAILED | WRITE_FAILED | INVALID_INPUT | INTERNAL_ERROR
 */

import type { KanbanDomainOperation } from '../domain-operations.js';
import type { KanbanBoard, KanbanBoardHistoryEntry, KanbanEvent } from '../types.js';

export const KANBAN_PROJECT_SERVER_PROTOCOL_VERSION = 6;

export type KanbanDomainWireValue =
  | ['null']
  | ['undefined']
  | ['boolean', boolean]
  | ['number', string]
  | ['string', string]
  | ['bigint', string]
  | ['date', string]
  | ['array', KanbanDomainWireValue[]]
  | ['object', Array<[string, KanbanDomainWireValue]>]
  | ['map', Array<[KanbanDomainWireValue, KanbanDomainWireValue]>]
  | ['set', KanbanDomainWireValue[]];

/**
 * Encode domain values into an unambiguous JSON-safe tree. Wrapping every value
 * avoids reserving a magic property name that could collide with task metadata.
 */
export function encodeKanbanDomainValue(value: unknown): KanbanDomainWireValue {
  return encodeDomainValue(value, new Set<object>());
}

function encodeDomainValue(value: unknown, ancestors: Set<object>): KanbanDomainWireValue {
  if (value === null) return ['null'];
  if (value === undefined) return ['undefined'];
  if (typeof value === 'boolean') return ['boolean', value];
  if (typeof value === 'number') return ['number', Object.is(value, -0) ? '-0' : String(value)];
  if (typeof value === 'string') return ['string', value];
  if (typeof value === 'bigint') return ['bigint', String(value)];
  if (typeof value !== 'object') {
    throw new TypeError(`Unsupported Kanban domain wire value: ${typeof value}`);
  }
  if (ancestors.has(value)) {
    throw new TypeError('Cyclic Kanban domain values cannot be sent over IPC');
  }

  ancestors.add(value);
  try {
    if (value instanceof Date) return ['date', value.toISOString()];
    if (Array.isArray(value)) {
      return ['array', Array.from(value, (item) => encodeDomainValue(item, ancestors))];
    }
    if (value instanceof Map) {
      return [
        'map',
        Array.from(value, ([key, item]) => [
          encodeDomainValue(key, ancestors),
          encodeDomainValue(item, ancestors),
        ]),
      ];
    }
    if (value instanceof Set) {
      return ['set', Array.from(value, (item) => encodeDomainValue(item, ancestors))];
    }
    return [
      'object',
      Object.entries(value).map(([key, item]) => [key, encodeDomainValue(item, ancestors)]),
    ];
  } finally {
    ancestors.delete(value);
  }
}

/** Decode and validate a domain value received from the IPC peer. */
export function decodeKanbanDomainValue(value: unknown): unknown {
  if (!Array.isArray(value) || typeof value[0] !== 'string') {
    throw new TypeError('Malformed Kanban domain wire value');
  }
  const payload = value[1];
  switch (value[0]) {
    case 'null':
      return null;
    case 'undefined':
      return undefined;
    case 'boolean':
      if (typeof payload === 'boolean') return payload;
      break;
    case 'number':
      if (typeof payload === 'string') {
        const number = Number(payload);
        const canonical = Object.is(number, -0) ? '-0' : String(number);
        if (Number.isFinite(number) && canonical === payload) return number;
      }
      break;
    case 'string':
      if (typeof payload === 'string') return payload;
      break;
    case 'bigint':
      if (typeof payload === 'string') return BigInt(payload);
      break;
    case 'date':
      if (typeof payload === 'string') {
        const date = new Date(payload);
        if (!Number.isNaN(date.getTime()) && date.toISOString() === payload) return date;
      }
      break;
    case 'array':
      if (Array.isArray(payload)) return payload.map(decodeKanbanDomainValue);
      break;
    case 'object':
      if (Array.isArray(payload)) {
        return Object.fromEntries(
          payload.map((entry) => {
            if (!Array.isArray(entry) || typeof entry[0] !== 'string') {
              throw new TypeError('Malformed Kanban domain object entry');
            }
            return [entry[0], decodeKanbanDomainValue(entry[1])];
          }),
        );
      }
      break;
    case 'map':
      if (Array.isArray(payload)) {
        return new Map(
          payload.map((entry) => {
            if (!Array.isArray(entry)) {
              throw new TypeError('Malformed Kanban domain map entry');
            }
            return [decodeKanbanDomainValue(entry[0]), decodeKanbanDomainValue(entry[1])];
          }),
        );
      }
      break;
    case 'set':
      if (Array.isArray(payload)) {
        return new Set(payload.map(decodeKanbanDomainValue));
      }
      break;
  }
  throw new TypeError(`Malformed Kanban domain wire value: ${value[0]}`);
}

// ─── Server metadata ─────────────────────────────────────────────────────────

export interface KanbanProjectServerInfo {
  protocolVersion: number;
  pid: number;
  projectRoot: string;
  endpoint: string;
  storage: 'sqlite';
  databasePath: string;
  startedAt: string;
}

export interface KanbanProjectServerStatus extends KanbanProjectServerInfo {
  clients: number;
  pendingRequests: number;
}

/**
 * The daemon's on-disk metadata, written 0600 into the project's own state
 * directory. The auth token exists here and nowhere else — see
 * {@link KanbanRequest.authToken}.
 */
export interface KanbanProjectServerMetadata extends KanbanProjectServerInfo {
  authToken: string;
}

/**
 * `<projectRoot>/.wrongstack/kanban-server.json`. Deliberately NOT inside the
 * kanbans directory — that directory is asserted to hold no `.json` files, as
 * the pin on the completed migration off the legacy JSON board store.
 */
export const KANBAN_PROJECT_SERVER_METADATA_FILE = 'kanban-server.json';

/** Durable cross-process command owned by the project-scoped Kanban daemon. */
export interface KanbanWorkflowCommand {
  id: string;
  workflowId: string;
  createdAt: string;
  type: string;
  payload?: unknown;
}

/** Revisioned durable state for a project-local workflow instance. */
export interface KanbanWorkflowState {
  workflowId: string;
  revision: number;
  updatedAt: string;
  value: unknown;
}

// ─── Operations exposed by the server ──────────────────────────────────────

export interface KanbanServerOperations {
  // Info / control
  ping: { args: Record<string, never>; result: KanbanProjectServerStatus };
  shutdown: { args: { reason?: string }; result: { stopping: boolean } };

  // Stateful public API. The operation name is an explicit shared allowlist;
  // projectRoot is never accepted from the client and is fixed by the owner.
  domainCall: {
    args: { operation: KanbanDomainOperation; wireArgs: KanbanDomainWireValue };
    result: KanbanDomainWireValue;
  };

  // Authoritative storage primitives. Public manager functions use these
  // when they need to execute local domain logic around an atomic board write.
  storageListBoardIds: { args: Record<string, never>; result: string[] };
  storageReadBoard: { args: { boardRef: string }; result: KanbanBoard | null };
  storageWriteBoard: {
    args: { board: KanbanBoard; expectedRevision?: number };
    result: { written: boolean };
  };
  storageAppendEvent: {
    args: { boardId: string; event: KanbanEvent };
    result: { appended: boolean };
  };
  storageReadEvents: { args: { boardRef: string }; result: KanbanEvent[] };
  storageAppendBoardHistory: {
    args: { entry: KanbanBoardHistoryEntry };
    result: { appended: boolean };
  };
  storageReadBoardHistory: {
    args: { boardId?: string };
    result: KanbanBoardHistoryEntry[];
  };
  storageDeleteBoard: { args: { boardRef: string }; result: boolean };
  storageReadMetadata: { args: { key: string }; result: string | null };
  storageWriteMetadata: {
    args: { key: string; value: string };
    result: { written: boolean };
  };

  // Generic workflow control plane. SDD and Goal keep their engine-specific
  // checkpoints, while cross-process commands share the same project owner as
  // their authoritative Kanban task state.
  workflowEnqueueCommand: {
    args: { workflowId: string; command: KanbanWorkflowCommand };
    result: { enqueued: boolean };
  };
  workflowDrainCommands: {
    args: { workflowId: string; limit?: number };
    result: KanbanWorkflowCommand[];
  };
  workflowReadState: {
    args: { workflowId: string };
    result: KanbanWorkflowState | null;
  };
  workflowWriteState: {
    args: { workflowId: string; value: unknown; expectedRevision?: number };
    result: KanbanWorkflowState;
  };
  workflowListStates: {
    args: { prefix: string; limit?: number };
    result: KanbanWorkflowState[];
  };
  workflowDeleteState: {
    args: { workflowId: string };
    result: boolean;
  };
}

export type KanbanServerMethod = keyof KanbanServerOperations;
export const KANBAN_SERVER_METHODS = [
  'ping',
  'shutdown',
  'domainCall',
  'storageListBoardIds',
  'storageReadBoard',
  'storageWriteBoard',
  'storageAppendEvent',
  'storageReadEvents',
  'storageAppendBoardHistory',
  'storageReadBoardHistory',
  'storageDeleteBoard',
  'storageReadMetadata',
  'storageWriteMetadata',
  'workflowEnqueueCommand',
  'workflowDrainCommands',
  'workflowReadState',
  'workflowWriteState',
  'workflowListStates',
  'workflowDeleteState',
] as const satisfies readonly KanbanServerMethod[];

// ─── Wire frames ────────────────────────────────────────────────────────────

export interface KanbanRequest<M extends KanbanServerMethod = KanbanServerMethod> {
  id: number;
  method: M;
  params: KanbanServerOperations[M]['args'];
  /**
   * WS-027: this daemon owns every board in the project — it can create,
   * mutate and delete them, and it drives the workflow command queue. It had
   * no handshake credential at all: anything that could open the socket could
   * do all of that. The 0700 socket directory only excludes OTHER users, and
   * on Windows named pipes it does not even do that.
   *
   * The token comes from the daemon's owner-only `server.json`, never from the
   * `hello` frame — `hello` is sent to every socket that connects, which is
   * exactly how the SAGE daemon ended up handing out its own credential
   * (WS-028).
   */
  authToken?: string | undefined;
}

export interface KanbanSuccessResponse {
  id: number;
  ok: true;
  result: unknown;
}

export interface KanbanErrorResponse {
  id: number;
  error: {
    code: KanbanErrorCode;
    message: string;
    cause?: unknown;
  };
}

export type KanbanResponse = KanbanSuccessResponse | KanbanErrorResponse;

export type KanbanErrorCode =
  | 'NOT_FOUND'
  | 'READ_FAILED'
  | 'WRITE_FAILED'
  | 'INVALID_INPUT'
  | 'ALREADY_EXISTS'
  | 'STALE_WRITE'
  | 'LIFECYCLE'
  | 'INTERNAL_ERROR';

export interface KanbanServerEvent {
  type: 'event';
  event: KanbanEventName;
  data: unknown;
}

export type KanbanEventName =
  | 'board.created'
  | 'board.updated'
  | 'board.deleted'
  | 'workflow.command'
  | 'workflow.state.updated'
  | 'workflow.state.deleted';

export interface KanbanHelloFrame extends KanbanProjectServerInfo {
  type: 'hello';
}
