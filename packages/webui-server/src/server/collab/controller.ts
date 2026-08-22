import type { WebSocket } from 'ws';
import type { WSServerMessage } from '../types.js';
import type { CollabContext } from './collab-context.js';
import { requireJoinedRole } from './collab-context.js';
import type { CollabFeature } from './dispatcher.js';

/** How long the middleware waits before auto-resuming (mirrors the middleware default). */
export const PAUSE_TIMEOUT_MS = 60_000;

/**
 * Controller flow, Phase 3 (6A-2). Moved verbatim from
 * CollaborationWebSocketHandler: pause/resume/grant_control guards and
 * broadcast payloads, including the "already paused" state surface.
 */
export class RequestPauseFeature implements CollabFeature {
  readonly type = 'collab.request_pause';

  async handle(ctx: CollabContext, ws: WebSocket, raw: unknown): Promise<void> {
    if (!ctx.bus) {
      ctx.send(ws, ctx.errorMessage('pause requires a CollaborationBus'));
      return;
    }
    const participant = requireJoinedRole(ctx, ws, 'pause', 'controller');
    if (!participant) return;
    const payload = raw as { sessionId?: string | undefined } | undefined;
    if (!payload?.sessionId || payload.sessionId !== participant.sessionId) {
      ctx.send(ws, ctx.errorMessage('pause sessionId mismatch'));
      return;
    }
    const transitioned = ctx.bus.requestPause(participant.participantId);
    if (!transitioned) {
      // Already paused — surface the current state to the requester.
      const s = ctx.bus.getState();
      ctx.send(ws, {
        type: 'error',
        payload: {
          phase: 'collab',
          message: `bus already paused by ${s.pausedBy ?? '?'} at ${s.pausedAt ?? '?'}`,
        },
      });
      return;
    }
    const s = ctx.bus.getState();
    ctx.broadcast(payload.sessionId, {
      type: 'collab.pause.granted',
      payload: {
        sessionId: payload.sessionId,
        pausedBy: s.pausedBy ?? participant.participantId,
        pausedAt: s.pausedAt ?? new Date().toISOString(),
        autoResumeInMs: PAUSE_TIMEOUT_MS,
      },
    });
  }
}

export class ResumeFeature implements CollabFeature {
  readonly type = 'collab.resume';

  async handle(ctx: CollabContext, ws: WebSocket, raw: unknown): Promise<void> {
    if (!ctx.bus) {
      ctx.send(ws, ctx.errorMessage('resume requires a CollaborationBus'));
      return;
    }
    const participant = requireJoinedRole(ctx, ws, 'resume', 'controller');
    if (!participant) return;
    const payload = raw as { sessionId?: string | undefined } | undefined;
    if (!payload?.sessionId || payload.sessionId !== participant.sessionId) {
      ctx.send(ws, ctx.errorMessage('resume sessionId mismatch'));
      return;
    }
    const transitioned = ctx.bus.resume();
    if (!transitioned) {
      ctx.send(ws, ctx.errorMessage('bus is not currently paused'));
      return;
    }
    ctx.broadcast(payload.sessionId, {
      type: 'collab.pause.released',
      payload: {
        sessionId: payload.sessionId,
        reason: 'controller',
        at: new Date().toISOString(),
      },
    });
  }
}

export class GrantControlFeature implements CollabFeature {
  readonly type = 'collab.grant_control';

  async handle(ctx: CollabContext, ws: WebSocket, raw: unknown): Promise<void> {
    // Promote a target participant to `controller` so the pause/resume and
    // inject_tool checks (which gate on role === 'controller') accept it. Only
    // a current controller may grant; the granter itself already passed the
    // bus requirement when it joined as controller, so no extra bus check is
    // needed here. The new roster is broadcast so every client reflects it.
    const participant = requireJoinedRole(ctx, ws, 'grant_control', 'controller');
    if (!participant) return;
    const payload = raw as
      | { sessionId?: string | undefined; toParticipant?: string | undefined }
      | undefined;
    if (
      !payload?.sessionId ||
      !payload.toParticipant ||
      payload.sessionId !== participant.sessionId
    ) {
      ctx.send(ws, ctx.errorMessage('grant_control requires { sessionId, toParticipant }'));
      return;
    }
    const target = ctx.registry.findParticipantById(payload.sessionId, payload.toParticipant);
    if (!target) {
      ctx.send(
        ws,
        ctx.errorMessage(
          `grant_control: no participant '${payload.toParticipant}' in this session`,
        ),
      );
      return;
    }
    target.role = 'controller';
    ctx.logger.debug?.(
      `collab: control granted from ${participant.participantId} to ${target.participantId} in ${payload.sessionId}`,
    );
    ctx.broadcast(payload.sessionId, ctx.stateMessage(payload.sessionId));
  }
}

export type { WSServerMessage };
