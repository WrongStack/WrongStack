import type { CollaborationBus, ConsumedInjectionInfo } from '@wrongstack/core/coordination';
import type { EventBus } from '@wrongstack/core/kernel';
import type { AnnotationsStore, SessionReader } from '@wrongstack/core/storage';
import type { Logger } from '@wrongstack/core/types';
import { toErrorMessage } from '@wrongstack/core/utils';
import type { WebSocket } from 'ws';
import { AnnotateFeature, ResolveFeature } from './collab/annotations.js';
import { CollabBroadcastScheduler } from './collab/broadcast-scheduler.js';
import type { CollabContext, CollaborationHandlerOptions } from './collab/collab-context.js';
import { GrantControlFeature, RequestPauseFeature, ResumeFeature } from './collab/controller.js';
import { CollabDispatcher, type CollabInboundMessage } from './collab/dispatcher.js';
import { broadcastInjectionConsumed, InjectToolFeature } from './collab/injection.js';
import { LeaveFeature, MembershipFeature } from './collab/membership.js';
import { subscribeCollabMirror } from './collab/mirror.js';
import { CollabSessionRegistry } from './collab/session-registry.js';
import type { WSServerMessage } from './types.js';
import { sendSerialized } from './ws-utils.js';

export type { CollaborationHandlerOptions };

/**
 * CollaborationWebSocketHandler — session-scoped collaboration transport.
 * Mirrors `WorktreeWebSocketHandler` and `GoalWebSocketHandler`.
 *
 * Split (6A): this file is now the thin transport + wiring shell; the
 * protocol lives in collab/ feature modules dispatched by CollabDispatcher.
 * Behavior is preserved verbatim — the 34-test suite in
 * tests/collaboration-ws-handler.test.ts pins the wire protocol, replay
 * semantics, and the dispose/leave ordering.
 *
 * Protocol (see `packages/webui/src/types.ts`):
 *   client → server:  collab.join { sessionId, role: 'observer' }
 *                     collab.leave { sessionId }
 *   server → client:  collab.state          (initial + 2s periodic)
 *                     collab.participant.joined
 *                     collab.participant.left
 *                     collab.event          (live kernel event mirror)
 */
export class CollaborationWebSocketHandler {
  private readonly registry = new CollabSessionRegistry();
  private readonly scheduler: CollabBroadcastScheduler;
  private readonly dispatcher = new CollabDispatcher([
    new MembershipFeature(),
    new LeaveFeature(),
    new AnnotateFeature(),
    new ResolveFeature(),
    new RequestPauseFeature(),
    new ResumeFeature(),
    new GrantControlFeature(),
    new InjectToolFeature(),
  ]);
  private readonly offs: Array<() => void> = [];
  /** Per-socket disconnect removers so dispose() can detach still-live sockets. */
  private readonly socketOffs = new Map<WebSocket, () => void>();
  private readonly ctx: CollabContext;

  constructor(
    private readonly events: EventBus,
    private readonly logger: Logger,
    private readonly reader?: SessionReader | undefined,
    private readonly annotations?: AnnotationsStore | undefined,
    private readonly bus?: CollaborationBus | undefined,
    private readonly options: CollaborationHandlerOptions = {},
  ) {
    // Broadcast serialization is shared via the context below; keep one
    // pre-serialized frame per broadcast like the original (hot path).
    this.scheduler = new CollabBroadcastScheduler(this.registry, (sessionId) =>
      this.broadcastState(sessionId),
    );
    this.ctx = this.makeContext();
    subscribeCollabMirror(this.ctx, this.events, this.offs);
    // Phase 4 feedback loop: when the inject middleware applies a queued
    // injection, broadcast a `consumed` grant so observers see it landed.
    // Store the disposer in this.offs so dispose() removes the callback,
    // preventing the handler closure from keeping this instance alive
    // via the bus reference after teardown.
    const offInjection = this.bus?.onInjectionConsumed((info: ConsumedInjectionInfo) =>
      broadcastInjectionConsumed(this.ctx, info),
    );
    if (offInjection) this.offs.push(offInjection);
  }

  // ── Public API (called by server/index.ts per WS connection) ───────────

  addClient(ws: WebSocket): void {
    if (this.registry.clients.has(ws)) return;
    this.registry.clients.add(ws);
    this.scheduler.ensure();
    const onDisconnect = (): void => this.removeSocket(ws);
    const detach = (): void => {
      if (typeof ws.off === 'function') {
        ws.off('close', onDisconnect);
        ws.off('error', onDisconnect);
      } else if (typeof ws.removeListener === 'function') {
        ws.removeListener('close', onDisconnect);
        ws.removeListener('error', onDisconnect);
      }
      this.socketOffs.delete(ws);
    };
    if (typeof ws.once === 'function') {
      ws.once('close', onDisconnect);
      ws.once('error', onDisconnect);
    } else if (typeof ws.on === 'function') {
      ws.on('close', onDisconnect);
      ws.on('error', onDisconnect);
    }
    this.socketOffs.set(ws, detach);
  }

