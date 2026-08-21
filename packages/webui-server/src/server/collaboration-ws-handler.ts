import { randomUUID } from 'node:crypto';
import type { CollaborationBus, ConsumedInjectionInfo } from '@wrongstack/core/coordination';
import type { EventBus } from '@wrongstack/core/kernel';
import type { AnnotationsStore, SessionReader } from '@wrongstack/core/storage';
import type { Logger } from '@wrongstack/core/types';
import { toErrorMessage } from '@wrongstack/core/utils';
import type { WebSocket } from 'ws';
import type { CollabRole, WSCollabState, WSServerMessage } from './types.js';
import { sendSerialized } from './ws-utils.js';

/** How many historical events to replay to a late-joining observer. */
const REPLAY_LIMIT = 50;

/** How long the middleware waits before auto-resuming (mirrors the middleware default). */
const PAUSE_TIMEOUT_MS = 60_000;

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
        requestedRole: Exclude<CollabRole, 'observer'>;
      }) => boolean)
    | undefined;
}

/**
 * CollaborationWebSocketHandler — session-scoped collaboration transport.
 * Mirrors `WorktreeWebSocketHandler` and `GoalWebSocketHandler`.
 *
 * Capabilities in this phase:
 *   - A second human (or any client) joins an active agent run as an
 *     `observer` and receives a live mirror of the kernel's iteration /
 *     tool / subagent events.
 *   - The observer declares a `sessionId` on join. Hosts provide the live
 *     runtime session id so replay and EventBus routing stay session-scoped.
 *   - The observer can leave at any time; cleanup runs on WS close/error.
 *   - Privileged roles are never accepted from the wire by themselves.
 *     The host must explicitly authorize annotator/controller grants.
 *
 * Protocol additions (see `packages/webui/src/types.ts`):
 *   client → server:  collab.join { sessionId, role: 'observer' }
 *                     collab.leave { sessionId }
 *   server → client:  collab.state          (initial + 2s periodic)
 *                     collab.participant.joined
 *                     collab.participant.left
 *                     collab.event          (live kernel event mirror)
 */
export class CollaborationWebSocketHandler {
  private readonly clients = new Set<WebSocket>();
  /** sessionId → participants currently watching it. */
  private readonly bySession = new Map<string, Set<Participant>>();
  private broadcastInterval: ReturnType<typeof setInterval> | null = null;
  /**
   * Last-broadcast participant-set fingerprint per session. The 2s interval
   * only re-sends `collab.state` when the fingerprint changed (join/leave),
   * so an idle session costs one tiny string build per tick instead of a
   * serialize + fan-out.
   */
  private readonly lastStateFingerprints = new Map<string, string>();
  private readonly offs: Array<() => void> = [];
  /** Per-socket disconnect removers so dispose() can detach still-live sockets. */
  private readonly socketOffs = new Map<WebSocket, () => void>();

  constructor(
    private readonly events: EventBus,
    private readonly logger: Logger,
    /**
     * Optional reader over the on-disk session log. When provided, late
     * joiners receive the last `REPLAY_LIMIT` events of the joined
     * session before live mirroring begins. Without a reader, joining
     * is still allowed — the observer simply starts from "now" with no
     * historical context.
     */
    private readonly reader?: SessionReader | undefined,
    /**
     * Optional sidecar store for collaboration annotations. Required
     * for the `annotator` role — without it, `collab.annotate` messages
     * are rejected with an error.
     */
    private readonly annotations?: AnnotationsStore | undefined,
    /**
     * Optional kernel-level pause/resume bus. Required for the
     * `controller` role — without it, `collab.request_pause` is rejected
     * with an error. Wired to the agent's `toolCall` pipeline via
     * `collabPauseMiddleware` in the webui server boot.
     */
    private readonly bus?: CollaborationBus | undefined,
    private readonly options: CollaborationHandlerOptions = {},
  ) {
    this.subscribe();
    // Phase 4 feedback loop: when the inject middleware applies a queued
    // injection, broadcast a `consumed` grant so observers see it landed.
    // Store the disposer in this.offs so dispose() removes the callback,
    // preventing the handler closure from keeping this instance alive
    // via the bus reference after teardown.
    const offInjection = this.bus?.onInjectionConsumed((info) =>
      this.broadcastInjectionConsumed(info),
    );
    if (offInjection) this.offs.push(offInjection);
  }

