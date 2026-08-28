import type { Agent, Context } from '@wrongstack/core/agent';
import { sessionScopedPath } from '@wrongstack/core/utils';
import { planTool, taskTool, todoTool } from '@wrongstack/tools';
import type { WebSocket } from 'ws';
import type { WorklistContext, WorklistMessage } from './handlers/worklist-handlers.js';
import type { WSServerMessage } from './types.js';

/**
 * Per-session binding for the worklist routes (todos / tasks / plan).
 *
 * The worklist used to read and write through the shared ROOT context — the
 * one `session.resume` re-points to whichever tab was switched to last. A
 * request stamped with a background tab's session id was therefore *allowed*
 * by the session gate but served (and mutated!) the foreground session's
 * board: every tab showed one shared list, and a click in tab B could rewrite
 * tab A's todos.
 *
 * This factory resolves the context the request actually names:
 *
 *   - untagged requests keep the root context (single-session hosts, older
 *     clients) — identical to the previous behaviour;
 *   - a request naming the root session keeps the root context;
 *   - a request naming another session resolves that session's agent
 *     (read-only `peekAgent` first, then `getAgent`, which creates one — the
 *     four-tab registry with idle eviction is the same one the conversation
 *     routes already use).
 *
 * Agents minted while the root sat on a different session inherit the root's
 * meta verbatim, including its `plan.path` / `task.path` sidecar paths. Those
 * are re-scoped to the requested session here, before any read or write can
 * land in the neighbouring session's `.plan.json` / `.tasks.json`.
 */

interface SessionWorklistDeps {
  /** Shared root context — bound to whichever session the runtime last activated. */
  rootContext: Context;
  /** Agent for a session WITHOUT creating one; preferred for read paths. */
  peekAgent?: ((sessionId?: string) => Agent | undefined) | undefined;
  /** Agent for a session, creating one when absent (four-tab registry). */
  getAgent?: ((sessionId?: string) => Agent) | undefined;
  /** Sessions directory holding the per-session plan/task/todos sidecars. */
  sessionsDir?: string | undefined;
  send: (ws: WebSocket, msg: WSServerMessage) => void;
  broadcast: (msg: WSServerMessage) => void;
}

function messageSessionIdOf(message: WorklistMessage | undefined): string | undefined {
  const payload = message?.payload;
  return payload &&
    typeof payload === 'object' &&
    typeof (payload as { sessionId?: unknown }).sessionId === 'string'
    ? (payload as { sessionId: string }).sessionId
    : undefined;
}

export function createSessionAwareWorklistContext(
  deps: SessionWorklistDeps,
): (message?: WorklistMessage | undefined) => WorklistContext {
  return (message) => {
    const requested = messageSessionIdOf(message);
    const rootSessionId = deps.rootContext.session?.id;
    let target = deps.rootContext;
    if (requested && requested !== rootSessionId) {
      const agent = deps.peekAgent?.(requested) ?? deps.getAgent?.(requested);
      if (agent) target = agent.ctx;
    }
    if (requested && target.session?.id === requested && deps.sessionsDir) {
      const expectedPlan = sessionScopedPath(deps.sessionsDir, requested, '.plan.json');
      const expectedTask = sessionScopedPath(deps.sessionsDir, requested, '.tasks.json');
      const meta = target.meta as Record<string, unknown>;
      if (meta['plan.path'] !== expectedPlan) {
        target.state.setMeta?.('plan.path', expectedPlan);
      }
      if (meta['task.path'] !== expectedTask) {
        target.state.setMeta?.('task.path', expectedTask);
      }
    }
    // NOTE: todo mutations persist through the todos checkpoint attached to
    // the ROOT context (rebound on every session swap). Routing a background
    // tab's mutation to its own agent updates that session's in-memory board
    // (and its Kanban mirror, tagged with the right session id) but does not
    // flush the background sidecar — the same persistence surface a
    // background agent run already has.
    return {
      context: {
        todos: target.todos,
        meta: target.meta as Record<string, unknown>,
        session: target.session ? { id: target.session.id } : null,
      },
      send: deps.send,
      broadcast: deps.broadcast,
      replaceTodos: (todos) => target.state.replaceTodos(todos),
      mutateTodos: async (todos) => {
        const result = await todoTool.execute({ todos }, target, {
          signal: AbortSignal.timeout(30_000),
        });
        return {
          todos: [...target.todos],
          ...(result.kanban_warnings ? { warnings: result.kanban_warnings } : {}),
        };
      },
      mutateTaskStatus: async (id, status) =>
        taskTool.execute({ action: 'status', id, status }, target, {
          signal: AbortSignal.timeout(30_000),
        }),
      mutatePlan: async (operation) =>
        planTool.execute(operation, target, { signal: AbortSignal.timeout(30_000) }),
    };
  };
}