  /** True while at least one collaboration participant is attached to a session. */
  hasParticipants(sessionId: string): boolean {
    return this.registry.hasParticipants(sessionId);
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
    this.scheduler.stop();
    // Detach close/error listeners from still-live sockets before clearing
    // the set: otherwise each socket retains this disposed handler closure
    // (and its bus references) until the socket itself closes.
    for (const detach of this.socketOffs.values()) detach();
    this.socketOffs.clear();
    this.registry.clear();
  }

  // ── Inbound client messages ────────────────────────────────────────────

  /**
   * Dispatch a parsed client message. Returns true when the message was
   * recognized and handled; false when the caller should ignore / log so
   * the upstream router can dispatch non-collab messages.
   */
  handleMessage(ws: WebSocket, msg: CollabInboundMessage): boolean {
    return this.dispatcher.dispatch(this.ctx, ws, msg);
  }

  // ── CollabContext plumbing (transport-owned) ───────────────────────────

  private makeContext(): CollabContext {
    return {
      registry: this.registry,
      scheduler: this.scheduler,
      logger: this.logger,
      reader: this.reader,
      annotations: this.annotations,
      bus: this.bus,
      options: this.options,
      send: (ws, msg) => this.send(ws, msg),
      broadcast: (sessionId, msg) => this.broadcast(sessionId, msg),
      broadcastState: (sessionId) => this.broadcastState(sessionId),
      stateMessage: (sessionId) => this.registry.stateMessage(sessionId),
      errorMessage: (detail) => this.errorMessage(detail),
      detachSocket: (ws) => this.detachSocket(ws),
      removeSocket: (ws) => this.removeSocket(ws),
    };
  }

  /**
   * Shared `collab.leave` / WS close-error path. Order matters:
   *   1. Remove from the client set and detach tracked listeners.
   *   2. Send `participant.left` to the leaving ws, then delete from bucket.
   *   3. Broadcast the fresh state to remaining observers.
   *   4. Stop the interval once nobody can be broadcast to.
   */
  private removeSocket(ws: WebSocket): void {
    this.registry.clients.delete(ws);
    // Invoke the remover, not just drop it: an explicit `collab.leave` keeps
    // the socket open, so its close/error listeners must come off now —
    // otherwise they stack on re-add and dispose() can no longer find them.
    this.detachSocket(ws);
    for (const removal of this.registry.removeBySocket(ws)) {
      const leftEvent: WSServerMessage = {
        type: 'collab.participant.left',
        payload: {
          participantId: removal.participant.participantId,
          sessionId: removal.sessionId,
        },
      };
      // Send directly to the leaving ws first so they get an immediate
      // confirmation, then broadcast to the rest of the bucket.
      this.send(ws, leftEvent);
      if (removal.sessionEmptied) {
        this.scheduler.forget(removal.sessionId);
      } else {
        this.broadcast(removal.sessionId, leftEvent);
        this.broadcastState(removal.sessionId);
      }
    }
    // Stop once there is nothing left to broadcast to — either no session
    // has participants or no socket remains attached at all. Without the
    // second condition an attached observer that never joined kept this
    // interval alive forever.
    if (!this.registry.hasAnyParticipants() || this.registry.clients.size === 0) {
      this.scheduler.stop();
    }
  }

  private detachSocket(ws: WebSocket): void {
    this.socketOffs.get(ws)?.();
  }

  /** Broadcast the current state for a session and record the fingerprint. */
  private broadcastState(sessionId: string): void {
    this.broadcast(sessionId, this.registry.stateMessage(sessionId));
    this.scheduler.record(sessionId);
  }

  private broadcast(sessionId: string, msg: WSServerMessage): void {
    const data = JSON.stringify(msg);
    const bucket = this.registry.participantIterator(sessionId);
    if (!bucket) return;
    for (const p of bucket) {
      try {
        sendSerialized(p.ws, data);
      } catch (err) {
        this.logger.debug?.(`collab broadcast failed: ${toErrorMessage(err)}`);
      }
    }
  }

  private send(ws: WebSocket, msg: WSServerMessage): void {
    try {
      sendSerialized(ws, JSON.stringify(msg));
    } catch {
      /* client gone */
    }
  }

  private errorMessage(detail: string): WSServerMessage {
    return { type: 'error', payload: { phase: 'collab', message: detail } };
  }
}