  // ── Public API (called by server/index.ts per WS connection) ───────────

  addClient(ws: WebSocket): void {
    if (this.clients.has(ws)) return;
    this.clients.add(ws);
    this.ensureBroadcast();
    const onDisconnect = () => this.handleDisconnect(ws);
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
    return (this.bySession.get(sessionId)?.size ?? 0) > 0;
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
    this.stopBroadcast();
    // Detach close/error listeners from still-live sockets before clearing
    // the set: otherwise each socket retains this disposed handler closure
    // (and its bus references) until the socket itself closes.
    for (const detach of this.socketOffs.values()) detach();
    this.socketOffs.clear();
    this.clients.clear();
    this.bySession.clear();
  }

  // ── Inbound client messages ────────────────────────────────────────────

  /**
   * Dispatch a parsed client message. Returns true when the message was
   * recognized and handled; false when the caller should ignore / log.
   * Phase 1 only knows `collab.join` and `collab.leave`; unknown types
   * return false so the upstream router can decide.
   */
  handleMessage(ws: WebSocket, msg: { type: string; payload?: unknown | undefined }): boolean {
    if (msg.type === 'collab.join') {
      const payload = msg.payload as
        | { sessionId?: string | undefined; role?: CollabRole | undefined }
        | undefined;
      if (typeof payload?.sessionId !== 'string' || payload.sessionId.trim().length === 0) {
        this.send(ws, this.errorMessage('collab.join requires sessionId'));
        return true;
      }
      const role = payload.role ?? 'observer';
      if (role !== 'observer' && role !== 'annotator' && role !== 'controller') {
        this.send(ws, this.errorMessage(`unknown collaboration role '${String(role)}'`));
        return true;
      }
      this.join(ws, payload.sessionId, role);
      return true;
    }
    if (msg.type === 'collab.leave') {
      this.leave(ws);
      return true;
    }
    if (msg.type === 'collab.annotate') {
      void this.handleAnnotate(ws, msg.payload);
      return true;
    }
    if (msg.type === 'collab.resolve') {
      void this.handleResolve(ws, msg.payload);
      return true;
    }
    if (msg.type === 'collab.request_pause') {
      void this.handleRequestPause(ws, msg.payload);
      return true;
    }
    if (msg.type === 'collab.resume') {
      void this.handleResume(ws, msg.payload);
      return true;
    }
    if (msg.type === 'collab.grant_control') {
      void this.handleGrantControl(ws, msg.payload);
      return true;
    }
    if (msg.type === 'collab.inject_tool') {
      void this.handleInjectTool(ws, msg.payload);
      return true;
    }
    return false;
  }

  // ── Join / leave flow ──────────────────────────────────────────────────

