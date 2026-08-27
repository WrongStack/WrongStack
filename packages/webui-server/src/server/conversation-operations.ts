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
  /**
   * The iteration ceiling for ONE session.
   *
   * `maxIterations` is a per-tab preference (it sits on the session's own
   * context meta, like autonomy and yolo), so reading it off the shared root
   * context handed every tab whichever value the runtime's current session
   * happened to hold — a run in tab 3 capped by a number the user set in tab 1.
   */
  getMaxIterations?: (sessionId?: string) => number | undefined;
  /**
   * Serialiser shared with the session handlers. Run setup is wrapped in it so
   * a turn can never start on a context that a concurrent session.new /
   * session.resume is halfway through re-pointing. Defaults to running the
   * callback directly when the host does not wire one.
   */
  withSessionTransition?: (<T>(operation: () => Promise<T>) => Promise<T>) | undefined;
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
      const requested =
        typeof payload.sessionId === 'string' && payload.sessionId ? payload.sessionId : undefined;
      const originSessionId = requested ?? ctx.getSessionId();
      const requestId = typeof payload.id === 'string' ? payload.id : undefined;

      // Session setup (fresh-topic reset, image routing) reads and mutates the
      // target agent's context, so it must not interleave with a session
      // transition that is re-pointing contexts underneath it. The run itself
      // is deliberately started OUTSIDE the gate: holding it for a whole turn
      // would serialise the four tabs into one.
      const gate: <T>(fn: () => Promise<T>) => Promise<T> =
        ctx.withSessionTransition ?? (<T>(fn: () => Promise<T>) => fn());

      // Claiming the run lock and preparing the turn both happen INSIDE the
      // transition gate: the busy check, `getAgent(originSessionId)` and the
      // fresh-topic reset all read runtime state that a concurrent
      // session.new / session.resume is in the middle of re-pointing.
      //
      // `agent.run()` is deliberately started OUTSIDE the gate — holding it
      // for a whole turn would serialise the four tabs back into one.
      let controller: AbortController | undefined;
      // Set when the turn was refused for a reason that already answered the
      // client, so the generic "already processing" reply below stays quiet.
      let refusedWithReason = false;
      try {
        const prepared = await gate(async () => {
          const claimed = ctx.runControl.begin(ws, originSessionId);
          if (!claimed) return null;
          controller = claimed;
          const agent = ctx.getAgent(originSessionId);
          // A per-tab agent is born with a PLACEHOLDER writer; the real one is
          // installed by the session transition that owns the id. Running
          // against the placeholder fails deep inside the turn with an opaque
          // "append is not a function" after tokens have already been spent,
          // so say plainly what is missing instead. The client answers a
          // `session_not_ready` by resuming that tab and sending again.
          // Narrow on purpose: a session object that exists but cannot append
          // is the placeholder. A missing one means the host keeps the writer
          // somewhere else entirely, which is not this bug.
          const writer = agent.ctx.session as { append?: unknown } | null | undefined;
          if (writer && typeof writer.append !== 'function') {
            ctx.runControl.end(ws, originSessionId, claimed);
            controller = undefined;
            refusedWithReason = true;
            ctx.send(ws, {
              type: 'error',
              payload: sessionPayload({
                sessionId: originSessionId,
                phase: 'user_message',
                code: 'session_not_ready',
                message: `Session ${originSessionId} is not open in this runtime yet. Resume it and send again.`,
              }),
            });
            return null;
          }
          if (payload.freshContext === true) await startFreshTopicContext(agent.ctx);
          const content = typeof payload.content === 'string' ? payload.content : '';
          let input: string | ContentBlock[] = content;
          const imageBlocks = parseIncomingImages(payload.images, payload.imageBase64);
          if (imageBlocks.length > 0) {
            const routed = await routeImagesForModel(buildUserContentBlocks(content, imageBlocks), {
              supportsVision: agent.ctx.provider.capabilities.vision,
              adapters: () => createToolVisionAdapters(agent.tools),
              ctx: agent.ctx,
              signal: claimed.signal,
              providerId: agent.ctx.provider.id,
              model: agent.ctx.model,
            });
            input = routed.blocks;
          }
          return { agent, input, signal: claimed.signal };
        });
        if (!prepared) {
          if (refusedWithReason) return;
          ctx.send(ws, {
            type: 'error',
            payload: sessionPayload({
              // Stamped with the session that was refused. Falling back to the
              // runtime's current session sent the "already processing" error
              // to whichever tab was in front instead of the busy one.
              sessionId: originSessionId,
              phase: ctx.busyPhase ?? 'user_message',
              message:
                ctx.busyMessage ??
                'Agent is already processing a request. Wait for the current run to finish.',
            }),
          });
          return;
        }
        const { agent, input } = prepared;
        const maxIterations = ctx.getMaxIterations?.(originSessionId);
        const runResult = await agent.run(input, {
          signal: prepared.signal,
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
        // Undefined only when the lock was never claimed (busy session) —
        // releasing then would hand another tab's controller back.
        if (controller) ctx.runControl.end(ws, originSessionId, controller);
      }
    },
    abort: (ws, msg) => {
      if (!ensureCurrentSession(ws, msg, 'abort')) return;
      const sessionId = requestedSessionId(msg) ?? ctx.getSessionId();
      ctx.runControl.abort(ws, sessionId);
      ctx.notifyAbort(ws, {
        type: 'error',
        payload: sessionPayload({ sessionId, phase: 'abort', message: 'User aborted' }),
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
