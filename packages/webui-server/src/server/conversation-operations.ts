import type { Agent } from '@wrongstack/core/agent';
import type { ContentBlock } from '@wrongstack/core/types';
import {
  buildUserContentBlocks,
  IncomingImageError,
  type IncomingImagePayload,
  parseIncomingImages,
} from '@wrongstack/core/utils';
import {
  createToolVisionAdapters,
  ImageInputUnsupportedError,
  routeImagesForModel,
  VisionUrlBlockedError,
} from '@wrongstack/runtime/vision';
import type { WebSocket } from 'ws';
import type { ConversationRouteHandlers } from './conversation-routes.js';
import type { ConfirmDecision, PendingConfirm } from './pending-confirms.js';
import type { WSClientMessage } from './types.js';
import { errMessage } from './ws-utils.js';

type OutboundMessage = { type: string; payload: unknown };

export interface ConversationRunControl {
  /** Return a controller when acquired, or undefined when this host is busy. */
  begin(ws: WebSocket): AbortController | undefined;
  end(ws: WebSocket, controller: AbortController): void;
  abort(ws: WebSocket): void;
}

export interface ConversationOperationsContext {
  getAgent: () => Agent;
  getSessionId: () => string;
  runControl: ConversationRunControl;
  pendingConfirms: Map<string, PendingConfirm>;
  send: (ws: WebSocket, message: OutboundMessage) => void;
  notifyAbort: (ws: WebSocket, message: OutboundMessage) => void;
  getMaxIterations?: () => number | undefined;
  busyPhase?: string;
  busyMessage?: string;
}

function requestedSessionId(msg: WSClientMessage): string | undefined {
  const payload = msg.payload;
  return payload &&
    typeof payload === 'object' &&
    typeof (payload as { sessionId?: unknown }).sessionId === 'string'
    ? (payload as { sessionId: string }).sessionId
    : undefined;
}

export function createConversationOperations(
  ctx: ConversationOperationsContext,
): ConversationRouteHandlers {
  const sessionPayload = (payload: Record<string, unknown>): Record<string, unknown> => {
    const provided = payload['sessionId'];
    const sessionId =
      typeof provided === 'string' && provided.length > 0 ? provided : ctx.getSessionId();
    return sessionId ? { ...payload, sessionId } : payload;
  };
  const ensureCurrentSession = (ws: WebSocket, msg: WSClientMessage, phase: string): boolean => {
    const requested = requestedSessionId(msg);
    const current = ctx.getSessionId();
    if (!requested || !current || requested === current) return true;
    ctx.send(ws, {
      type: 'error',
      payload: sessionPayload({
        phase,
        message: `Request targeted session ${requested}, but this WebUI runtime is currently on ${current}.`,
        requestedSessionId: requested,
      }),
    });
    return false;
  };

  return {
    userMessage: async (ws, msg) => {
      if (!ensureCurrentSession(ws, msg, 'user_message')) return;
      const payload = (msg.payload ?? {}) as {
        content?: unknown;
        images?: IncomingImagePayload[] | undefined;
        imageBase64?: string | undefined;
      };
      const controller = ctx.runControl.begin(ws);
      if (!controller) {
        ctx.send(ws, {
          type: 'error',
          payload: sessionPayload({
            phase: ctx.busyPhase ?? 'user_message',
            message:
              ctx.busyMessage ??
              'Agent is already processing a request. Wait for the current run to finish.',
          }),
        });
        return;
      }

      // Pin the session this run was started in. The host can swap the
      // active session (session.new/resume) while a slow provider stream
      // is still in flight; stamping run.result with the live session id
      // at completion time would leak the previous request's final text
      // into the freshly-opened session's chat. Declared before the try so
      // the catch branches can stamp it too.
      const originSessionId = ctx.getSessionId();
      try {
        const agent = ctx.getAgent();
        const content = typeof payload.content === 'string' ? payload.content : '';
        let input: string | ContentBlock[] = content;
        const imageBlocks = parseIncomingImages(payload.images, payload.imageBase64);
        if (imageBlocks.length > 0) {
          const routed = await routeImagesForModel(buildUserContentBlocks(content, imageBlocks), {
            supportsVision: agent.ctx.provider.capabilities.vision,
            adapters: () => createToolVisionAdapters(agent.tools),
            ctx: agent.ctx,
            signal: controller.signal,
            providerId: agent.ctx.provider.id,
            model: agent.ctx.model,
          });
          input = routed.blocks;
        }
        const maxIterations = ctx.getMaxIterations?.();
        const runResult = await agent.run(input, {
          signal: controller.signal,
          ...(maxIterations !== undefined ? { maxIterations } : {}),
        });
        ctx.send(ws, {
          type: 'run.result',
          payload: sessionPayload({
            sessionId: originSessionId,
            status: runResult.status,
            iterations: runResult.iterations,
            finalText: runResult.finalText,
            error: runResult.error
              ? {
                  code: runResult.error.code,
                  message: runResult.error.message,
                  recoverable: runResult.error.recoverable,
                }
              : undefined,
          }),
        });
      } catch (error) {
        if (
          error instanceof IncomingImageError ||
          error instanceof ImageInputUnsupportedError ||
          error instanceof VisionUrlBlockedError
        ) {
          ctx.send(ws, {
            type: 'error',
            payload: sessionPayload({
              sessionId: originSessionId,
              phase: 'user_message',
              ...(error instanceof ImageInputUnsupportedError
                ? { code: 'vision_unsupported' }
                : {}),
              message: error.message,
            }),
          });
        } else {
          ctx.send(ws, {
            type: 'error',
            payload: sessionPayload({
              sessionId: originSessionId,
              phase: 'agent.run',
              message: errMessage(error),
            }),
          });
        }
      } finally {
        ctx.runControl.end(ws, controller);
      }
    },
    abort: (ws, msg) => {
      if (!ensureCurrentSession(ws, msg, 'abort')) return;
      ctx.runControl.abort(ws);
      ctx.notifyAbort(ws, {
        type: 'error',
        payload: sessionPayload({ phase: 'abort', message: 'User aborted' }),
      });
    },
    ping: (ws) => ctx.send(ws, { type: 'pong', payload: {} }),
    confirmTool: (_ws, msg) => {
      const requested = requestedSessionId(msg);
      const current = ctx.getSessionId();
      if (requested && current && requested !== current) return;
      const { id, decision } = (msg.payload ?? {}) as {
        id?: unknown;
        decision?: unknown;
      };
      if (typeof id !== 'string') return;
      const confirm = ctx.pendingConfirms.get(id);
      if (!confirm) return;
      ctx.pendingConfirms.delete(id);
      confirm.resolve(decision as ConfirmDecision);
    },
  };
}