  private join(ws: WebSocket, sessionId: string, role: CollabRole): void {
    const activeSessionId = this.options.getActiveSessionId?.();
    if (activeSessionId !== undefined && sessionId !== activeSessionId) {
      this.send(
        ws,
        this.errorMessage(`collab.join sessionId mismatch (active: ${activeSessionId})`),
      );
      return;
    }
    if (this.findParticipant(ws)) {
      this.send(ws, this.errorMessage('collab.join requires leaving the current session first'));
      return;
    }
    if (role === 'controller' && !this.bus) {
      this.send(
        ws,
        this.errorMessage(`role 'controller' is not available: server has no CollaborationBus`),
      );
      return;
    }
    if (role === 'annotator' && !this.annotations) {
      this.send(
        ws,
        this.errorMessage(`role 'annotator' is not available: server has no annotations store`),
      );
      return;
    }
    if (
      role !== 'observer' &&
      this.options.authorizeRole?.({ ws, sessionId, requestedRole: role }) !== true
    ) {
      this.send(ws, this.errorMessage(`role '${role}' requires explicit server authorization`));
      return;
    }
    const participant: Participant = {
      participantId: randomUUID(),
      ws,
      sessionId,
      role,
      joinedAt: new Date().toISOString(),
    };
    let bucket = this.bySession.get(sessionId);
    if (!bucket) {
      bucket = new Set();
      this.bySession.set(sessionId, bucket);
    }
    bucket.add(participant);

    // Per-participant hello: send the current state snapshot immediately
    // so the new observer knows who else is watching. Then broadcast the
    // join event AND a fresh state to every participant (including the
    // newcomer) so existing observers see the updated count without
    // waiting for the 2s timer.
    this.send(ws, this.stateMessage(sessionId));
    this.broadcast(sessionId, {
      type: 'collab.participant.joined',
      payload: {
        participantId: participant.participantId,
        sessionId,
        role,
        joinedAt: participant.joinedAt,
      },
    });
    this.broadcastState(sessionId);

    // Replay last N events to give the late joiner historical context.
    // Best-effort: failures are logged and silently ignored — the live
    // mirror continues regardless.
    if (this.reader) {
      this.replayHistory(ws, sessionId).catch((err) => {
        this.logger.debug?.(`collab: replay failed for ${sessionId}: ${toErrorMessage(err)}`);
      });
    }
    this.logger.debug?.(`collab: participant ${participant.participantId} joined ${sessionId}`);
  }

  private leave(ws: WebSocket): void {
    this.handleDisconnect(ws);
  }

  private handleDisconnect(ws: WebSocket): void {
    this.clients.delete(ws);
    // Invoke the remover, not just drop it: an explicit `collab.leave` keeps
    // the socket open, so its close/error listeners must come off now —
    // otherwise they stack on re-add and dispose() can no longer find them.
    this.socketOffs.get(ws)?.();
    // Remove from every session bucket the WS may have joined (a single
    // WS is in at most one bucket in Phase 1, but the loop is cheap and
    // future-proofs multi-session observers).
    //
    // Order matters:
    //   1. Send `participant.left` to the leaving ws so they get a
    //      confirmation that their leave registered.
    //   2. Delete from bucket.
    //   3. Broadcast the fresh state to remaining observers so they
    //      see the updated count without waiting for the 2s timer.
    for (const [sessionId, bucket] of this.bySession) {
      for (const p of bucket) {
        if (p.ws === ws) {
          const leftEvent = {
            type: 'collab.participant.left' as const,
            payload: { participantId: p.participantId, sessionId },
          };
          // Send directly to the leaving ws first so they get an
          // immediate confirmation, then broadcast to the rest of the
          // bucket (which is still inclusive of the leaving ws here —
          // the per-iteration below strips it out).
          this.send(ws, leftEvent);
          bucket.delete(p);
          if (bucket.size === 0) {
            this.bySession.delete(sessionId);
            this.lastStateFingerprints.delete(sessionId);
          } else {
            this.broadcast(sessionId, leftEvent);
            this.broadcastState(sessionId);
          }
          break;
        }
      }
    }
    // Stop once there is nothing left to broadcast to — either no session
    // has participants or no socket remains attached at all. Without the
    // second condition an attached observer that never joined kept this
    // interval alive forever.
    if (this.bySession.size === 0 || this.clients.size === 0) this.stopBroadcast();
  }

  // ── Annotation flow (Phase 2) ───────────────────────────────────────────

  /**
   * Look up the participant record for a given WS across all sessions.
   * Returns null when the WS hasn't joined (e.g. the client sent a
   * `collab.annotate` before `collab.join`).
   */
  private findParticipant(ws: WebSocket): Participant | null {
    for (const bucket of this.bySession.values()) {
      for (const p of bucket) {
        if (p.ws === ws) return p;
      }
    }
    return null;
  }

