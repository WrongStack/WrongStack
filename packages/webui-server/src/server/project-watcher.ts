/**
 * Project source-tree watcher — broadcasts `files.tree.changed` when
 * files are created, modified, or deleted inside the project root, so
 * the WebUI file explorer refreshes its tree without manual navigation.
 *
 * Uses Node's native `fs.watch` with `recursive: true` (supported on
 * Windows and macOS; Linux support landed in Node 22). Events are
 * debounced (400ms) to coalesce bursts from build tools, git
 * checkouts, and agent writes. Heavyweight directories
 * (`node_modules`, `.git`, `dist`, …) are ignored to avoid event
 * storms — the same `SKIP_DIRS` set the tree builder uses.
 *
 * The watcher is `persistent: false` and `unref`'d on each handle so
 * it does not keep the process alive. The returned disposer closes
 * all native handles.
 */

import { watch, type FSWatcher } from 'node:fs';
import * as path from 'node:path';
import { SKIP_DIRS } from './file-picker.js';
import type { ConnectedClient, WSServerMessage } from './types.js';

export interface ProjectWatcherDeps {
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
  const watchers: FSWatcher[] = [];
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
    // `recursive: true` watches the entire subtree (Node 22+ on Linux;
    // unsupported runtimes throw and the watcher is simply absent — the
    // tree then refreshes on manual navigation; there is no silent
    // top-level fallback). `persistent: false` + `unref` keep the watcher
    // from holding the process alive, matching the module contract above.
    const watcher = watch(
      projectRoot,
      { recursive: true, persistent: false },
      (_eventType, filename) => {
        if (!filename) {
          scheduleNotify();
          return;
        }
        const changedPath = path.resolve(projectRoot, filename);
        if (shouldIgnore(changedPath)) return;
        scheduleNotify();
      },
    );
    watcher.unref?.();
    watcher.on('error', () => {
      // fs.watch errors (EPERM on Windows, ENOSPC on Linux) are
      // non-fatal — the tree will still refresh on the next
      // manual navigation. Log nothing to avoid noise.
    });
    watchers.push(watcher);
  } catch {
    // If recursive watch fails (e.g. older Linux), the watcher is
    // simply absent. The tree falls back to manual refresh on
    // directory navigation, same as before this feature.
  }

  return () => {
    if (disposed) return;
    disposed = true;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    for (const w of watchers) {
      try {
        w.close();
      } catch {
        // best-effort cleanup
      }
    }
  };
}
