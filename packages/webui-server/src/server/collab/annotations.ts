import { toErrorMessage } from '@wrongstack/core/utils';
import type { WebSocket } from 'ws';
import type { CollabContext } from './collab-context.js';
import { requireJoinedRole } from './collab-context.js';
import type { CollabFeature } from './dispatcher.js';

/**
 * Annotation flow, Phase 2 (6A-2). Moved verbatim from
 * CollaborationWebSocketHandler: store-availability guard, annotator role
 * gate, payload validation, session pinning, and the broadcast payloads.
 *
 * Deliberate invariant: neither flow calls scheduler.record(). The periodic
 * 2s collab.state tick only re-sends when the participant-set fingerprint
 * changes (join/leave), and annotations do not alter that set — so a record()
 * here would write back the identical fingerprint and change nothing.
 * Annotation payloads are event-stream messages delivered by the direct
 * broadcast plus the replay ring buffer, not collab.state. Do not "fix" this
 * asymmetry without first widening what stateFingerprint covers.
 */
export class AnnotateFeature implements CollabFeature {
  readonly type = 'collab.annotate';

  async handle(ctx: CollabContext, ws: WebSocket, raw: unknown): Promise<void> {
    if (!ctx.annotations) {
      ctx.send(ws, ctx.errorMessage('annotations store is not configured'));
      return;
    }
    const participant = requireJoinedRole(ctx, ws, 'annotate', 'annotator');
    if (!participant) return;
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
      ctx.send(ws, ctx.errorMessage('annotate requires { sessionId, atEventIndex, text }'));
      return;
    }
    if (payload.sessionId !== participant.sessionId) {
      ctx.send(
        ws,
        ctx.errorMessage(`annotate sessionId mismatch (joined: ${participant.sessionId})`),
      );
      return;
    }
    try {
      const annotation = await ctx.annotations.add({
        sessionId: payload.sessionId,
        atEventIndex: payload.atEventIndex,
        authorId: participant.participantId,
        text: payload.text,
      });
      ctx.broadcast(payload.sessionId, {
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
      ctx.send(ws, ctx.errorMessage(`annotation rejected: ${toErrorMessage(err)}`));
    }
  }
}

/** `collab.resolve` — resolves an annotation and broadcasts the update. */
export class ResolveFeature implements CollabFeature {
  readonly type = 'collab.resolve';

  async handle(ctx: CollabContext, ws: WebSocket, raw: unknown): Promise<void> {
    if (!ctx.annotations) {
      ctx.send(ws, ctx.errorMessage('annotations store is not configured'));
      return;
    }
    const participant = requireJoinedRole(ctx, ws, 'resolve', 'annotator');
    if (!participant) return;
    const payload = raw as
      | { sessionId?: string | undefined; annotationId?: string | undefined }
      | undefined;
    if (!payload?.sessionId || !payload.annotationId) {
      ctx.send(ws, ctx.errorMessage('resolve requires { sessionId, annotationId }'));
      return;
    }
    if (payload.sessionId !== participant.sessionId) {
      ctx.send(
        ws,
        ctx.errorMessage(`resolve sessionId mismatch (joined: ${participant.sessionId})`),
      );
      return;
    }
    try {
      const updated = await ctx.annotations.resolve({
        sessionId: payload.sessionId,
        annotationId: payload.annotationId,
        resolvedBy: participant.participantId,
      });
      if (!updated) {
        ctx.send(ws, ctx.errorMessage(`annotation not found: ${payload.annotationId}`));
        return;
      }
      ctx.broadcast(payload.sessionId, {
        type: 'collab.annotation.resolved',
        payload: {
          sessionId: payload.sessionId,
          annotationId: updated.id,
          resolvedBy: updated.resolvedBy ?? participant.participantId,
          resolvedAt: updated.resolvedAt ?? new Date().toISOString(),
        },
      });
    } catch (err) {
      ctx.send(ws, ctx.errorMessage(`resolve failed: ${toErrorMessage(err)}`));
    }
  }
}
