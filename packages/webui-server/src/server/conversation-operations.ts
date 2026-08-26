import type { Agent } from '@wrongstack/core/agent';
import { startFreshTopicContext, TopicShiftAdvisor } from '@wrongstack/core/execution';
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
  /**
   * Acquire a run controller for the given session.
   * Return a controller when acquired, or undefined when this host is busy.
   */
  begin(ws: WebSocket, sessionId: string): AbortController | undefined;
  /** Release the controller for the given session after the run completes. */
  end(ws: WebSocket, sessionId: string, controller: AbortController): void;
  /** Abort only the run belonging to `sessionId`, leaving other sessions intact. */
  abort(ws: WebSocket, sessionId: string): void;
}

export interface ConversationOperationsContext {
  getAgent: (sessionId?: string) => Agent;
  getSessionId: () => string;
  hasSession?: ((id: string) => boolean) | undefined;
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
  const topicShiftAdvisor = new TopicShiftAdvisor();
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
    if (ctx.hasSession?.(requested)) return true;
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
    topicAdvice: async (ws, msg) => {
      if (!ensureCurrentSession(ws, msg, 'topic.advice')) return;
      const payload = (msg.payload ?? {}) as { requestId?: unknown; prompt?: unknown };
      if (typeof payload.requestId !== 'string' || typeof payload.prompt !== 'string') {
        ctx.send(ws, {
          type: 'topic.advice_result',
          payload: sessionPayload({
            requestId: typeof payload.requestId === 'string' ? payload.requestId : '',
            suggestNewContext: false,
            confidence: 0,
            reason: 'Invalid topic advice request.',
            source: 'local',
          }),
        });
        return;
      }
      const agent = ctx.getAgent();
      const configuredMax = agent.ctx.meta['effectiveMaxContext'];
      const maxContext =
        typeof configuredMax === 'number'
          ? configuredMax
          : agent.ctx.provider.capabilities.maxContext;
      const advice = await topicShiftAdvisor.advise({
        prompt: payload.prompt,
        messages: agent.ctx.messages,
        provider: agent.ctx.provider,
        model: agent.ctx.model,
        contextTokens: agent.ctx.lastRequestTokens,
        maxContext,
      });
      ctx.send(ws, {
        type: 'topic.advice_result',
        payload: sessionPayload({ requestId: payload.requestId, ...advice }),
      });
    },
    userMessage: async (ws, msg) => {
      if (!ensureCurrentSession(ws, msg, 'user_message')) return;
      const payload = (msg.payload ?? {}) as {
        id?: unknown;
        content?: unknown;
        freshContext?: unknown;
        sessionId?: unknown;
        images?: IncomingImagePayload[] | undefined;
        imageBase64?: string | undefined;
      };
      const requested = typeof payload.sessionId === 'string' && payload.sessionId ? payload.sessionId : undefined;
      const originSessionId = requested ?? ctx.getSessionId();
      const requestId = typeof payload.id === 'string' ? payload.id : undefined;
      const controller = ctx.runControl.begin(ws, originSessionId);
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

      // originSessionId was captured before begin() so both the run and
      // every catch branch stamp the result with the session the user
      // started in — not whatever session is live when the run unwinds.
      try {
        const agent = ctx.getAgent(originSessionId);
        if (payload.freshContext === true) await startFreshTopicContext(agent.ctx);
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
            requestId,
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
        ctx.runControl.end(ws, originSessionId, controller);
      }
    },
    abort: (ws, msg) => {
      if (!ensureCurrentSession(ws, msg, 'abort')) return;
      const sessionId = requestedSessionId(msg) ?? ctx.getSessionId();
      ctx.runControl.abort(ws, sessionId);
      ctx.notifyAbort(ws, {
        type: 'error',
        payload: sessionPayload({ phase: 'abort', message: 'User aborted' }),
      });
    },
    ping: (ws) => ctx.send(ws, { type: 'pong', payload: {} }),
    confirmTool: (_ws, msg) => {
      const { id, decision } = (msg.payload ?? {}) as {
        id?: unknown;
        decision?: unknown;
      };
      if (typeof id !== 'string') return;
      const confirm = ctx.pendingConfirms.get(id);
      if (!confirm) return;

      // Ownership is checked against the session recorded on the confirm when
      // it was created, not against whatever the client sent. The previous
      // check was `if (requested && current && requested !== current) return`,
      // which skipped entirely when the client omitted `sessionId` — so
      // omitting the field was enough to answer another session's prompt
      // (WS-082). Falling back to the server's current session means a client
      // that sends nothing is judged against the session it is actually on.
      const claimedSession = requestedSessionId(msg) ?? ctx.getSessionId();
      if (confirm.sessionId !== undefined && confirm.sessionId !== claimedSession) return;

      ctx.pendingConfirms.delete(id);
      confirm.resolve(decision as ConfirmDecision);
    },
  };
}
