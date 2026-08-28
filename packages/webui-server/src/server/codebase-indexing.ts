import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Context } from '@wrongstack/core/agent';
import type { EventBus } from '@wrongstack/core/kernel';
import type { IndexingConfig, Logger } from '@wrongstack/core/types';
import {
  DEFAULT_WALK_IGNORE_SET,
  type ProjectWatchSubscription,
  watchProjectTree,
} from '@wrongstack/core/utils';
import {
  cancelPendingReindexes,
  enqueueReindex,
  ensureCodebaseIndexServer,
  isIndexableFile,
  onIndexStateChange,
  runStartupIndex,
  shutdownCodebaseIndexHost,
} from '@wrongstack/tools';
import { clearCodemapGraphCache } from './codemap-cache.js';

const WATCHER_DEDUP_TTL_MS = 60_000;
const WATCHER_DEDUP_MAX_PATHS = 4_096;

interface WebUICodebaseIndexingDeps {
  config: { indexing?: IndexingConfig | undefined };
  context: Context;
  projectRoot: string;
  logger: Logger;
  events?: EventBus | undefined;
}

interface WebUICodebaseIndexing {
  onFileWritten(filePath: string): void;
  dispose(): void;
}

export function setupWebUICodebaseIndexing(deps: WebUICodebaseIndexingDeps): WebUICodebaseIndexing {
  const idx: IndexingConfig | undefined = deps.config.indexing;

  const indexDir =
    typeof deps.context.meta['codebaseIndexDir'] === 'string'
      ? deps.context.meta['codebaseIndexDir']
      : undefined;
  const debounceMs = idx?.debounceMs ?? 400;
  const onError = (err: unknown) => {
    deps.logger.debug(
      `webui codebase auto-index failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  };

  if (idx) {
    void ensureCodebaseIndexServer({
      projectRoot: deps.projectRoot,
      indexDir,
      watchExternal: idx.watchExternal ?? false,
      debounceMs,
    }).catch(onError);
  }

  if (idx?.onSessionStart) {
    void runStartupIndex({
      projectRoot: deps.projectRoot,
      indexDir,
      signal: deps.context.signal,
      timeoutMs: idx.indexTimeoutMs,
    })
      .then((result) => {
        deps.logger.info(
          `webui codebase index ready: ${result.symbolsIndexed} symbols · ${result.filesIndexed} files · ${result.durationMs}ms`,
        );
      })
      .catch((err) => {
        deps.logger.warn(
          `webui codebase index (startup) failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }

  let watcher: ProjectWatchSubscription | undefined;
  const lastWatcherEvent = new Map<string, number>();
  if (deps.events) {
    try {
      // Shares the process-wide recursive watcher with any other subscriber
      // on the same root instead of opening a second OS-level tree watch.
      // Emitted async: a rename needs an access() probe to tell delete from edit.
      const emitActivity = async (
        abs: string,
        eventType: 'rename' | 'change',
        now: number,
      ): Promise<void> => {
        let operation: 'delete' | 'edit' = 'edit';
        if (eventType === 'rename') {
          try {
            await fs.promises.access(abs);
          } catch {
            operation = 'delete';
          }
        }
        deps.events?.emit('file.activity', {
          filePath: path.normalize(abs),
          operation,
          phase: 'changed',
          source: 'watcher',
          at: now,
        });
      };
      watcher = watchProjectTree(
        deps.projectRoot,
        ({ eventType, filename }) => {
          if (!filename) return;
          const rel = filename;
          if (isIgnored(rel)) return;
          const abs = path.resolve(deps.projectRoot, rel);
          if (!isInside(deps.projectRoot, abs) || !isIndexableFile(abs)) return;
          const now = Date.now();
          const previousEventAt = lastWatcherEvent.get(abs) ?? 0;
          if (now - previousEventAt > 75) {
            // Treat the map as a small LRU and opportunistically evict expired
            // paths. Generated files can otherwise leave one permanent entry per
            // unique filename in a long-running WebUI process.
            lastWatcherEvent.delete(abs);
            lastWatcherEvent.set(abs, now);
            if (lastWatcherEvent.size > WATCHER_DEDUP_MAX_PATHS) {
              for (const [cachedPath, seenAt] of lastWatcherEvent) {
                if (now - seenAt > WATCHER_DEDUP_TTL_MS) lastWatcherEvent.delete(cachedPath);
              }
              while (lastWatcherEvent.size > WATCHER_DEDUP_MAX_PATHS) {
                const oldest = lastWatcherEvent.keys().next().value;
                if (oldest === undefined) break;
                lastWatcherEvent.delete(oldest);
              }
            }
            void emitActivity(abs, eventType, now).catch((err) =>
              deps.logger.debug(`webui codebase index watcher error: ${err}`),
            );
          }
          // External reindexing is owned by the detached project server. This
          // local shared watcher exists only to publish file.activity telemetry.
        },
        { onError: (err) => deps.logger.debug(`webui codebase index watcher error: ${err}`) },
      );
    } catch (err) {
      deps.logger.debug(
        `webui codebase index watcher unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  function enqueueFile(filePath: string): void {
    if (!idx || (!idx.onEdit && !idx.watchExternal)) return;
    const abs = path.isAbsolute(filePath)
      ? path.normalize(filePath)
      : path.resolve(deps.projectRoot, filePath);
    if (!isInside(deps.projectRoot, abs) || !isIndexableFile(abs)) return;
    enqueueReindex({
      projectRoot: deps.projectRoot,
      files: [abs],
      indexDir,
      debounceMs,
      timeoutMs: idx.indexTimeoutMs,
      onError,
    });
  }

  // Drop CodeMap graph cache + notify clients when an index run finishes so
  // package/file/symbol maps pick up new symbols without a process restart.
  // mtime-versioned cache is the safety net; this is the proactive path.
  let wasIndexing = false;
  const unsubscribeIndexState = onIndexStateChange((state) => {
    if (wasIndexing && !state.indexing) {
      clearCodemapGraphCache();
      deps.events?.emit('codemap.index_updated', {
        at: Date.now(),
        ready: state.ready,
        reason: 'index_complete',
      });
      deps.logger.debug(`webui codemap cache invalidated after index run (ready=${state.ready})`);
    }
    wasIndexing = state.indexing;
  });

  return {
    onFileWritten(filePath) {
      const abs = path.isAbsolute(filePath)
        ? path.normalize(filePath)
        : path.resolve(deps.projectRoot, filePath);
      deps.events?.emit('file.activity', {
        filePath: abs,
        operation: 'write',
        phase: 'completed',
        source: 'editor',
        at: Date.now(),
        sessionId: deps.context.session?.id,
        agentId: 'webui-editor',
        agentName: 'WebUI Editor',
      });
      if (idx?.onEdit) enqueueFile(abs);
    },
    dispose() {
      unsubscribeIndexState();
      lastWatcherEvent.clear();
      try {
        watcher?.close();
      } catch {
        /* ignore */
      }
      if (idx) {
        cancelPendingReindexes();
        void shutdownCodebaseIndexHost();
      }
    },
  };
}

function isIgnored(rel: string): boolean {
  return rel.split(/[/\\]/).some((seg) => DEFAULT_WALK_IGNORE_SET.has(seg));
}

function isInside(root: string, target: string): boolean {
  const normalizedRoot = path.resolve(root);
  const normalizedTarget = path.resolve(target);
  return (
    normalizedTarget === normalizedRoot || normalizedTarget.startsWith(normalizedRoot + path.sep)
  );
}
