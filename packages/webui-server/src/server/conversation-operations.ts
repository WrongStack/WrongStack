import type { ContentBlock, UserInputResponse } from '@wrongstack/contracts/types';
import type { Agent } from '@wrongstack/core/agent';
import { startFreshTopicContext, TopicShiftAdvisor } from '@wrongstack/core/execution';
import { typeSafeJudgeFromContainer } from '@wrongstack/core/typesafe';
import {
  buildUserContentBlocks,
  IncomingImageError,
  type IncomingImagePayload,
  parseIncomingAttachments,
} from '@wrongstack/core/utils';
import {
  createToolVisionAdapters,
  ImageInputUnsupportedError,
  routeImagesForModel,
  VisionUrlBlockedError,
} from '@wrongstack/runtime/vision';
import type { WebSocket } from 'ws';
import type { ConversationRouteHandlers } from './conversation-routes.js';
import { pdfPromptBlocks } from './incoming-documents.js';
import type { ConfirmDecision, PendingConfirm } from './pending-confirms.js';
import {
  createSessionPromptQueue,
  handlePromptQueueMessage,
  promptQueueDirFor,
  type SessionPromptQueue,
} from './session-prompt-queue.js';
import type { WSClientMessage } from './types.js';
import { errMessage } from './ws-utils.js';

type OutboundMessage = { type: string; payload: unknown };

/**
 * Who started a turn: a user message, the runtime (background-delegation
 * auto-wake), or a prompt the user queued earlier that the host drained.
 */
export type ConversationTurnOrigin = 'user' | 'runtime' | 'queue';

interface TurnPayload {
  id?: unknown;
  content?: unknown;
  freshContext?: unknown;
  images?: IncomingImagePayload[] | undefined;
  imageBase64?: string | undefined;
  /** The turn's content, already built (a queued prompt); replaces `content` and `images`. */
  blocks?: ContentBlock[] | undefined;
}

export interface ConversationRunControl {
  /**
   * Acquire a run controller for the given session.
   * Return a controller when acquired, or undefined when this host is busy.
   * `ws` is undefined for a runtime turn, which no socket asked for.
   */
  begin(ws: WebSocket | undefined, sessionId: string): AbortController | undefined;
  /** Release the controller for the given session after the run completes. */
  end(ws: WebSocket | undefined, sessionId: string, controller: AbortController): void;
  /** Abort only the run belonging to `sessionId`, leaving other sessions intact. */
  abort(ws: WebSocket, sessionId: string): void;
}

export interface ConversationOperationsContext {
  getAgent: (sessionId?: string) => Agent;
  getSessionId: () => string;
  hasSession?: ((id: string) => boolean) | undefined;
  runControl: ConversationRunControl;
  pendingConfirms: Map<string, PendingConfirm>;
  submitUserInput: (sessionId: string, response: UserInputResponse) => void;
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
  /**
   * Session-scoped broadcast. Used by runtime turns: they have no socket to
   * answer, so their `run.result` / errors go to every page showing the
   * session. Without it a runtime turn still runs, but reports nothing.
   */
  broadcast?: ((message: OutboundMessage) => void) | undefined;
  /**
   * A user message for `sessionId` arrived. May return a release, called once
   * its turn claimed (or was refused) the run lock — the window in which the
   * submit counts as pending user input to the auto-wake guard.
   */
  onUserMessage?: ((sessionId: string) => (() => void) | undefined) | undefined;
  /**
   * A turn that actually ran has ended and released its lock. `aborted` is
   * true when its controller was aborted (user Stop, shutdown).
   */
  onRunEnded?:
    | ((sessionId: string, info: { aborted: boolean; origin: ConversationTurnOrigin }) => void)
    | undefined;
  /**
   * The project's sessions directory: a queued prompt is persisted in its
   * session's folder, where the TUI keeps its queue too. Omitted: the queue
   * still works but lives only as long as this host.
   */
  promptQueueSessionsDir?: string | undefined;
}

export interface ConversationOperations extends ConversationRouteHandlers {
  /**
   * Start a runtime-origin turn with `prompt` through the same path a user
   * message takes. Resolves once setup finished: `true` when the run started,
   * `false` when the session was busy, not ready, or setup failed. The run
   * itself continues after the promise resolves.
   */
  startRuntimeTurn(sessionId: string, prompt: string): Promise<boolean>;
  /** The host-owned queue of prompts waiting for each session's run to end. */
  readonly promptQueue: SessionPromptQueue;
}

