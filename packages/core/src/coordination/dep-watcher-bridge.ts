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

import { existsSync, type FSWatcher, watch as fsWatch, statSync } from 'node:fs';
import type { EventBus } from '@wrongstack/contracts/kernel/events';
import { makeDependencyWatcherConfig } from './dep-watcher.js';
import type { Mailbox } from './mailbox-types.js';

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
/**
 * Convert an absolute path under the project root to a project-relative one.
 *
 * Exported for tests: the project-relative form is the ONLY one
 * `techstack-mailbox-consumer.ts` will accept, so the conversion is load-bearing
 * and worth pinning directly.
 */
export function relativize(projectRoot: string, absolutePath: string): string {
  const root = projectRoot.replaceAll('\\', '/').replace(/\/+$/, '');
  const target = absolutePath.replaceAll('\\', '/');
  if (target === root) return '';
  if (target.startsWith(`${root}/`)) return target.slice(root.length + 1);
  // Outside the root — return as-is and let the consumer's gate reject it.
  // Silently stripping a prefix that does not match would fabricate a path.
  return target;
}

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

  // Establish the filesystem watch.
  //
  // The plugin only emits `file-watcher:changed` for paths handed to `watch_start`,
  // and nothing in production ever did that. `cfg.watchPaths` had zero consumers,
  // so `depWatcher.enabled: true` connected the bridge to an event source that
  // was never switched on — the whole trigger-to-spawn chain was dormant. The
  // bridge owns the paths it was configured for, so it starts them itself.
  const watches: FSWatcher[] = [];
  for (const watchPath of cfg.watchPaths) {
    // A single unwatchable path must not abort the wiring of the rest — the
    // globbed manifests and nested workspace files may not all exist yet.
    try {
      // A watch on a FILE reports `filename` as the bare basename (platform
      // behaviour on win32/linux/macOS — pinned in
      // packages/plugins/tests/file-watcher-exec.test.ts:204). Joining that
      // onto the watched file path yields "<root>/package.json/package.json",
      // which still passes the basename filter downstream and then ENOENTs in
      // `readDelta` — silently emptying the added-package delta for every
      // root-level manifest. For file targets use the path verbatim.
      let targetIsDirectory = true;
      try {
        targetIsDirectory = statSync(watchPath).isDirectory();
      } catch {
        targetIsDirectory = false;
      }

      const watcher = fsWatch(
        watchPath,
        { recursive: targetIsDirectory },
        (eventType, filename) => {
          const name =
            filename === null || filename === undefined ? '' : String(filename).replace(/\\/g, '/');
          const absolute = targetIsDirectory
            ? name
              ? `${watchPath}/${name}`
              : watchPath
            : watchPath;

          // Emit PROJECT-RELATIVE paths. `acceptManifestCandidate` in
          // techstack-mailbox-consumer.ts refuses absolute paths and any `..`
          // segment by design — the path is handed to a spawned agent holding
          // `read`, so it must not be able to name a file outside the project.
          // The bridge watched absolute paths, so forwarding them verbatim made
          // every path fail that gate and silently fall back to the subject
          // regex, which carries only the basename — exactly the directory
          // context loss this chain was supposed to fix.
          const changed = relativize(projectRoot, absolute);

          // `fs.watch` reports DELETIONS as 'rename' too, so mapping rename→add
          // unconditionally would let `git checkout` or a branch switch spawn a
          // research audit for a manifest that no longer declares anything.
          // `onChange` drops 'delete'; resolve the ambiguity by looking at disk.
          // Probe the ABSOLUTE path — `existsSync` resolves relative paths
          // against process.cwd(), which is not necessarily the project root.
          let event: string;
          if (eventType === 'change') {
            event = 'change';
          } else {
            event = existsSync(absolute) ? 'add' : 'delete';
          }

          void cfg.onChange({ path: changed, event, timestamp: new Date().toISOString() });
        },
      );
      // Without this, an `fs.watch` handle that errors (ENOSPC after the OS
      // inotify/readdir budget is exhausted, or EPERM on a restricted path)
      // emits an unhandled 'error' event and kills the process. The plugin gets
      // this from its host teardown path; the bridge owns its own handles, so it
      // must attach its own handler. Losing a watch degrades to "no dep
      // audits"; crashing the session is not an acceptable trade.
      watcher.on('error', () => {
        /* watch died — degrade, never crash */
      });

      // Never hold the process open for a background watcher.
      watcher.unref?.();
      watches.push(watcher);
    } catch {
      // Path does not exist yet, or the platform refused this recursive watch.
      // `watchPaths` is best-effort by design — see the factory's own comment
      // that a lockfile absent on first install "will fail silently".
    }
  }
  if (watches.length === 0) {
    throw new Error('dep-watcher-bridge: no watch paths could be watched');
  }

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
    for (const watcher of watches) {
      try {
        watcher.close();
      } catch {
        // Already closed by the host, or closed during teardown races.
      }
    }
    watches.length = 0;
    cfg.dispose();
  };
}
