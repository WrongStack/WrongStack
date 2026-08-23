import type { CollaborationBus, InjectedToolResult } from './collab-bus.js';
import type { ToolCallPipelinePayload } from '../core/agent.js';
import type { Middleware } from '../kernel/pipeline.js';

/**
 * collabPauseMiddleware — gates the agent's `toolCall` pipeline on
 * the collaboration pause signal.
 *
 * Position: must be installed as the *first* middleware in the
 * `toolCall` pipeline so it runs before permission checks, retries,
 * and the tool itself. That way the controller can halt an agent
 * regardless of what the model is about to do.
 *
 * Semantics:
 *   - When the bus is not paused: pass through (`next()`).
 *   - When the bus is paused: await `bus.waitForResume(timeoutMs)`.
 *     The default timeout is 60s — long enough for a human to think,
 *     short enough that a forgotten controller doesn't pin the agent
 *     forever. The auto-resume on timeout is logged below.
 *
 * Phase 3 of idea #13. Manual tool-call injection (a controller
 * "writing" a tool result) is *not* in scope for this middleware —
 * that requires splicing the injected result into the agent's
 * message stream and is a follow-up.
 */

export interface CollabPauseMiddlewareOptions {
  /**
   * How long to wait for a resume before auto-resuming the bus.
   * Defaults to 60_000 ms. Set to 0 for an unbounded wait (the
   * caller is then responsible for cancellation via the bus itself).
   */
  defaultTimeoutMs?: number | undefined;
  /**
   * Optional logger — receives a debug line on pause entry and on
   * timeout-driven auto-resume. Matches the `Logger` token surface
   * so the runtime can pass its existing logger.
   */
  logger?: {
    debug?: ((msg: string) => void) | undefined;
    warn?: ((msg: string) => void) | undefined;
  };
}

export function collabPauseMiddleware(
  bus: CollaborationBus,
  opts: CollabPauseMiddlewareOptions = {},
): Middleware<ToolCallPipelinePayload> {
  const timeoutMs = opts.defaultTimeoutMs ?? 60_000;
  const logger = opts.logger;

  return {
    name: 'collab-pause',
    owner: 'core',
    async handler(payload, next) {
      if (!bus.isPaused()) {
        // Fast path: not paused. We still call next() unconditionally
        // so the rest of the pipeline runs as if we weren't here.
        return next(payload);
      }
      const state = bus.getState();
      logger?.debug?.(
        `collab-pause: tool '${payload.toolUse.name}' blocked — bus paused by ${
          state.pausedBy ?? '?'
        } at ${state.pausedAt ?? '?'}, waiting up to ${timeoutMs}ms for resume`,
      );
      const resumed = await bus.waitForResume(timeoutMs);
      if (!resumed) {
        logger?.warn?.(
          `collab-pause: timeout after ${timeoutMs}ms — auto-resuming the bus to unblock the agent loop`,
        );
      } else {
        logger?.debug?.(`collab-pause: resumed — proceeding with tool '${payload.toolUse.name}'`);
      }
      return next(payload);
    },
  };
}

/**
 * collabInjectMiddleware — Phase 4 of idea #13. Splices
 * controller-injected tool results into the toolCall pipeline.
 *
 * Position: should run AFTER `collabPauseMiddleware` so the
 * controller has a chance to pause + inject before the next tool
 * executes. Install order:
 *   - `pipeline.toolCall.prepend(collabInject)`
 *   - `pipeline.toolCall.prepend(collabPause)`  // runs first
 *
 * Semantics:
 *   - On every tool call, the middleware asks the bus for an
 *     injection matching `payload.toolUse.id`.
 *   - If one is queued, the payload's `result` is overwritten with
 *     a synthetic ToolResultBlock carrying the injected content +
 *     `is_error` flag. The real `next()` is NOT called; downstream
 *     middleware sees the controller's synthetic result.
 *   - The injection is consumed once and removed from the bus.
 *
 * Why this shape: the agent loop's existing `tool.executed` event still
 * fires (carrying the injected content), so the session log + observers see
 * a normal-looking call — just with the controller's intent in the result.
 */
export function collabInjectMiddleware(
  bus: CollaborationBus,
  opts: {
    logger?: {
      debug?: ((msg: string) => void) | undefined;
      warn?: ((msg: string) => void) | undefined;
    };
  } = {},
): Middleware<ToolCallPipelinePayload> {
  const logger = opts.logger;
  return {
    name: 'collab-inject',
    owner: 'core',
    async handler(payload, next) {
      const injected = bus.takeInjection(payload.toolUse.id);
      if (!injected) {
        // No manual injection — proceed normally.
        return next(payload);
      }
      logger?.debug?.(
        `collab-inject: tool '${payload.toolUse.name}' (id ${payload.toolUse.id}) — using controller-injected result (reason: ${injected.reason})`,
      );
      // Splice the injected content into the existing result block. The agent
      // loop currently ignores the pipeline return value, so this must mutate
      // the block object the caller already holds.
      payload.result.type = 'tool_result';
      payload.result.tool_use_id = payload.toolUse.id;
      payload.result.content =
        typeof injected.content === 'string' ? injected.content : JSON.stringify(injected.content);
      payload.result.is_error = injected.isError;
      // Close the feedback loop: tell listeners (the webui collab handler) that
      // the queued injection was actually applied, carrying the now-known real
      // tool name so observers see "injection applied to <tool>".
      bus.notifyInjectionConsumed({
        toolUseId: payload.toolUse.id,
        toolName: payload.toolUse.name,
        authorId: injected.authorId,
        reason: injected.reason,
        isError: injected.isError,
      });
      // Don't call next() — the injected result replaces the downstream value.
      return payload;
    },
  };
}

// Re-export so callers that import from this module get the type
// without an extra import.
export type { InjectedToolResult };
