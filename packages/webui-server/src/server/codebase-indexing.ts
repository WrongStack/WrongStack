import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Context, EventBus, IndexingConfig, Logger } from '@wrongstack/core';
import {
  cancelPendingReindexes,
  enqueueReindex,
  isIndexableFile,
  runStartupIndex,
  shutdownCodebaseIndexHost,
} from '@wrongstack/tools';

const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'coverage',
  '.turbo',
  '__snapshots__',
  '.nyc_output',
]);

export interface WebUICodebaseIndexingDeps {
  config: { indexing?: IndexingConfig | undefined };
  context: Context;
  projectRoot: string;
  logger: Logger;
  events?: EventBus | undefined;
}

export interface WebUICodebaseIndexing {
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

  let watcher: fs.FSWatcher | undefined;
  const lastWatcherEvent = new Map<string, number>();
  if (idx?.watchExternal || deps.events) {
    try {
      watcher = fs.watch(deps.projectRoot, { recursive: true }, (eventType, filename) => {
        if (!filename) return;
        const rel = filename.toString();
        if (isIgnored(rel)) return;
        const abs = path.resolve(deps.projectRoot, rel);
        if (!isInside(deps.projectRoot, abs) || !isIndexableFile(abs)) return;
        const now = Date.now();
        if (now - (lastWatcherEvent.get(abs) ?? 0) > 75) {
          lastWatcherEvent.set(abs, now);
          deps.events?.emit('file.activity', {
            filePath: path.normalize(abs),
            operation: eventType === 'rename' && !fs.existsSync(abs) ? 'delete' : 'edit',
            phase: 'changed',
            source: 'watcher',
            at: now,
          });
        }
        // Only reindex on external filesystem changes when the user opted into
        // it. The watcher itself always runs (codemap telemetry above needs the
        // `file.activity` stream), but with `watchExternal:false` a user who
        // asked to index only their own edits must not have build tools, git
        // checkouts, or other agents trigger continuous reindex churn. The
        // editor-write path below stays gated on `onEdit` separately.
        if (idx?.watchExternal) enqueueFile(abs);
      });
      watcher.on('error', (err) => deps.logger.debug(`webui codebase index watcher error: ${err}`));
      watcher.unref?.();
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
      try {
        watcher?.close();
      } catch {
        /* ignore */
      }
      if (idx) {
        cancelPendingReindexes();
        shutdownCodebaseIndexHost();
      }
    },
  };
}

function isIgnored(rel: string): boolean {
  return rel.split(/[/\\]/).some((seg) => IGNORE_DIRS.has(seg));
}

function isInside(root: string, target: string): boolean {
  const normalizedRoot = path.resolve(root);
  const normalizedTarget = path.resolve(target);
  return (
    normalizedTarget === normalizedRoot || normalizedTarget.startsWith(normalizedRoot + path.sep)
  );
}
