import type { ConsumedInjectionInfo } from '@wrongstack/core/coordination';
import type { WebSocket } from 'ws';
import type { WSServerMessage } from '../types.js';
import type { CollabContext } from './collab-context.js';
import { requireJoinedRole } from './collab-context.js';
import type { CollabFeature } from './dispatcher.js';

/**
 * Phase 4 — controller's manual tool-call injection (6A-2). Moved verbatim
 * from CollaborationWebSocketHandler: the 5-field payload gate, the
 * queued-duplicate rejection, and the `'(pending match)'` placeholder the
 * middleware later replaces on the `consumed` event.
 */
export class InjectToolFeature implements CollabFeature {
  readonly type = 'collab.inject_tool';

  async handle(ctx: CollabContext, ws: WebSocket, raw: unknown): Promise<void> {
    if (!ctx.bus) {
      ctx.send(ws, ctx.errorMessage('inject_tool requires a CollaborationBus'));
      return;
    }
    const participant = requireJoinedRole(ctx, ws, 'inject_tool', 'controller');
    if (!participant) return;
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
      ctx.send(
        ws,
        ctx.errorMessage('inject_tool requires { sessionId, toolUseId, content, isError, reason }'),
      );
      return;
    }
    if (payload.sessionId !== participant.sessionId) {
      ctx.send(
        ws,
        ctx.errorMessage(`inject_tool sessionId mismatch (joined: ${participant.sessionId})`),
      );
      return;
    }
    const queued = ctx.bus.injectToolResult({
      toolUseId: payload.toolUseId,
      content: payload.content,
      isError: payload.isError,
      reason: payload.reason,
      authorId: participant.participantId,
    });
    if (!queued) {
      ctx.send(
        ws,
        ctx.errorMessage(`an injection for toolUseId ${payload.toolUseId} is already queued`),
      );
      return;
    }
    ctx.broadcast(payload.sessionId, {
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
}

/**
 * Bus callback: a queued injection was spliced into a real tool call. Re-emit
 * `collab.injection.granted` with phase `'consumed'` and the now-known tool
 * name. The injection carries no sessionId, so resolve it from the author's
 * current participant. If the author has left, fail closed rather than leak
 * the payload to unrelated sessions.
 *
 * Memory-pinned regression: the injection-listener cleanup coverage relies on
 * this callback being registered via the handler-owned `offs` disposer.
 */
export function broadcastInjectionConsumed(ctx: CollabContext, info: ConsumedInjectionInfo): void {
  const sessionId = ctx.registry.sessionIdOfParticipant(info.authorId);
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
    ctx.broadcast(sessionId, message(sessionId));
  } else {
    ctx.logger.debug?.(
      `collab: consumed injection ${info.toolUseId} has no live author; broadcast suppressed`,
    );
  }
}
