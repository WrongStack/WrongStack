/**
 * Project source-tree watcher — broadcasts `files.tree.changed` when
 * files are created, modified, or deleted inside the project root, so
 * the WebUI file explorer refreshes its tree without manual navigation.
 *
 * Subscribes to core's SHARED recursive project watcher rather than opening
 * its own. This file used to call `fs.watch(root, {recursive:true})` directly,
 * which meant a running WebUI put a SECOND recursive watch on the same tree:
 * the OS then tracked it independently and delivered every event twice — and
 * on Windows `ReadDirectoryChangesW` reports `node_modules` too, so a `pnpm
 * install` or a build paid that twice over. Core's registry keeps ONE watcher
 * per resolved root per process and fans out to subscribers, which is exactly
 * why it exists; the codebase indexer and the chronicle file observer were
 * already using it.
 *
 * Events are debounced (400ms) to coalesce bursts from build tools, git
 * checkouts, and agent writes. Heavyweight directories (`node_modules`,
 * `.git`, `dist`, …) are ignored to avoid event storms — the same `SKIP_DIRS`
 * set the tree builder uses.
 *
 * The shared watcher is non-persistent and never keeps the process alive. The
 * returned disposer drops this subscription; the underlying handle closes once
 * the last subscriber leaves.
 */

import * as path from 'node:path';
import { type ProjectWatchSubscription, watchProjectTree } from '@wrongstack/core/utils';
import { SKIP_DIRS } from './file-picker.js';
import type { ConnectedClient, WSServerMessage } from './types.js';

interface ProjectWatcherDeps {
  /** Absolute project root to watch. */
  projectRoot: string;
  /** Broadcast a message to all connected WS clients. */
  broadcast: (
    clients: Map<import('ws').WebSocket, ConnectedClient>,
    msg: WSServerMessage,
  ) => void;
  /** Live client map (same reference the rest of setupEvents uses). */
  clients: Map<import('ws').WebSocket, ConnectedClient>;
}

/** Debounce window: coalesce rapid bursts into a single broadcast. */
const DEBOUNCE_MS = 400;

/**
 * Start watching `projectRoot` for filesystem changes. Returns a
 * disposer that closes all native watch handles.
 */
export function startProjectWatcher(deps: ProjectWatcherDeps): () => void {
  const { projectRoot, broadcast, clients } = deps;
  let subscription: ProjectWatchSubscription | undefined;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const notifyClients = () => {
    if (disposed) return;
    broadcast(clients, { type: 'files.tree.changed', payload: {} });
  };

  const scheduleNotify = () => {
    if (disposed) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      notifyClients();
    }, DEBOUNCE_MS);
  };

  // Check whether a changed path should be ignored (inside a
  // heavyweight dir). We compare path segments against SKIP_DIRS.
  const shouldIgnore = (changedPath: string): boolean => {
    const rel = path.relative(projectRoot, changedPath);
    if (rel.startsWith('..')) return true; // outside project root
    const segments = rel.split(/[\\/]/);
    return segments.some((seg) => SKIP_DIRS.has(seg));
  };

  try {
    subscription = watchProjectTree(
      projectRoot,
      ({ filename }) => {
        if (!filename) {
          // Null filename is a watcher-buffer overflow: the OS dropped events
          // and cannot say which. Refresh the tree rather than miss a change.
          scheduleNotify();
          return;
        }
        const changedPath = path.resolve(projectRoot, filename);
        if (shouldIgnore(changedPath)) return;
        scheduleNotify();
      },
      {
        onError: () => {
          // Watch errors (EPERM on Windows, ENOSPC on Linux) are non-fatal —
          // the tree still refreshes on the next manual navigation. Log
          // nothing to avoid noise.
        },
      },
    );
  } catch {
    // No recursive watch on this platform/path (Linux before Node 22). The
    // tree falls back to manual refresh on directory navigation, same as
    // before this feature.
  }

  return () => {
    if (disposed) return;
    disposed = true;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    try {
      subscription?.close();
    } catch {
      // best-effort cleanup
    }
    subscription = undefined;
  };
}
