/**
 * file-watcher plugin — Watches project files and triggers actions on changes.
 *
 * Tools registered:
 * - watch_start: Start watching paths for file changes
 * - watch_stop: Stop a watch by ID
 * - watch_list: List all active watches
 */

import { watch as fsWatch } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from '@wrongstack/core/types';
import { withinProject } from '../runtime/index.js';

const API_VERSION = '^0.1.10';

// ---------------------------------------------------------------------------
// Sandbox: reject paths that resolve outside the current working directory.
// Canonical implementation lives in runtime/ (shared with path-guard).
// ---------------------------------------------------------------------------

interface WatchHandle {
  id: string;
  paths: string[];
  recursive: boolean;
  events: string[];
  /** One watcher per path; close all to fully release resources. */
  watchers: Array<{ close: () => void }>;
  createdAt: string;
}

let watch_idCounter = 0;

/**
 * Generate a deterministic watch ID. Uses a monotonically increasing
 * counter plus a base36 timestamp for uniqueness across restarts.
 *
 * Determinism: the counter ensures IDs are reproducible within a session
 * (same sequence of watch_start calls → same IDs). The timestamp suffix
 * ensures uniqueness across process restarts.
 */
function nextId(): string {
  return `watch_${++watch_idCounter}_${Date.now().toString(36)}`;
}

