/**
 * dep-watcher-bridge — Bridges the file-watcher plugin's custom events
 * to the dependency watcher → mailbox pipeline.
 *
 * The file-watcher plugin emits `file-watcher:changed` custom events
 * when files change. This module subscribes to those events, filters
 * for dependency manifests (package.json, go.mod, etc.), and posts
 * assign messages to the inter-agent mailbox for tech-stack audit.
 *
 * Returns a dispose function that unsubscribes from the event bus.
 *
 * @module dep-watcher-bridge
 */

import type { EventBus } from '../kernel/events.js';
import type { Mailbox } from './mailbox-types.js';
import { makeDependencyWatcherConfig } from './dep-watcher.js';

export interface DepWatcherBridgeOptions {
  /** The event bus to subscribe to (same bus the file-watcher plugin emits on). */
  events: EventBus;
  /** The mailbox instance where dep-change notifications will be posted. */
  mailbox: Mailbox;
  /** Absolute project root — used to build watch paths and match file patterns. */
  projectRoot: string;
  /** Agent id the tech-stack audit tasks should target. Default: 'tech-stack'. */
  targetAgent?: string | undefined;
  /** Agent id of the watcher/sender. Default: 'dep-watcher'. */
  watcherAgentId?: string | undefined;
  /** Debounce window in ms. Default: 3000 (3 seconds). */
  debounceMs?: number | undefined;
}

/**
 * Wire the file-watcher's `file-watcher:changed` events into the
 * dependency watcher → mailbox pipeline.
 *
 * Returns a dispose function. Call it to unsubscribe when the
 * session ends or the watcher is no longer needed.
 *
 * Usage:
 *   const dispose = attachDepWatcherBridge({
 *     events: ctx.events,
 *     mailbox: getSharedProjectMailbox(projectDir, ctx.events),
 *     projectRoot: ctx.projectRoot,
 *   });
 *   // ... session runs ...
 *   dispose(); // clean up on exit
 */
export function attachDepWatcherBridge(opts: DepWatcherBridgeOptions): () => void {
  const {
    events,
    mailbox,
    projectRoot,
    targetAgent = 'tech-stack',
    watcherAgentId = 'dep-watcher',
    debounceMs = 3000,
  } = opts;

  // Build the dep-watcher config — generates onChange callback
  const cfg = makeDependencyWatcherConfig({
    projectRoot,
    mailbox,
    targetAgent,
    watcherAgentId,
    debounceMs,
  });

  // Subscribe to file-watcher:changed events from the file-watcher plugin.
  // The plugin emits: { watchId, path, event, filename, timestamp }
  const unsub = events.onPattern('file-watcher:changed', (_eventName, rawPayload) => {
    const payload = rawPayload as
      | {
          watchId?: string;
          path?: string;
          event?: string;
          filename?: string;
          timestamp?: string;
        }
      | undefined;
    if (!payload?.path) return;

    // Forward to dep-watcher pipeline (includes debounce + filtering)
    void cfg
      .onChange({
        path: payload.path,
        event: payload.event ?? 'change',
        timestamp: payload.timestamp ?? new Date().toISOString(),
      })
      .catch(() => {
        // Best-effort — a lost notification is acceptable
      });
  });

  return () => {
    unsub();
  };
}