/**
 * Read the session a client message targets. Empty-string counts as "no
 * session": the server stamps `sessionId: ''` when its context has none, and
 * that must never be treated as a real target id (an empty target would
 * otherwise sail through `?? current` fallbacks and produce broadcasts every
 * client drops).
 */
function requestedSessionId(msg: WSClientMessage): string | undefined {
  const payload = msg.payload;
  return payload &&
    typeof payload === 'object' &&
    typeof (payload as { sessionId?: unknown }).sessionId === 'string' &&
    (payload as { sessionId: string }).sessionId.length > 0
    ? (payload as { sessionId: string }).sessionId
    : undefined;
}

export function createConversationOperations(
  ctx: ConversationOperationsContext,
): ConversationOperations {
  const topicShiftAdvisor = new TopicShiftAdvisor({
    getJudge: () => typeSafeJudgeFromContainer(ctx.getAgent().container, 'topicShift'),
  });
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

  /** Sessions whose turn holds the run lock right now (turns started here). */
  const activeTurns = new Set<string>();

  /**
   * The ONE turn path. A user message and a runtime turn (background
   * delegation auto-wake) both go through it, so the run lock, the session
   * transition gate, the placeholder-writer refusal, the iteration ceiling and
   * the `run.result` envelope cannot drift between them. The differences: a
   * runtime turn has no socket (replies are broadcast to its session), its
   * refusals are silent, and it reaches `onRunEnded` with `origin: 'runtime'`.
   */
  const runTurn = async (turn: {
    ws: WebSocket | undefined;
    originSessionId: string;
    payload: TurnPayload;
    origin: ConversationTurnOrigin;
    /** Setup finished: the lock was claimed and the run starts (`true`), or not (`false`). */
    onSettled?: ((started: boolean) => void) | undefined;
  }): Promise<void> => {
    const { ws, originSessionId, payload, origin } = turn;
    const requestId = typeof payload.id === 'string' ? payload.id : undefined;
    const reply = (message: OutboundMessage): void => {
      if (ws) ctx.send(ws, message);
      else ctx.broadcast?.(message);
    };
    let settled = false;
    const settle = (started: boolean): void => {
      if (settled) return;
      settled = true;
      try {
        turn.onSettled?.(started);
      } catch {
        // Host bookkeeping must never break a turn.
      }
    };

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
    // Set once `agent.run` was entered: a refused or failed setup is not a
    // finished run and must not trigger post-run checks.
    let ran = false;
    // Set when the turn was refused for a reason that already answered the
    // client, so the generic "already processing" reply below stays quiet.
    let refusedWithReason = false;
    try {
      const prepared = await gate(async () => {
        const claimed = ctx.runControl.begin(ws, originSessionId);
        if (!claimed) return null;
        controller = claimed;
        activeTurns.add(originSessionId);
        const agent = ctx.getAgent(originSessionId);
        // A per-tab agent is born with a PLACEHOLDER writer; the real one is
        // installed by the session transition that owns the id. Running
        // against the placeholder fails deep inside the turn with an opaque
        // "append is not a function" after tokens have already been spent,
        // so say plainly what is missing instead. The client answers a
        // `session_not_ready` by resuming that tab and resending the echo
        // below once the session's `session.start` announces it live (see
        // ws-client armNotReadyResend). The echo is the contract: the retry
        // replays EXACTLY what was refused without reaching back into
        // client lane state. Narrow on purpose: a session object that
        // exists but cannot append is the placeholder. A missing one means
        // the host keeps the writer somewhere else entirely, which is not
        // this bug.
        const writer = agent.ctx.session as { append?: unknown } | null | undefined;
        if (writer && typeof writer.append !== 'function') {
          ctx.runControl.end(ws, originSessionId, claimed);
          activeTurns.delete(originSessionId);
          controller = undefined;
          refusedWithReason = true;
          // A runtime turn has no composer to resend from: echoing its
          // prompt would make the client replay `[AUTO-WAKE]` as user input.
          if (origin === 'user') {
            reply({
              type: 'error',
              payload: sessionPayload({
                sessionId: originSessionId,
                phase: 'user_message',
                code: 'session_not_ready',
                message: `Session ${originSessionId} is not open in this runtime yet. Resume it and send again.`,
                ...(typeof payload.content === 'string' && payload.content
                  ? { content: payload.content }
                  : {}),
                ...(payload.freshContext === true ? { freshContext: true } : {}),
                ...(payload.images ? { images: payload.images } : {}),
              }),
            });
          }
          return null;
        }
        if (payload.freshContext === true) await startFreshTopicContext(agent.ctx);
        const content = typeof payload.content === 'string' ? payload.content : '';
        let input: string | ContentBlock[] = content;
        const attached = payload.blocks
          ? { images: [], pdfs: [] }
          : parseIncomingAttachments(payload.images, payload.imageBase64);
        // PDFs lead, then images, then the text; the provider runner decides
        // per model whether a PDF travels as the file or as its text.
        const blocks = payload.blocks ?? [
          ...(await pdfPromptBlocks(attached.pdfs)),
          ...buildUserContentBlocks(content, attached.images),
        ];
        if (attached.pdfs.length > 0 || payload.blocks) input = blocks;
        if (blocks.some((block) => block.type === 'image')) {
          const routed = await routeImagesForModel(blocks, {
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
        settle(false);
        if (refusedWithReason) return;
        // A runtime turn that lost the lock to a user turn is not an error
        // anyone should see: the running loop drains the results itself.
        if (origin !== 'user') return;
        reply({
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
      settle(true);
      const { agent, input } = prepared;
      // The ceiling is a preference, not a correctness input: a throwing host
      // callback must degrade to the default (no ceiling) rather than skip
      // `ran = true` — an unset ran would skip onRunEnded in the finally
      // below, leaving the auto-wake host's turn bookkeeping dangling so its
      // scheduler re-enters the same prompt.
      let maxIterations: number | undefined;
      try {
        maxIterations = ctx.getMaxIterations?.(originSessionId);
      } catch {
        maxIterations = undefined;
      }
      ran = true;
      const runResult = await agent.run(input, {
        signal: prepared.signal,
        inputOrigin: origin === 'user' ? 'user' : 'runtime',
        ...(maxIterations !== undefined ? { maxIterations } : {}),
      });
      // The result goes to the session, not to the socket that asked. That
      // socket may have dropped while the run went on: its page reconnects
      // on a new socket, and a result sent to the old one was lost, together
      // with the answer's final state. Broadcast, it is numbered into the
      // session's frame log (a reconnect catches it up) and reaches every
      // page showing the session.
      const announce = ctx.broadcast ?? reply;
      announce({
        type: 'run.result',
        payload: sessionPayload({
          sessionId: originSessionId,
          requestId,
          status: runResult.status,
          iterations: runResult.iterations,
          finalText: runResult.finalText,
          ...(origin === 'runtime' ? { origin: 'auto_wake' } : {}),
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
      settle(false);
      if (
        error instanceof IncomingImageError ||
        error instanceof ImageInputUnsupportedError ||
        error instanceof VisionUrlBlockedError
      ) {
        reply({
          type: 'error',
          payload: sessionPayload({
            sessionId: originSessionId,
            phase: 'user_message',
            ...(error instanceof ImageInputUnsupportedError ? { code: 'vision_unsupported' } : {}),
            message: error.message,
          }),
        });
      } else {
        reply({
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
      if (controller) {
        const aborted = controller.signal.aborted;
        ctx.runControl.end(ws, originSessionId, controller);
        activeTurns.delete(originSessionId);
        if (ran) {
          try {
            ctx.onRunEnded?.(originSessionId, { aborted, origin });
          } catch {
            // Post-run bookkeeping must never surface instead of the result.
          }
          // Next queued prompt, after every ended turn — Stop included, as
          // the browser-held queue always did.
          void promptQueue.drain(originSessionId);
        }
      }
      settle(false);
    }
  };

  const promptQueue = createSessionPromptQueue({
    sessionsDir: ctx.promptQueueSessionsDir,
    legacyDir: promptQueueDirFor(ctx.promptQueueSessionsDir),
    isBusy: (sessionId) => activeTurns.has(sessionId),
    // A drained prompt is user input the user already sent: it counts as
    // pending input for the auto-wake guard, and its refusals stay silent
    // because the queue keeps the prompt and retries after the next turn.
    startTurn: (sessionId, prompt, onStart) =>
      new Promise<boolean>((resolve) => {
        let release: (() => void) | undefined;
        try {
          release = ctx.onUserMessage?.(sessionId);
        } catch {
          release = undefined;
        }
        void runTurn({
          ws: undefined,
          originSessionId: sessionId,
          // A text-only prompt runs as its text, exactly as if it were typed;
          // one with images or files (or pasted into the TUI) as its blocks.
          payload: prompt.blocks.every((block) => block.type === 'text')
            ? {
                content:
                  prompt.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n') ||
                  prompt.text,
              }
            : { content: prompt.text, blocks: prompt.blocks },
          origin: 'queue',
          onSettled: (started) => {
            release?.();
            if (started) onStart();
            resolve(started);
          },
        });
      }),
    broadcast: (message) => ctx.broadcast?.(message),
    warn: (message) =>
      console.warn(JSON.stringify({ level: 'warn', event: 'webui.prompt_queue', message })),
  });

  const startRuntimeTurn = (sessionId: string, prompt: string): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      void runTurn({
        ws: undefined,
        originSessionId: sessionId,
        payload: { content: prompt },
        origin: 'runtime',
        onSettled: resolve,
      });
    });

  return {
    startRuntimeTurn,
    promptQueue,
    queue: async (ws, msg) => {
      if (!ensureCurrentSession(ws, msg, msg.type)) return;
      await handlePromptQueueMessage(promptQueue, {
        sessionId: requestedSessionId(msg) ?? ctx.getSessionId(),
        type: msg.type,
        payload: msg.payload,
        reply: (message) => ctx.send(ws, message),
      });
    },
    warmProvider: (_ws, msg) => {
      // Fire-and-forget and silent: a warm-up for a session this host does not
      // hold, or one that is mid-turn (its connection is open), is just skipped.
      const sessionId = requestedSessionId(msg) ?? ctx.getSessionId();
      if (!sessionId || (sessionId !== ctx.getSessionId() && !ctx.hasSession?.(sessionId))) return;
      if (activeTurns.has(sessionId)) return;
      const agent = ctx.getAgent(sessionId);
      void agent.ctx.provider.warm?.(agent.ctx.model).catch(() => undefined);
    },
    topicAdvice: async (ws, msg) => {
      if (!ensureCurrentSession(ws, msg, 'topic.advice')) return;
      const payload = (msg.payload ?? {}) as { requestId?: unknown; prompt?: unknown };
      // The asking tab's session, not the runtime's foreground: a background
      // tab's topic check used to be answered from the foreground agent's
      // history/provider and stamped as the foreground session, so tab 2's
      // advice landed in (and leaked from) tab 1.
      const originSessionId = requestedSessionId(msg) ?? ctx.getSessionId();
      if (typeof payload.requestId !== 'string' || typeof payload.prompt !== 'string') {
        ctx.send(ws, {
          type: 'topic.advice_result',
          payload: sessionPayload({
            sessionId: originSessionId,
            requestId: typeof payload.requestId === 'string' ? payload.requestId : '',
            suggestNewContext: false,
            confidence: 0,
            reason: 'Invalid topic advice request.',
            source: 'local',
          }),
        });
        return;
      }
      const agent = ctx.getAgent(originSessionId);
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
        payload: sessionPayload({
          sessionId: originSessionId,
          requestId: payload.requestId,
          ...advice,
        }),
      });
    },
    userMessage: async (ws, msg) => {
      if (!ensureCurrentSession(ws, msg, 'user_message')) return;
      const payload = (msg.payload ?? {}) as TurnPayload & { sessionId?: unknown };
      const requested =
        typeof payload.sessionId === 'string' && payload.sessionId ? payload.sessionId : undefined;
      const originSessionId = requested ?? ctx.getSessionId();
      // Counted as pending user input until the turn claimed (or was refused)
      // its run lock, so an auto-wake cannot slip in between a submit and its
      // run while setup waits on the transition gate.
      let release: (() => void) | undefined;
      try {
        release = ctx.onUserMessage?.(originSessionId);
      } catch {
        release = undefined;
      }
      await runTurn({
        ws,
        originSessionId,
        payload,
        origin: 'user',
        ...(release ? { onSettled: () => release?.() } : {}),
      });
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
      if (
        !['yes', 'no', 'always', 'always-exact', 'always-command', 'always-tool', 'deny'].includes(
          String(decision),
        )
      )
        return;
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
    submitUserInput: (_ws, msg) => {
      const sessionId = requestedSessionId(msg) ?? ctx.getSessionId();
      const response = (msg.payload as { response?: UserInputResponse } | undefined)?.response;
      if (!response || typeof response.requestId !== 'string' || !Array.isArray(response.answers))
        return;
      ctx.submitUserInput(sessionId, response);
    },
  };
}