  private findParticipantById(sessionId: string, participantId: string): Participant | null {
    const bucket = this.bySession.get(sessionId);
    if (!bucket) return null;
    for (const p of bucket) {
      if (p.participantId === participantId) return p;
    }
    return null;
  }

  private async handleAnnotate(ws: WebSocket, raw: unknown): Promise<void> {
    if (!this.annotations) {
      this.send(ws, this.errorMessage('annotations store is not configured'));
      return;
    }
    const participant = this.findParticipant(ws);
    if (!participant) {
      this.send(ws, this.errorMessage('annotate requires an active join'));
      return;
    }
    if (participant.role !== 'annotator') {
      this.send(
        ws,
        this.errorMessage(
          `annotate requires the 'annotator' role (current: '${participant.role}')`,
        ),
      );
      return;
    }
    const payload = raw as
      | {
          sessionId?: string | undefined;
          atEventIndex?: number | undefined;
          text?: string | undefined;
        }
      | undefined;
    if (
      !payload?.sessionId ||
      typeof payload.atEventIndex !== 'number' ||
      typeof payload.text !== 'string'
    ) {
      this.send(ws, this.errorMessage('annotate requires { sessionId, atEventIndex, text }'));
      return;
    }
    if (payload.sessionId !== participant.sessionId) {
      this.send(
        ws,
        this.errorMessage(`annotate sessionId mismatch (joined: ${participant.sessionId})`),
      );
      return;
    }
    try {
      const annotation = await this.annotations.add({
        sessionId: payload.sessionId,
        atEventIndex: payload.atEventIndex,
        authorId: participant.participantId,
        text: payload.text,
      });
      this.broadcast(payload.sessionId, {
        type: 'collab.annotation.added',
        payload: {
          sessionId: payload.sessionId,
          annotation: {
            id: annotation.id,
            atEventIndex: annotation.atEventIndex,
            authorId: annotation.authorId,
            authorRole: annotation.authorRole,
            text: annotation.text,
            createdAt: annotation.createdAt,
            resolved: annotation.resolved,
          },
        },
      });
    } catch (err) {
      this.send(ws, this.errorMessage(`annotation rejected: ${toErrorMessage(err)}`));
    }
  }

  private async handleResolve(ws: WebSocket, raw: unknown): Promise<void> {
    if (!this.annotations) {
      this.send(ws, this.errorMessage('annotations store is not configured'));
      return;
    }
    const participant = this.findParticipant(ws);
    if (!participant) {
      this.send(ws, this.errorMessage('resolve requires an active join'));
      return;
    }
    if (participant.role !== 'annotator') {
      this.send(
        ws,
        this.errorMessage(`resolve requires the 'annotator' role (current: '${participant.role}')`),
      );
      return;
    }
    const payload = raw as
      | { sessionId?: string | undefined; annotationId?: string | undefined }
      | undefined;
    if (!payload?.sessionId || !payload.annotationId) {
      this.send(ws, this.errorMessage('resolve requires { sessionId, annotationId }'));
      return;
    }
    if (payload.sessionId !== participant.sessionId) {
      this.send(
        ws,
        this.errorMessage(`resolve sessionId mismatch (joined: ${participant.sessionId})`),
      );
      return;
    }
    try {
      const updated = await this.annotations.resolve({
        sessionId: payload.sessionId,
        annotationId: payload.annotationId,
        resolvedBy: participant.participantId,
      });
      if (!updated) {
        this.send(ws, this.errorMessage(`annotation not found: ${payload.annotationId}`));
        return;
      }
      this.broadcast(payload.sessionId, {
        type: 'collab.annotation.resolved',
        payload: {
          sessionId: payload.sessionId,
          annotationId: updated.id,
          resolvedBy: updated.resolvedBy ?? participant.participantId,
          resolvedAt: updated.resolvedAt ?? new Date().toISOString(),
        },
      });
    } catch (err) {
      this.send(ws, this.errorMessage(`resolve failed: ${toErrorMessage(err)}`));
    }
  }

  // ── Event subscription (live mirror) ───────────────────────────────────