// Module-level state, shared between `setup` and `teardown`.
//
// Why module-level? The Plugin interface in @wrongstack/core does not
// thread state from `setup` → `teardown`. Keeping `watches` and
// `debounceTimers` inside the setup closure made both Maps invisible
// to teardown — which is why the previous teardown was a documented
// no-op that leaked every fs.FSWatcher and every debounce setTimeout
// (H1 audit, 2026-06-03). With stable Map identity at module scope
// teardown can finally close handles and clear timers. The contents
// are reset in setup (idempotent re-init) and freed in teardown.
const watches = new Map<string, WatchHandle>();
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const MAX_WATCH_GROUPS = 32;
const MAX_PATHS_PER_WATCH = 16;
const MAX_FILESYSTEM_WATCHERS = 64;

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: 'file-watcher',
  version: '0.1.0',
  description: 'Watches project files and emits events when changes occur (add, change, delete)',
  apiVersion: API_VERSION,
  capabilities: { tools: true },
  defaultConfig: {
    debounceMs: 500,
    watchOnStartup: [],
    autoUnwatchOnExit: true,
    autoIndex: false,
    indexProjectRoot: '',
    depWatcher: {
      enabled: false,
      targetAgent: 'tech-stack',
      debounceMs: 3000,
    },
  },
  configSchema: {
    type: 'object',
    properties: {
      debounceMs: { type: 'number', default: 500 },
      watchOnStartup: { type: 'array', items: { type: 'string' }, default: [] },
      autoUnwatchOnExit: { type: 'boolean', default: true },
      autoIndex: {
        type: 'boolean',
        default: false,
        description:
          'When true, automatically reindex changed .ts/.tsx/.js/.jsx files via codebase-index (incremental)',
      },
      indexProjectRoot: {
        type: 'string',
        default: '',
        description: 'Project root directory for the indexer. Defaults to cwd when empty.',
      },
      depWatcher: {
        type: 'object',
        default: { enabled: false },
        description:
          'Bridge dependency file changes (package.json, go.mod, etc.) to the inter-agent mailbox for tech-stack audits. Requires the mailbox tool to be registered.',
        properties: {
          enabled: { type: 'boolean', default: false },
          targetAgent: { type: 'string', default: 'tech-stack' },
          debounceMs: { type: 'number', default: 3000 },
        },
      },
    },
  },

  setup(api) {
    // Idempotent re-init: on plugin reload, close any leftover watches
    // and clear any pending debounce timers before re-populating. The
    // Maps live at module scope so teardown can reach them.
    for (const handle of watches.values()) {
      for (const w of handle.watchers) {
        try {
          w.close();
        } catch {
          /* ignore — handle may already be closed */
        }
      }
    }
    watches.clear();
    for (const t of debounceTimers.values()) clearTimeout(t);
    debounceTimers.clear();

    const debounceMs =
      ((api.config.extensions?.['file-watcher'] as Record<string, unknown>)?.[
        'debounceMs'
      ] as number) ?? 500;

    function debounceEvent(key: string, fn: () => void, ms: number): void {
      const existing = debounceTimers.get(key);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        debounceTimers.delete(key);
        fn();
      }, ms);
      // A pending debounce must not hold the process open on shutdown —
      // the watcher is a background observer, never a reason to stay alive.
      timer.unref?.();
      debounceTimers.set(key, timer);
    }

    const autoIndex =
      ((api.config.extensions?.['file-watcher'] as Record<string, unknown>)?.[
        'autoIndex'
      ] as boolean) ?? false;
    const indexProjectRoot =
      ((api.config.extensions?.['file-watcher'] as Record<string, unknown>)?.[
        'indexProjectRoot'
      ] as string) ?? '';
    // Sandbox: the configured index root must live inside the project.
    // An out-of-project value would route codebase-index reads anywhere
    // on disk; ignore it and warn instead of trusting the config.
    const safeIndexRoot =
      indexProjectRoot !== '' && withinProject(indexProjectRoot) ? indexProjectRoot : '';
    if (indexProjectRoot !== '' && safeIndexRoot === '') {
      api.log.warn(
        'file-watcher: indexProjectRoot is outside the project root — using watched dirPath instead',
        {
          indexProjectRoot,
        },
      );
    }

    const INDEXABLE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx']);

    /**
     * Check if a file path has an indexable extension.
     *
     * Performance: uses Set.has() for O(1) lookup instead of Array.includes() O(n).
     */
    function isIndexableFile(filePath: string): boolean {
      const dot = filePath.lastIndexOf('.');
      const ext = dot >= 0 ? filePath.slice(dot).toLowerCase() : '';
      return INDEXABLE_EXTENSIONS.has(ext);
    }

    function safeWatchDir(dirPath: string, recursive: boolean, handle: WatchHandle): boolean {
      try {
        const watcher = fsWatch(dirPath, { recursive }, (eventType, filename) => {
          if (!filename) return;
          // Filter to the event types the caller requested.  fs.watch
          // reports 'change' and 'rename'; 'rename' maps to the user-facing
          // 'add' / 'delete' slots — a file appears/disappears, so the
          // rename is allowed when EITHER slot is in handle.events.
          if (
            handle.events.length > 0 &&
            !(eventType === 'change'
              ? handle.events.includes('change')
              : handle.events.includes('add') || handle.events.includes('delete'))
          ) {
            return;
          }
          const rawPath = filename.startsWith(dirPath) ? filename : join(dirPath, filename);
          // Normalize to forward slashes for cross-platform consistency in
          // emitted events, logs, and reindex file lists.
          //
          // Determinism: always use forward slashes so event payloads are
          // identical across Windows/Linux/macOS.
          const fullPath = rawPath.replace(/\\/g, '/');
          const key = `${handle.id}:${fullPath}:${eventType}`;
          debounceEvent(
            key,
            () => {
              api.emitCustom('file-watcher:changed', {
                watch_id: handle.id,
                path: fullPath,
                event: eventType,
                filename,
                timestamp: new Date().toISOString(),
              });
              api.metrics.counter('file_change', 1, { event: eventType ?? 'unknown' });
              api.log.debug(`file-watcher: ${eventType} ${fullPath} (watch=${handle.id})`);

              if (autoIndex && isIndexableFile(fullPath)) {
                debounceEvent(
                  `index:${fullPath}`,
                  async () => {
                    try {
                      // Route through the background coordinator (mutex + watchdog +
                      // circuit breaker) — a direct runIndexer call here used to race
                      // the startup scan and per-edit reindexes on the same SQLite file.
                      const { enqueueReindex } = await import('@wrongstack/tools/codebase-index');
                      const root = safeIndexRoot || dirPath;
                      enqueueReindex({
                        projectRoot: root,
                        files: [fullPath],
                        onError: (err: unknown) =>
                          api.log.warn(`file-watcher: auto-index failed for ${fullPath}: ${err}`),
                      });
                      api.metrics.counter('index_file', 1);
                      api.log.debug(`file-watcher: auto-index scheduled for ${fullPath}`);
                    } catch (err) {
                      api.log.warn(`file-watcher: auto-index failed for ${fullPath}: ${err}`);
                    }
                  },
                  debounceMs,
                );
              }
            },
            debounceMs,
          );
        });

        watcher.on('error', (err: unknown) => {
          api.log.warn(`file-watcher: error on ${dirPath}: ${err}`);
        });

        handle.watchers.push(watcher);
        return true;
      } catch (err) {
        api.log.warn(`file-watcher: could not watch ${dirPath}: ${err}`);
        return false;
      }
    }

    // --- watch_start ---
    api.tools.register({
      name: 'watch_start',
      description:
        'Start watching one or more file paths for changes (add, change, delete). Returns a watch ID for stopping the watch later.',
      inputSchema: {
        type: 'object',
        properties: {
          paths: {
            type: 'array',
            items: { type: 'string' },
            maxItems: MAX_PATHS_PER_WATCH,
            description: 'File or directory paths to watch',
          },
          events: {
            type: 'array',
            items: { type: 'string' },
            default: ['change', 'add', 'delete'],
            description: 'Event types to watch for',
          },
          recursive: {
            type: 'boolean',
            default: true,
            description: 'Watch directories recursively',
          },
        },
        required: ['paths'],
      },
      permission: 'confirm',
      category: 'Filesystem',
      mutating: false,
      async execute(input: Record<string, unknown>) {
        const explicitPaths = input['paths'];
        let rawPaths: unknown;
        if (explicitPaths !== undefined) {
          if (!Array.isArray(explicitPaths)) {
            return {
              ok: false,
              error: 'paths must be an array of file/directory paths',
              watch_id: null,
            };
          }
          rawPaths = explicitPaths;
        } else {
          const fallback =
            input['path'] ??
            input['file'] ??
            input['directory'] ??
            input['TargetFile'] ??
            input['filePath'];
          rawPaths = Array.isArray(fallback)
            ? fallback
            : typeof fallback === 'string' && fallback.trim().length > 0
              ? [fallback.trim()]
              : undefined;
        }
        if (!rawPaths || !Array.isArray(rawPaths)) {
          return {
            ok: false,
            error: 'paths must be an array of file/directory paths',
            watch_id: null,
          };
        }
        const paths = [...new Set(rawPaths as string[])];
        if (paths.length === 0) {
          return {
            ok: false,
            error: 'paths array is empty — provide at least one path',
            watch_id: null,
          };
        }
        if (paths.length > MAX_PATHS_PER_WATCH) {
          return {
            ok: false,
            error: `a watch may contain at most ${MAX_PATHS_PER_WATCH} unique paths`,
            watch_id: null,
          };
        }
        if (watches.size >= MAX_WATCH_GROUPS) {
          return {
            ok: false,
            error: `active watch group limit reached (${MAX_WATCH_GROUPS})`,
            watch_id: null,
          };
        }
        const activeFilesystemWatchers = [...watches.values()].reduce(
          (total, handle) => total + handle.watchers.length,
          0,
        );
        if (activeFilesystemWatchers + paths.length > MAX_FILESYSTEM_WATCHERS) {
          return {
            ok: false,
            error: `filesystem watcher limit reached (${MAX_FILESYSTEM_WATCHERS})`,
            watch_id: null,
          };
        }
        const events = (input['events'] as string[] | undefined) ?? ['change', 'add', 'delete'];
        const recursive = (input['recursive'] as boolean | undefined) ?? true;

        // Sandbox: every requested path must resolve inside the project
        // root. Reject the whole call early otherwise — half-attaching
        // some watchers would silently leave unsafe paths unmonitored.
        const bad = paths.find((p) => !withinProject(p));
        if (bad !== undefined) {
          return {
            ok: false,
            error: `path is outside the project root: ${bad}`,
            watch_id: null,
            rejectedOutsideProject: true,
          };
        }

        const id = nextId();
        const handle: WatchHandle = {
          id,
          paths,
          recursive,
          events,
          watchers: [],
          createdAt: new Date().toISOString(),
        };

        const watchedPaths: string[] = [];
        for (const p of paths) {
          if (safeWatchDir(p, recursive, handle)) watchedPaths.push(p);
        }

        // Only report paths for which fs.watch successfully opened a handle.
        // Failed requests are logged by safeWatchDir and must not appear active.
        handle.paths = watchedPaths;

        // The filesystem-watcher budget is enforced by the pre-allocation
        // check above (`activeFilesystemWatchers + paths.length`). safeWatchDir
        // opens at most one FSWatcher per path, so `handle.watchers.length`
        // can never exceed `paths.length` and no post-allocation re-check is
        // reachable here.

        watches.set(id, handle);

        api.metrics.gauge('active_watches', watches.size);

        return {
          ok: true,
          watch_id: id,
          paths: watchedPaths,
          events,
          recursive,
          message: `Started watching ${watchedPaths.length} path(s). Use watch_stop to cancel.`,
        };
      },
    });

    // --- watch_stop ---
    api.tools.register({
      name: 'watch_stop',
      description: 'Stop a file watch by its ID. Releases all resources.',
      inputSchema: {
        type: 'object',
        properties: {
          watch_id: { type: 'string', description: 'Watch ID returned by watch_start' },
        },
        required: ['watch_id'],
      },
      permission: 'auto',
      category: 'Filesystem',
      mutating: false,
      async execute(input: Record<string, unknown>) {
        const rawId = input['watch_id'] ?? input['watchId'] ?? input['id'];
        const watch_id = typeof rawId === 'string' ? rawId.trim() : '';
        const handle = watches.get(watch_id);

        if (!handle) {
          return { ok: false, error: `No active watch with ID: ${watch_id}` };
        }

        for (const w of handle.watchers) {
          try {
            w.close();
          } catch {
            /* ignore — may already be closed */
          }
        }

        // Cancel and remove any pending debounce timers associated with this watch ID
        const prefix = `${watch_id}:`;
        for (const [key, timer] of debounceTimers.entries()) {
          if (key.startsWith(prefix)) {
            clearTimeout(timer);
            debounceTimers.delete(key);
          }
        }

        watches.delete(watch_id);
        api.metrics.gauge('active_watches', watches.size);

        return {
          ok: true,
          watch_id,
          message: `Stopped watch ${watch_id}. ${watches.size} watch(es) remaining.`,
        };
      },
    });

    // --- watch_list ---
    api.tools.register({
      name: 'watch_list',
      description:
        'List all currently active file watches with their IDs, paths, and creation times.',
      inputSchema: { type: 'object', properties: {} },
      permission: 'auto',
      mutating: false,
      async execute() {
        const list = Array.from(watches.values()).map((w) => ({
          id: w.id,
          paths: w.paths,
          events: w.events,
          recursive: w.recursive,
          createdAt: w.createdAt,
          age: `${Date.now() - new Date(w.createdAt).getTime()}ms`,
        }));

        return {
          ok: true,
          count: list.length,
          watches: list,
        };
      },
    });

    api.log.info('file-watcher plugin loaded', { version: '0.1.0' });
  },

  teardown(api) {
    // Close every chokidar.FSWatcher handle and clear every debounce
    // setTimeout. The previous implementation was a documented no-op
    // (the watches Map was in the setup closure and unreachable from
    // teardown), so the only thing that ever cleaned these up was
    // process exit — which is fine for a one-shot run, but leaks
    // during a hot-reload loop or a long-lived REPL session (H1
    // audit, 2026-06-03). With module-level Maps we can finally
    // reach the resources and free them.
    const closed = watches.size;
    for (const handle of watches.values()) {
      for (const w of handle.watchers) {
        try {
          w.close();
        } catch {
          /* ignore — may already be closed */
        }
      }
    }
    watches.clear();
    for (const t of debounceTimers.values()) clearTimeout(t);
    debounceTimers.clear();
    api.log.info('file-watcher: teardown complete', {
      closed,
    });
  },

  async health() {
    const watcherCount = Array.from(watches.values()).reduce(
      (sum, handle) => sum + handle.watchers.length,
      0,
    );
    return {
      ok: true,
      message: `file-watcher: ${watches.size} active watch group(s), ${watcherCount} filesystem watcher(s)`,
      activeWatchGroups: watches.size,
      filesystemWatchers: watcherCount,
      pendingDebounces: debounceTimers.size,
    };
  },
};

export default plugin;
