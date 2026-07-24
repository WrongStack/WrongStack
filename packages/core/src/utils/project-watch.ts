/**
 * Shared recursive project-tree watcher.
 *
 * Several subsystems each used to open their own `fs.watch(projectRoot,
 * {recursive:true})` — the codebase indexer, the chronicle file observer, and
 * the WebUI indexing mirror. Every recursive watch makes the OS track the
 * whole tree independently, so a single runtime paid that cost 2–3×. This
 * registry keeps ONE watcher per resolved root per process and fans events
 * out to all subscribers; the watcher closes when the last subscriber leaves.
 *
 * The registry lives behind a `Symbol.for` global so it stays a singleton
 * even if core is loaded twice (Windows path-casing double-load).
 *
 * @module utils/project-watch
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ProjectWatchEvent {
  eventType: 'rename' | 'change';
  /** Path relative to the watched root as delivered by the OS, or null when omitted. */
  filename: string | null;
}

export interface ProjectWatchSubscription {
  close(): void;
}

interface Subscriber {
  listener: (event: ProjectWatchEvent) => void;
  onError?: ((error: unknown) => void) | undefined;
}

interface WatchEntry {
  watcher: fs.FSWatcher;
  subscribers: Set<Subscriber>;
  /** Set once the underlying watcher errored or closed — dead entries are never reused. */
  dead: boolean;
}

const REGISTRY_KEY = Symbol.for('wrongstack.projectWatchRegistry');
const globalScope = globalThis as { [REGISTRY_KEY]?: Map<string, WatchEntry> };
if (!globalScope[REGISTRY_KEY]) globalScope[REGISTRY_KEY] = new Map();
const registry: Map<string, WatchEntry> = globalScope[REGISTRY_KEY];

function registryKey(root: string): string {
  const resolved = path.resolve(root);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Subscribe to recursive change events under `root`, sharing one OS watcher
 * per root per process. Throws when the platform cannot create the watcher
 * (no recursive support, permission) and no live shared watcher exists —
 * callers that can degrade should try/catch exactly as they would `fs.watch`.
 *
 * The watcher is non-persistent: it never keeps the process alive.
 */
export function watchProjectTree(
  root: string,
  listener: (event: ProjectWatchEvent) => void,
  opts?: { onError?: ((error: unknown) => void) | undefined },
): ProjectWatchSubscription {
  const key = registryKey(root);
  let entry = registry.get(key);
  if (!entry || entry.dead) {
    const subscribers = new Set<Subscriber>();
    const watcher = fs.watch(
      path.resolve(root),
      { recursive: true, persistent: false },
      (eventType, filename) => {
        const event: ProjectWatchEvent = {
          eventType: eventType === 'rename' ? 'rename' : 'change',
          filename: filename === null ? null : String(filename),
        };
        for (const sub of subscribers) {
          try {
            sub.listener(event);
          } catch (error) {
            sub.onError?.(error);
          }
        }
      },
    );
    const created: WatchEntry = { watcher, subscribers, dead: false };
    const retire = (): void => {
      created.dead = true;
      if (registry.get(key) === created) registry.delete(key);
    };
    watcher.on('error', (error) => {
      // A watcher that errored is closed by Node — mark the entry dead so the
      // next acquire creates a fresh one instead of reusing a corpse.
      retire();
      for (const sub of subscribers) sub.onError?.(error);
    });
    // Watchers can also close without first emitting `error` (for example when
    // the watched tree disappears). Never leave that closed handle reusable.
    watcher.on('close', retire);
    registry.set(key, created);
    entry = created;
  }

  const active = entry;
  const subscriber: Subscriber = { listener, onError: opts?.onError };
  active.subscribers.add(subscriber);

  let closed = false;
  return {
    close() {
      if (closed) return;
      closed = true;
      active.subscribers.delete(subscriber);
      if (active.subscribers.size === 0 && !active.dead) {
        active.dead = true;
        if (registry.get(key) === active) registry.delete(key);
        try {
          active.watcher.close();
        } catch {
          /* already closed */
        }
      }
    },
  };
}