  private subscribe(): void {
    // Same trick as WorktreeWebSocketHandler: bind a single typed-on helper
    // to a string-keyed signature so we can register many handlers.
    const on = this.events.on.bind(this.events) as never as (
      ev: string,
      fn: (p: unknown) => void,
    ) => () => void;

    // Mirror every event an observer would care about. Each is forwarded
    // to all joined participants as a generic `collab.event` envelope so
    // the client can render a flowing activity strip. Filtering /
    // denormalization happens on the client.
    const forwarded: Array<[string, string]> = [
      ['iteration.started', 'iteration.started'],
      ['iteration.completed', 'iteration.completed'],
      ['tool.started', 'tool.started'],
      ['tool.progress', 'tool.progress'],
      ['tool.executed', 'tool.executed'],
      ['tool.confirm_needed', 'tool.confirm_needed'],
      ['subagent.spawned', 'subagent.spawned'],
      ['subagent.task_started', 'subagent.task_started'],
      ['subagent.iteration_summary', 'subagent.iteration_summary'],
      ['subagent.task_completed', 'subagent.task_completed'],
      ['subagent.done', 'subagent.done'],
    ];
    for (const [kernelEvent, kind] of forwarded) {
      this.offs.push(
        on(kernelEvent, (raw) => {
          // Bail before the clone when nobody is watching. This list includes
          // `tool.progress` and `subagent.iteration_summary` — per-delta hot
          // paths — and the deep clone below used to run on every kernel event
          // even with zero observers connected, because the only no-op guard
          // lived inside broadcastEvent().
          if (this.bySession.size === 0) return;
          // Best-effort payload shape: we don't deeply validate, but we
          // make sure it's serializable. Observers must never receive
          // non-serializable objects (Functions, circular refs).
          let payload: unknown = raw;
          try {
            payload = JSON.parse(JSON.stringify(raw));
          } catch {
            // Skip unserializable payloads — better to drop than to crash
            // the broadcast loop.
            return;
          }
          this.broadcastEvent(kind, payload);
        }),
      );
    }
  }

  private broadcastEvent(kind: string, payload: unknown): void {
    if (this.bySession.size === 0) return; // nobody watching — no-op
    const msg: WSServerMessage = {
      type: 'collab.event',
      payload: { kind, payload, at: new Date().toISOString() },
    };
    const activeSessionId = this.options.getActiveSessionId?.();
    if (activeSessionId !== undefined) {
      this.broadcast(activeSessionId, msg);
      return;
    }
    for (const sessionId of this.bySession.keys()) {
      this.broadcast(sessionId, msg);
    }
  }

  /**
   * Replay the last `REPLAY_LIMIT` events from the on-disk session log
   * to a single observer (the late joiner). Each event is forwarded as
   * a `collab.event` with `replay: true` so the client can distinguish
   * history from the live stream.
   *
   * The session log stores typed `SessionEvent`s (`user_input`,
   * `llm_response`, `tool_result`, etc.) — different from the kernel's
   * bus events. We translate the most useful subset (`tool.*` and
   * `iteration.*`-shaped ones) into the same `kind` namespace the live
   * mirror uses, so the client can render a single activity strip.
   */
  private async replayHistory(ws: WebSocket, sessionId: string): Promise<void> {
    if (!this.reader) return;
    // Keep only the trailing REPLAY_LIMIT events in a ring instead of
    // materializing the whole session log. `reader.replay` is already an async
    // iterator; buffering all of it just to `slice(-50)` meant a late joiner
    // pulled an entire (unbounded) session history into memory first.
    const ring: unknown[] = new Array(REPLAY_LIMIT);
    let seen = 0;
    try {
      for await (const ev of this.reader.replay(sessionId)) {
        ring[seen % REPLAY_LIMIT] = ev;
        seen++;
      }
    } catch (err) {
      this.logger.debug?.(`collab: session reader rejected ${sessionId}: ${toErrorMessage(err)}`);
      return;
    }
    const tail =
      seen <= REPLAY_LIMIT
        ? ring.slice(0, seen)
        : // Unwrap the ring back into chronological order.
          [...ring.slice(seen % REPLAY_LIMIT), ...ring.slice(0, seen % REPLAY_LIMIT)];
    if (tail.length === 0) return; // nothing to replay
    for (const raw of tail) {
      const ev = raw as {
        type?: string | undefined;
        ts?: string | undefined;
        [k: string]: unknown;
      };
      const kind = this.historyEventToKind(ev);
      if (!kind) continue; // skip events we don't know how to mirror
      this.send(ws, {
        type: 'collab.event',
        payload: {
          kind,
          payload: ev,
          at: ev.ts ?? new Date().toISOString(),
          replay: true,
        },
      });
    }
  }

