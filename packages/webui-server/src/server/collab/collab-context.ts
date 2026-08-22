import type { CollaborationBus, ConsumedInjectionInfo } from '@wrongstack/core/coordination';
import type { AnnotationsStore, SessionReader } from '@wrongstack/core/storage';
import type { Logger } from '@wrongstack/core/types';
import type { WebSocket } from 'ws';
import type { WSCollabState, WSServerMessage } from '../types.js';
import type { CollabBroadcastScheduler } from './broadcast-scheduler.js';
import type { CollabSessionRegistry, Participant } from './session-registry.js';

export interface CollaborationHandlerOptions {
  /**
   * Resolve the session currently owned by this WebUI runtime. When supplied,
   * joins and live EventBus mirrors are constrained to that session.
   */
  getActiveSessionId?: (() => string) | undefined;
  /**
   * Host-owned authorization for roles that can mutate collaboration state.
   * Omission is intentionally fail-closed: clients may only join as observers.
   */
  authorizeRole?:
    | ((input: {
        ws: WebSocket;
        sessionId: string;
        requestedRole: Exclude<Participant['role'], 'observer'>;
      }) => boolean)
    | undefined;
}

/**
 * Shared wiring every collab feature module operates on. Extracted from
 * CollaborationWebSocketHandler (6A-2): features never reach back into the
 * transport class — they speak to this context, which the handler owns.
 */
export interface CollabContext {
  readonly registry: CollabSessionRegistry;
  readonly scheduler: CollabBroadcastScheduler;
  readonly logger: Logger;
  readonly reader?: SessionReader | undefined;
  readonly annotations?: AnnotationsStore | undefined;
  readonly bus?: CollaborationBus | undefined;
  readonly options: CollaborationHandlerOptions;
  send(ws: WebSocket, msg: WSServerMessage): void;
  broadcast(sessionId: string, msg: WSServerMessage): void;
  /** Eager state broadcast + fingerprint record (join/leave path). */
  broadcastState(sessionId: string): void;
  stateMessage(sessionId: string): WSCollabState;
  errorMessage(detail: string): WSServerMessage;
  /** Detach close/error listeners tracked by the transport (leave path). */
  detachSocket(ws: WebSocket): void;
  /**
   * Full socket teardown shared by `collab.leave` and WS close/error:
   * client removal, listener detach, leave choreography, and the
   * stop-broadcast-when-empty check. (Original handleDisconnect.)
   */
  removeSocket(ws: WebSocket): void;
}

export type { CollaborationBus, ConsumedInjectionInfo };

/**
 * The 5-step guard boilerplate every privileged handler repeats, collapsed
 * into one call (6A-2): store/bus availability stays in each feature (its
 * error text names the feature), this helper owns join + role checks.
 * Returns the participant on success; null after sending the error itself.
 */
export function requireJoinedRole(
  ctx: CollabContext,
  ws: WebSocket,
  action: string,
  role: 'annotator' | 'controller',
): Participant | null {
  const participant = ctx.registry.findParticipant(ws);
  if (!participant) {
    ctx.send(ws, ctx.errorMessage(`${action} requires an active join`));
    return null;
  }
  if (participant.role !== role) {
    ctx.send(
      ws,
      ctx.errorMessage(`${action} requires the '${role}' role (current: '${participant.role}')`),
    );
    return null;
  }
  return participant;
}
