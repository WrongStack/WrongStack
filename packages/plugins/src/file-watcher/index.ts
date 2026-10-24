/**
 * file-watcher plugin — Watches project files and triggers actions on changes.
 *
 * Tools registered:
 * - watch_start: Start watching paths for file changes
 * - watch_stop: Stop a watch by ID
 * - watch_list: List all active watches
 */

import { watch as fsWatch, statSync } from 'node:fs';
import { join } from 'node:path';
import { type Plugin, ToolValidationError } from '@wrongstack/contracts/types';
import { createHostStates } from '../runtime/host-state.js';
import { safePath } from '../runtime/sandbox.js';

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

const hosts = createHostStates(
  () => ({
    abort: new AbortController(),
    extensionUnregister: null as (() => void) | null,
    watches: new Map<string, WatchHandle>(),
    debounceTimers: new Map<string, ReturnType<typeof setTimeout>>(),
  }),
  (state) => {
    for (const handle of state.watches.values())
      for (const watcher of handle.watchers) {
        try {
          watcher.close();
        } catch {
          /* Already closed by the host. */
        }
      }
    state.watches.clear();
    for (const timer of state.debounceTimers.values()) clearTimeout(timer);
    state.debounceTimers.clear();
  },
);

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
      // ON by default (behaviour change, 2026-10-05).
      //
      // This block was inert for its whole life: the dep-watcher bridge is
      // wired from `config.extensions['file-watcher']`, which the loader does
      // NOT merge into — `defaultConfig` only reaches `opts.pluginOptions`
      // (loader.ts:417). With `enabled: false` here and no user override, the
      // CLI gate read an absent config and never armed, so no filesystem watch
      // was ever established on the dependency manifests. The pipeline was
      // fully wired and permanently dormant.
      //
      // It is now live: an edit to package.json / go.mod / Cargo.toml / … wakes
      // the tech-stack audit. Opt back out with
      // `extensions."file-watcher".depWatcher.enabled = false`.
      enabled: true,
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
        default: { enabled: true, targetAgent: 'tech-stack', debounceMs: 3000 },
        description:
          'Bridge dependency file changes (package.json, go.mod, etc.) to the inter-agent mailbox for tech-stack audits. Enabled by default since 2026-10-05 — set enabled:false to opt out. Requires the mailbox tool to be registered.',
        properties: {
          enabled: { type: 'boolean', default: true },
          targetAgent: { type: 'string', default: 'tech-stack' },
          debounceMs: { type: 'number', default: 3000 },
        },
      },
    },
  },

  setup(api) {
    const state = hosts.reset(api);
    const { watches, debounceTimers } = state;

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

    function safeWatchDir(
      dirPath: string,
      recursive: boolean,
      handle: WatchHandle,
      safeIndexRoot: string | null,
    ): boolean {
      try {
        // A single-file watch reports the file's BASE NAME as `filename`
        // (platform behavior on win32/linux/macOS), so join() below would
        // emit a doubled "<file>/<basename>" path. Every event on a
        // file-watch handle is about the watched file itself. The stat is
        // advisory only — a failure falls through to the join semantics and
        // leaves fs.watch below as the authoritative existence check.
        let watchedIsFile = false;
        try {
          watchedIsFile = statSync(dirPath).isFile();
        } catch {
          /* fall through to directory semantics */
        }
        const watcher = fsWatch(dirPath, { recursive }, (eventType, filename) => {
          if (state.abort.signal.aborted || watches.get(handle.id) !== handle || !filename) return;
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
          const rawPath = watchedIsFile
            ? dirPath
            : filename.startsWith(dirPath)
              ? filename
              : join(dirPath, filename);
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
              if (state.abort.signal.aborted || watches.get(handle.id) !== handle) return;
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
                  `${handle.id}:index:${fullPath}`,
                  async () => {
                    try {
                      // Route through the background coordinator (mutex + watchdog +
                      // circuit breaker) — a direct runIndexer call here used to race
                      // the startup scan and per-edit reindexes on the same SQLite file.
                      const { enqueueReindex } = await import('@wrongstack/tools/codebase-index');
                      if (state.abort.signal.aborted || watches.get(handle.id) !== handle) return;
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
      async execute(input: Record<string, unknown>, _ctx, options) {
        state.abort.signal.throwIfAborted();
        options?.signal?.throwIfAborted();
        const explicitPaths = input['paths'];
        let rawPaths: unknown;
        if (explicitPaths !== undefined) {
          if (!Array.isArray(explicitPaths)) {
            throw new ToolValidationError({
              message: 'paths must be an array of file/directory paths',
              field: 'paths',
            });
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
          throw new ToolValidationError({
            message: 'paths must be an array of file/directory paths',
            field: 'paths',
          });
        }
        if (
          !rawPaths.every((candidate) =>
            typeof candidate === 'string' ? candidate.trim().length > 0 : false,
          )
        ) {
          throw new ToolValidationError({
            message: 'paths must contain only non-empty strings',
            field: 'paths',
          });
        }
        const paths = [...new Set(rawPaths as string[])];
        if (paths.length === 0) {
          throw new ToolValidationError({
            message: 'paths array is empty — provide at least one path',
            field: 'paths',
          });
        }
        if (paths.length > MAX_PATHS_PER_WATCH) {
          throw new ToolValidationError({
            message: `a watch may contain at most ${MAX_PATHS_PER_WATCH} unique paths`,
            field: 'paths',
          });
        }
        if (watches.size >= MAX_WATCH_GROUPS) {
          throw new Error(
            `active watch group limit reached (${MAX_WATCH_GROUPS}); stop a watch with watch_stop first`,
          );
        }
        const activeFilesystemWatchers = [...watches.values()].reduce(
          (total, handle) => total + handle.watchers.length,
          0,
        );
        if (activeFilesystemWatchers + paths.length > MAX_FILESYSTEM_WATCHERS) {
          throw new Error(
            `filesystem watcher limit reached (${MAX_FILESYSTEM_WATCHERS}); stop a watch with watch_stop first`,
          );
        }
        const events = (input['events'] as string[] | undefined) ?? ['change', 'add', 'delete'];
        const recursive = (input['recursive'] as boolean | undefined) ?? true;

        // Sandbox: every requested path must resolve inside the project
        // root. Reject the whole call early otherwise — half-attaching
        // some watchers would silently leave unsafe paths unmonitored.
        const projectRoot = _ctx?.projectRoot ?? _ctx?.cwd ?? api.config.cwd ?? process.cwd();
        const resolvedPaths = new Map(paths.map((path) => [path, safePath(path, { projectRoot })]));
        const bad = paths.find((p) => !resolvedPaths.get(p));
        if (bad !== undefined) {
          throw new ToolValidationError({
            message: `path is outside the project root: ${bad}`,
            field: 'paths',
          });
        }

        const safeIndexRoot = indexProjectRoot ? safePath(indexProjectRoot, { projectRoot }) : null;
        if (indexProjectRoot && !safeIndexRoot) {
          api.log.warn(
            'file-watcher: indexProjectRoot is outside the project root — using watched dirPath instead',
            { indexProjectRoot },
          );
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
        const failedPaths: string[] = [];
        for (const p of paths) {
          if (safeWatchDir(resolvedPaths.get(p)!, recursive, handle, safeIndexRoot))
            watchedPaths.push(p);
          else failedPaths.push(p);
        }

        // Nothing could be watched: no watch exists, so this is a failure.
        if (watchedPaths.length === 0) {
          throw new Error(
            `could not watch any of the requested paths: ${failedPaths.join(', ')} (missing path or OS watcher limit)`,
          );
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
          ...(failedPaths.length > 0 ? { failedPaths } : {}),
          events,
          recursive,
          message:
            `Started watching ${watchedPaths.length} path(s). Use watch_stop to cancel.` +
            (failedPaths.length > 0 ? ` Could not watch: ${failedPaths.join(', ')}.` : ''),
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
      async execute(input: Record<string, unknown>, _ctx, options) {
        state.abort.signal.throwIfAborted();
        options?.signal?.throwIfAborted();
        const rawId = input['watch_id'] ?? input['watchId'] ?? input['id'];
        const watch_id = typeof rawId === 'string' ? rawId.trim() : '';
        const handle = watches.get(watch_id);

        if (!handle) {
          throw new Error(`No active watch with ID: ${watch_id}`);
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
    const closed = hosts.get(api)?.watches.size ?? 0;
    const state = hosts.remove(api);
    if (!state) return;
    api.log.info('file-watcher: teardown complete', { closed });
  },

  async health() {
    const active = [...hosts.values()];
    const watches = active.flatMap((state) => [...state.watches.values()]);
    const watcherCount = watches.reduce((sum, handle) => sum + handle.watchers.length, 0);
    return {
      ok: true,
      message: `file-watcher: ${watches.length} active watch group(s), ${watcherCount} filesystem watcher(s)`,
      activeWatchGroups: watches.length,
      filesystemWatchers: watcherCount,
      pendingDebounces: active.reduce((sum, state) => sum + state.debounceTimers.size, 0),
    };
  },
};

export default plugin;
