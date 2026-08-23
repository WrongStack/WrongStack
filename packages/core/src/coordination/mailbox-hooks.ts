/**
 * mailbox-hooks — Tool-execution hooks for mailbox integration.
 *
 * 1. Before each tool call, checks the mailbox for unread high-priority
 *    steer messages and emits a `mailbox.unread_count` event.
 * 2. After each tool call, updates the agent heartbeat so other agents
 *    know this one is still alive.
 *
 * This gives near-real-time mailbox checking (every tool call, not just
 * iteration boundaries) and powers the "new mail" badge in the WebUI/TUI.
 *
 * @module mailbox-hooks
 */

import { UNREAD_CHECK_MIN_INTERVAL_MS } from './mailbox-constants.js';
import type { Mailbox } from './mailbox-types.js';

export interface MailboxHooksOptions {
  /** The mailbox instance. */
  mailbox: Mailbox;
  /** Agent id for read-receipt and unread-check purposes. */
  agentId: string;
  /** Current session id, used to include same-session broadcasts in unread counts. */
  sessionId?: string | undefined;
  /** Whether to emit new-mail notifications. Default: true. */
  notifyNewMail?: boolean | undefined;
  /** Whether to update heartbeat. Default: true. */
  heartbeat?: boolean | undefined;
  /**
   * Minimum gap between actual mailbox reads in `beforeTool`. Default:
   * {@link UNREAD_CHECK_MIN_INTERVAL_MS}. Pass 0 to read on every tool call.
   */
  unreadCheckIntervalMs?: number | undefined;
}

/**
 * Create a pair of hooks for the tool execution pipeline.
 *
 * Usage:
 *   const hooks = createMailboxHooks({ mailbox, agentId });
 *   // In the tool executor, before each tool call:
 *   await hooks.beforeTool({ events });
 *   // After each tool call:
 *   await hooks.afterTool();
 *
 * The `beforeTool` hook checks for unread messages and emits
 * `mailbox.unread_count` events. The `afterTool` hook updates
 * the agent heartbeat.
 */
export function createMailboxHooks(opts: MailboxHooksOptions) {
  const {
    mailbox,
    agentId,
    sessionId,
    notifyNewMail = true,
    heartbeat = true,
    unreadCheckIntervalMs = UNREAD_CHECK_MIN_INTERVAL_MS,
  } = opts;

  let lastUnreadCount = -1;
  let lastCheckedAt = Number.NEGATIVE_INFINITY;

  return {
    /**
     * Call before each tool execution. Checks mailbox and emits events.
     *
     * The dedupe below suppresses redundant *events*; `unreadCheckIntervalMs`
     * suppresses redundant *reads*. Both are needed — a turn issuing dozens of
     * tool calls otherwise stats (and, whenever a peer session appended,
     * re-reads) the shared message file once per call.
     *
     * @param events — EventBus-like object with emit method.
     */
    async beforeTool(events: { emit: (type: string, payload: unknown) => void }): Promise<void> {
      const now = Date.now();
      // `<` not `<=`: with the default interval a same-millisecond burst still
      // collapses, while an interval of 0 always reads.
      if (now - lastCheckedAt < unreadCheckIntervalMs) return;
      lastCheckedAt = now;
      try {
        const count = await mailbox.unreadCount(agentId, sessionId);

        // Emit unread count if it changed (avoids spamming identical events)
        if (notifyNewMail && count !== lastUnreadCount) {
          lastUnreadCount = count;
          events.emit('mailbox.unread_count', { agentId, count });
        }
      } catch {
        // Mailbox unavailable — silent
      }
    },

    /**
     * Call after each tool execution. Updates heartbeat and optionally
     * current tool status.
     */
    async afterTool(toolName?: string): Promise<void> {
      if (!heartbeat) return;
      try {
        await mailbox.heartbeat({
          agentId,
          status: 'running',
          currentTool: toolName,
        });
      } catch {
        // Best-effort
      }
    },

    /**
     * Reset the cached unread count (e.g., after the agent checks manually).
     * Also clears the read throttle, so the next `beforeTool` re-reads
     * immediately instead of waiting out the interval.
     */
    reset() {
      lastUnreadCount = -1;
      lastCheckedAt = Number.NEGATIVE_INFINITY;
    },
  };
}