  /**
   * Map a stored `SessionEvent` to a `collab.event.kind` so the live
   * strip and the history strip can share a single rendering path.
   * Returns null for events that don't have a meaningful live analog
   * (e.g. `session_start`, file-snapshot bookkeeping, rewind markers).
   */
  private historyEventToKind(ev: { type?: string | undefined }): string | null {
    switch (ev.type) {
      case 'user_input':
        return 'user_input';
      case 'llm_response':
        return 'llm_response';
      case 'tool_result':
        return 'tool.executed';
      case 'compaction':
        return 'compaction';
      case 'error':
        return 'error';
      default:
        return null;
    }
  }

  // ── State snapshot + periodic broadcast ────────────────────────────────

  private stateMessage(sessionId: string): WSCollabState {
    const bucket = this.bySession.get(sessionId);
    return {
      type: 'collab.state',
      payload: {
        sessionId,
        participants: bucket
          ? [...bucket].map((p) => ({
              participantId: p.participantId,
              role: p.role,
              joinedAt: p.joinedAt,
            }))
          : [],
      },
    };
  }

  /**
   * Cheap participant-set identity: participant ids are unique per join and
   * `joinedAt` distinguishes a rejoin, so the fingerprint changes exactly on
   * join/leave — the only events that alter `collab.state`.
   */
  private stateFingerprint(sessionId: string): string {
    const bucket = this.bySession.get(sessionId);
    if (!bucket || bucket.size === 0) return '';
    return [...bucket].map((p) => `${p.participantId}:${p.joinedAt}`).join('|');
  }

  /**
   * Broadcast the current state for a session and record the fingerprint.
   * Used on join/leave (eager broadcast) and by the periodic interval.
   */
  private broadcastState(sessionId: string): void {
    this.broadcast(sessionId, this.stateMessage(sessionId));
    this.lastStateFingerprints.set(sessionId, this.stateFingerprint(sessionId));
  }

  private ensureBroadcast(): void {
    if (this.broadcastInterval) return;
    this.broadcastInterval = setInterval(() => {
      for (const sessionId of this.bySession.keys()) {
        const fingerprint = this.stateFingerprint(sessionId);
        if (fingerprint === this.lastStateFingerprints.get(sessionId)) continue;
        this.broadcastState(sessionId);
      }
    }, 2000);
    this.broadcastInterval.unref?.();
  }

  private stopBroadcast(): void {
    if (this.broadcastInterval) {
      clearInterval(this.broadcastInterval);
      this.broadcastInterval = null;
    }
    this.lastStateFingerprints.clear();
  }

