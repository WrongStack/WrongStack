/**
 * Automatic codebase-index wiring.
 *
 * Keeps the `codebase-search` symbol index fresh without the user ever calling
 * `codebase-index` by hand. Three behaviors, each gated by `config.indexing`:
 *
 *   1. onSessionStart — a blocking incremental index at boot, with a visible
 *      one-line summary (the "show").
 *   2. onEdit         — a `toolCall` middleware that reindexes files the agent
 *      writes/edits via tools, in the background (debounced).
 *   3. watchExternal  — an `fs.watch` on the project root that reindexes files
 *      changed outside the agent (e.g. the user's editor).
 *
 * All three funnel through `@wrongstack/tools`' background indexer, which
 * serializes every run on one mutex (the SQLite writer is synchronous, so
 * concurrent runs would risk `SQLITE_BUSY`) and debounces per file.
 */

import * as path from 'node:path';
import type { AgentPipelines, Context, ToolCallPipelinePayload } from '@wrongstack/core/agent';
import type { IndexingConfig, Logger } from '@wrongstack/core/types';
import {
  cancelPendingReindexes,
  enqueueReindex,
  ensureCodebaseIndexServer,
  isIndexableFile,
  runStartupIndex,
  shutdownCodebaseIndexHost,
} from '@wrongstack/tools';

/** Mutating builtin tools whose input carries a single `path`. */
const FILE_EDIT_TOOLS = new Set(['write', 'edit']);

interface CodebaseIndexingDeps {
  config: { indexing?: IndexingConfig | undefined };
  context: Context;
  pipelines: AgentPipelines;
  projectRoot: string;
  logger: Logger;
}

/**
 * Wire up automatic indexing. Returns a `dispose()` that stops the watcher and
 * cancels pending reindexes — call it on process teardown.
 */
export async function setupCodebaseIndexing(deps: CodebaseIndexingDeps): Promise<() => void> {
  const { config, context, pipelines, projectRoot, logger } = deps;
  const idx = config.indexing;
  // No config block (e.g. --bare) → opt out entirely.
  if (!idx) return () => {};

  const debounceMs = idx.debounceMs ?? 400;
  const onError = (err: unknown) =>
    logger.debug(`codebase auto-index failed: ${err instanceof Error ? err.message : String(err)}`);

  // The first client starts the detached per-project server; later TUI/CLI/
  // WebUI processes connect to the same endpoint. External watching lives in
  // that server so one project never opens one index watcher per surface.
  void ensureCodebaseIndexServer({
    projectRoot,
    watchExternal: idx.watchExternal ?? false,
    debounceMs,
  }).catch(onError);

  // 1. Background startup index. The prompt is available immediately; the
  //    index runs asynchronously and the TUI already tracks progress via
  //    getIndexState()/onIndexStateChange() — the status bar chip "⚙ indexing
  //    N/M" appears during the build and disappears when it finishes.
  //    We must NOT write directly to stderr here because it bypasses Ink's
  //    rendering and pushes the input area into native scrollback history.
  if (idx.onSessionStart) {
    void runStartupIndex({ projectRoot, signal: context.signal, timeoutMs: idx.indexTimeoutMs })
      .then((r) => {
        logger.info(
          `codebase index ready: ${r.symbolsIndexed} symbols · ${r.filesIndexed} files · ${r.durationMs}ms`,
        );
      })
      .catch((err) => {
        logger.warn(
          `codebase index (startup) failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }

  // 2. Reindex agent tool edits.
  if (idx.onEdit) {
    pipelines.toolCall.use({
      name: 'CodebaseAutoIndex',
      // Non-core owner → the pipeline error boundary swallows failures instead
      // of failing the turn (see wiring/pipeline.ts).
      owner: 'codebase-index',
      handler: async (
        payload: ToolCallPipelinePayload,
        next: (v: ToolCallPipelinePayload) => Promise<ToolCallPipelinePayload>,
      ) => {
        try {
          const tool = payload.tool;
          if (tool?.mutating && FILE_EDIT_TOOLS.has(tool.name) && !payload.result.is_error) {
            const fp = (payload.toolUse.input as { path?: unknown | undefined })?.path;
            if (typeof fp === 'string' && fp.length > 0) {
              const activeRoot = payload.ctx.projectRoot;
              const abs = path.resolve(payload.ctx.cwd, fp);
              const rel = path.relative(activeRoot, abs);
              const inside =
                rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
              if (inside && isIndexableFile(abs)) {
                enqueueReindex({ projectRoot: activeRoot, files: [abs], debounceMs, onError });
              }
            }
          }
        } catch {
          // Never let index bookkeeping interfere with the tool result.
        }
        return next(payload);
      },
    });
  }

  // Reference context so the binding is used even when onEdit is off (keeps the
  // dependency explicit; ctx.cwd is read inside the middleware).
  void context;

  return () => {
    cancelPendingReindexes();
    // Disconnect only this host. The detached project server remains available
    // to other surfaces and exits on its own idle timeout.
    void shutdownCodebaseIndexHost();
  };
}
