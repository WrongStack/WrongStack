import type { Agent } from '@wrongstack/core';
import type { WebSocket } from 'ws';
import type { WsCommon } from './index.js';

/**
 * PR 5k of Issue #30: the connection-level WebSocket handlers —
 * `user_message` (the agent-run entry), `abort`, `ping`, and
 * `tool.confirm_result`.
 *
 * These are the last cases that lived inline in `runWebUI`'s
 * `handleMessage` switch. Unlike the topic groups, they own per-socket
 * run-loop state: `abortControllers` (one in-flight `AbortController`
 * per socket) and `pendingConfirms` (tool-permission resolvers keyed by
 * confirm id). Both maps are *owned* by `runWebUI` and shared with the
 * connection/close handlers, so they're passed by reference on the
 * context rather than copied — the close handler still aborts/clears the
 * same maps these handlers mutate.
 *
 * `opts` is threaded by reference (read-only here) so `handleUserMessage`
 * calls the live `opts.agent` — after a project switch reassigns it, the
 * next `user_message` runs the new agent.
 */

/** The tool-confirmation decision the client can send back. */
export type ConfirmDecision = 'yes' | 'no' | 'always' | 'deny';

export interface ConnectionOptions {
  agent: Agent;
}

export interface ConnectionContext extends WsCommon {
  opts: ConnectionOptions;
  /** One in-flight run controller per socket; owned by runWebUI. */
  abortControllers: Map<WebSocket, AbortController>;
  /** Pending tool-permission resolvers keyed by confirm id; owned by runWebUI. */
  pendingConfirms: Map<string, (decision: ConfirmDecision) => void>;
}

export async function handleUserMessage(
  ctx: ConnectionContext,
  ws: WebSocket,
  content: string,
): Promise<void> {
  // Guard against overlapping runs on the same Agent instance. Two
  // rapid user messages would otherwise start a second agent.run()
  // before the first one's cleanup settles, corrupting context state.
  // Scoped to the requesting socket via `abortControllers` — a second
  // tab's `user_message` is allowed to start its own run; only an
  // overlapping message from the SAME tab is rejected.
  if (ctx.abortControllers.has(ws)) {
    ctx.send(ws, {
      type: 'error',
      payload: { phase: 'agent.run', message: 'A run is already in progress. Abort it first.' },
    });
    return;
  }

  // Abort any existing run (safety net; the guard above makes this
  // unreachable in the overlapping case, but direct abort requests
  // from the client still need the controller reference).
  const wsAbort = new AbortController();
  ctx.abortControllers.set(ws, wsAbort);

  try {
    const result = await ctx.opts.agent.run(content, {
      signal: wsAbort.signal,
    });

    ctx.send(ws, {
      type: 'run.result',
      payload: {
        status: result.status,
        iterations: result.iterations,
        finalText: result.finalText,
        error: result.error
          ? {
              code: result.error.code,
              message: result.error.message,
              recoverable: result.error.recoverable,
            }
          : undefined,
      },
    });
  } catch (err) {
    ctx.send(ws, {
      type: 'error',
      payload: {
        phase: 'agent.run',
        message: err instanceof Error ? err.message : String(err),
      },
    });
  } finally {
    ctx.abortControllers.delete(ws);
  }
}

export function handleAbort(ctx: ConnectionContext, ws: WebSocket): void {
  // Scope the abort to the requesting socket. The legacy module-scope
  // `abortController` (project-switch path) is left alone — a
  // `case 'abort'` from one client should not interfere with another
  // client's in-flight run. The error message is sent only to the
  // requesting socket (not broadcast), which is correct: other clients
  // have no idea what just happened.
  const wsController = ctx.abortControllers.get(ws);
  wsController?.abort();
  ctx.send(ws, {
    type: 'error',
    payload: { phase: 'abort', message: 'User aborted' },
  });
}

export function handlePing(ctx: ConnectionContext, ws: WebSocket): void {
  ctx.send(ws, { type: 'pong', payload: {} });
}

export function handleToolConfirmResult(
  ctx: ConnectionContext,
  id: string,
  decision: ConfirmDecision,
): void {
  const resolve = ctx.pendingConfirms.get(id);
  if (resolve) {
    ctx.pendingConfirms.delete(id);
    resolve(decision);
  }
}
