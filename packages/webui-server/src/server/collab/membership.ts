import { randomUUID } from 'node:crypto';
import { toErrorMessage } from '@wrongstack/core/utils';
import type { WebSocket } from 'ws';
import type { CollabContext } from './collab-context.js';
import type { CollabFeature } from './dispatcher.js';
import { replayHistory } from './replay.js';
import type { Participant } from './session-registry.js';

/**
 * Join/leave flow (6A-2). Moved verbatim from CollaborationWebSocketHandler:
 * the join validation chain (active-session pin → no-double-join →
 * role-store/bus availability → fail-closed authorizeRole) and the ordered
 * leave choreography are behavior-critical; the 34-test suite pins them.
 */
export class MembershipFeature implements CollabFeature {
  readonly type = 'collab.join';

  handle(ctx: CollabContext, ws: WebSocket, raw: unknown): void {
    this.join(ctx, ws, raw);
  }

  private join(ctx: CollabContext, ws: WebSocket, raw: unknown): void {
    const payload = raw as
      | { sessionId?: string | undefined; role?: Participant['role'] | undefined }
      | undefined;
    if (typeof payload?.sessionId !== 'string' || payload.sessionId.trim().length === 0) {
      ctx.send(ws, ctx.errorMessage('collab.join requires sessionId'));
      return;
    }
    const role = payload.role ?? 'observer';
    if (role !== 'observer' && role !== 'annotator' && role !== 'controller') {
      ctx.send(ws, ctx.errorMessage(`unknown collaboration role '${String(role)}'`));
      return;
    }
    const sessionId = payload.sessionId;

    const activeSessionId = ctx.options.getActiveSessionId?.();
    if (activeSessionId !== undefined && sessionId !== activeSessionId) {
      ctx.send(ws, ctx.errorMessage(`collab.join sessionId mismatch (active: ${activeSessionId})`));
      return;
    }
    if (ctx.registry.findParticipant(ws)) {
      ctx.send(ws, ctx.errorMessage('collab.join requires leaving the current session first'));
      return;
    }
    if (role === 'controller' && !ctx.bus) {
      ctx.send(
        ws,
        ctx.errorMessage(`role 'controller' is not available: server has no CollaborationBus`),
      );
      return;
    }
    if (role === 'annotator' && !ctx.annotations) {
      ctx.send(
        ws,
        ctx.errorMessage(`role 'annotator' is not available: server has no annotations store`),
      );
      return;
    }
    if (
      role !== 'observer' &&
      ctx.options.authorizeRole?.({ ws, sessionId, requestedRole: role }) !== true
    ) {
      ctx.send(ws, ctx.errorMessage(`role '${role}' requires explicit server authorization`));
      return;
    }
    const participant: Participant = {
      participantId: randomUUID(),
      ws,
      sessionId,
      role,
      joinedAt: new Date().toISOString(),
    };
    ctx.registry.addParticipant(participant);

    // Per-participant hello: send the current state snapshot immediately
    // so the new observer knows who else is watching. Then broadcast the
    // join event AND a fresh state to every participant (including the
    // newcomer) so existing observers see the updated count without
    // waiting for the 2s timer.
    ctx.send(ws, ctx.stateMessage(sessionId));
    ctx.broadcast(sessionId, {
      type: 'collab.participant.joined',
      payload: {
        participantId: participant.participantId,
        sessionId,
        role,
        joinedAt: participant.joinedAt,
      },
    });
    ctx.broadcastState(sessionId);

    // Replay last N events to give the late joiner historical context.
    // Best-effort: failures are logged and silently ignored — the live
    // mirror continues regardless.
    if (ctx.reader) {
      replayHistory(ctx, ws, sessionId).catch((err) => {
        ctx.logger.debug?.(`collab: replay failed for ${sessionId}: ${toErrorMessage(err)}`);
      });
    }
    ctx.logger.debug?.(`collab: participant ${participant.participantId} joined ${sessionId}`);
  }
}

/** `collab.leave` — identical semantics to a WS close (memory-pinned by tests). */
export class LeaveFeature implements CollabFeature {
  readonly type = 'collab.leave';

  handle(ctx: CollabContext, ws: WebSocket): void {
    ctx.removeSocket(ws);
  }
}