  private broadcast(sessionId: string, msg: WSServerMessage): void {
    const data = JSON.stringify(msg);
    const bucket = this.bySession.get(sessionId);
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

  // ── Controller flow (Phase 3) ───────────────────────────────────────────

  private async handleRequestPause(ws: WebSocket, raw: unknown): Promise<void> {
    if (!this.bus) {
      this.send(ws, this.errorMessage('pause requires a CollaborationBus'));
      return;
    }
    const participant = this.findParticipant(ws);
    if (!participant) {
      this.send(ws, this.errorMessage('pause requires an active join'));
      return;
    }
    if (participant.role !== 'controller') {
      this.send(
        ws,
        this.errorMessage(`pause requires the 'controller' role (current: '${participant.role}')`),
      );
      return;
    }
    const payload = raw as { sessionId?: string | undefined } | undefined;
    if (!payload?.sessionId || payload.sessionId !== participant.sessionId) {
      this.send(ws, this.errorMessage('pause sessionId mismatch'));
      return;
    }
    const transitioned = this.bus.requestPause(participant.participantId);
    if (!transitioned) {
      // Already paused — surface the current state to the requester.
      const s = this.bus.getState();
      this.send(ws, {
        type: 'error',
        payload: {
          phase: 'collab',
          message: `bus already paused by ${s.pausedBy ?? '?'} at ${s.pausedAt ?? '?'}`,
        },
      });
      return;
    }
    const s = this.bus.getState();
    this.broadcast(payload.sessionId, {
      type: 'collab.pause.granted',
      payload: {
        sessionId: payload.sessionId,
        pausedBy: s.pausedBy ?? participant.participantId,
        pausedAt: s.pausedAt ?? new Date().toISOString(),
        autoResumeInMs: PAUSE_TIMEOUT_MS,
      },
    });
  }

  private async handleResume(ws: WebSocket, raw: unknown): Promise<void> {
    if (!this.bus) {
      this.send(ws, this.errorMessage('resume requires a CollaborationBus'));
      return;
    }
    const participant = this.findParticipant(ws);
    if (!participant) {
      this.send(ws, this.errorMessage('resume requires an active join'));
      return;
    }
    // Permission: controller OR the original pauser. We do a simple
    // "any controller can release" check — fine for Phase 3, can be
    // tightened to "only the pauser" later.
    if (participant.role !== 'controller') {
      this.send(
        ws,
        this.errorMessage(`resume requires the 'controller' role (current: '${participant.role}')`),
      );
      return;
    }
    const payload = raw as { sessionId?: string | undefined } | undefined;
    if (!payload?.sessionId || payload.sessionId !== participant.sessionId) {
      this.send(ws, this.errorMessage('resume sessionId mismatch'));
      return;
    }
    const transitioned = this.bus.resume();
    if (!transitioned) {
      this.send(ws, this.errorMessage('bus is not currently paused'));
      return;
    }
    this.broadcast(payload.sessionId, {
      type: 'collab.pause.released',
      payload: {
        sessionId: payload.sessionId,
        reason: 'controller',
        at: new Date().toISOString(),
      },
    });
  }

  private async handleGrantControl(ws: WebSocket, raw: unknown): Promise<void> {
    // Promote a target participant to `controller` so the pause/resume and
    // inject_tool checks (which gate on role === 'controller') accept it. Only
    // a current controller may grant; the granter itself already passed the
    // bus requirement when it joined as controller, so no extra bus check is
    // needed here. The new roster is broadcast so every client reflects it.
    const participant = this.findParticipant(ws);
    if (!participant) {
      this.send(ws, this.errorMessage('grant_control requires an active join'));
      return;
    }
    if (participant.role !== 'controller') {
      this.send(
        ws,
        this.errorMessage(
          `grant_control requires the 'controller' role (current: '${participant.role}')`,
        ),
      );
      return;
    }
    const payload = raw as
      | { sessionId?: string | undefined; toParticipant?: string | undefined }
      | undefined;
    if (
      !payload?.sessionId ||
      !payload.toParticipant ||
      payload.sessionId !== participant.sessionId
    ) {
      this.send(ws, this.errorMessage('grant_control requires { sessionId, toParticipant }'));
      return;
    }
    const target = this.findParticipantById(payload.sessionId, payload.toParticipant);
    if (!target) {
      this.send(
        ws,
        this.errorMessage(
          `grant_control: no participant '${payload.toParticipant}' in this session`,
        ),
      );
      return;
    }
    target.role = 'controller';
    this.logger.debug?.(
      `collab: control granted from ${participant.participantId} to ${target.participantId} in ${payload.sessionId}`,
    );
    this.broadcast(payload.sessionId, this.stateMessage(payload.sessionId));
  }

  /**
   * Phase 4 — handle a controller's manual tool-call injection.
   * Validates the payload, queues it on the bus, and broadcasts
   * the grant so observers see what just happened. The actual
   * splice into the agent's pipeline is performed by the
   * `collabInjectMiddleware` on the next tool call.
   */
  private async handleInjectTool(ws: WebSocket, raw: unknown): Promise<void> {
    if (!this.bus) {
      this.send(ws, this.errorMessage('inject_tool requires a CollaborationBus'));
      return;
    }
    const participant = this.findParticipant(ws);
    if (!participant) {
      this.send(ws, this.errorMessage('inject_tool requires an active join'));
      return;
    }
    if (participant.role !== 'controller') {
      this.send(
        ws,
        this.errorMessage(
          `inject_tool requires the 'controller' role (current: '${participant.role}')`,
        ),
      );
      return;
    }
    const payload = raw as
      | {
          sessionId?: string | undefined;
          toolUseId?: string | undefined;
          content?: unknown | undefined;
          isError?: boolean | undefined;
          reason?: string | undefined;
        }
      | undefined;
    if (
      !payload?.sessionId ||
      !payload.toolUseId ||
      typeof payload.isError !== 'boolean' ||
      typeof payload.reason !== 'string' ||
      payload.content === undefined
    ) {
      this.send(
        ws,
        this.errorMessage(
          'inject_tool requires { sessionId, toolUseId, content, isError, reason }',
        ),
      );
      return;
    }
    if (payload.sessionId !== participant.sessionId) {
      this.send(
        ws,
        this.errorMessage(`inject_tool sessionId mismatch (joined: ${participant.sessionId})`),
      );
      return;
    }
    const queued = this.bus.injectToolResult({
      toolUseId: payload.toolUseId,
      content: payload.content,
      isError: payload.isError,
      reason: payload.reason,
      authorId: participant.participantId,
    });
    if (!queued) {
      this.send(
        ws,
        this.errorMessage(`an injection for toolUseId ${payload.toolUseId} is already queued`),
      );
      return;
    }
    this.broadcast(payload.sessionId, {
      type: 'collab.injection.granted',
      payload: {
        sessionId: payload.sessionId,
        toolUseId: payload.toolUseId,
        // The tool name is unknown here (the injection is queued
        // before the model produces the tool call). We surface a
        // placeholder; the middleware will emit a `consumed` event
        // with the real name on match.
        toolName: '(pending match)',
        authorId: participant.participantId,
        reason: payload.reason,
        isError: payload.isError,
        phase: 'queued',
        at: new Date().toISOString(),
      },
    });
  }

  /**
   * Bus callback: a queued injection was spliced into a real tool call. Re-emit
   * `collab.injection.granted` with phase `'consumed'` and the now-known tool
   * name. The injection carries no sessionId, so resolve it from the author's
   * current participant. If the author has left, fail closed rather than leak
   * the payload to unrelated sessions.
   */
  private broadcastInjectionConsumed(info: ConsumedInjectionInfo): void {
    let sessionId: string | null = null;
    for (const [sid, bucket] of this.bySession) {
      for (const p of bucket) {
        if (p.participantId === info.authorId) {
          sessionId = sid;
          break;
        }
      }
      if (sessionId) break;
    }
    const message = (sid: string): WSServerMessage => ({
      type: 'collab.injection.granted',
      payload: {
        sessionId: sid,
        toolUseId: info.toolUseId,
        toolName: info.toolName,
        authorId: info.authorId,
        reason: info.reason,
        isError: info.isError,
        phase: 'consumed',
        at: new Date().toISOString(),
      },
    });
    if (sessionId) {
      this.broadcast(sessionId, message(sessionId));
    } else {
      this.logger.debug?.(
        `collab: consumed injection ${info.toolUseId} has no live author; broadcast suppressed`,
      );
    }
  }
}

interface Participant {
  participantId: string;
  ws: WebSocket;
  sessionId: string;
  role: CollabRole;
  joinedAt: string;
}
