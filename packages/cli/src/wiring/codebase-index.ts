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
import type { IndexingConfig, Logger } from '@wrongstack/contracts/types';
import type { AgentPipelines, Context, ToolCallPipelinePayload } from '@wrongstack/core/agent';
import {
  cancelPendingReindexes,
  enqueueReindex,
  ensureCodebaseIndexServer,
  isIndexableFile,
  runStartupIndex,
  setContextQueryEmbedder,
  shutdownCodebaseIndexHost,
} from '@wrongstack/tools';
import { createCodebaseEmbeddingPort } from './codebase-embeddings.js';

/**
 * Project files a successful file-changing tool call wrote, resolved against
 * `cwd`. Only `write`/`edit` were handled, so `codebase-ast-replace`, `patch`
 * and `format` left the index describing the pre-edit code until a restart
 * (external watching is off by default) — incoming calls and impact analysis
 * then answered for a function body that no longer existed.
 */
export function editedFilePaths(toolName: string, input: unknown, cwd: string): string[] {
  const args = (input ?? {}) as Record<string, unknown>;
  const resolve = (value: unknown, base = cwd): string[] =>
    typeof value === 'string' && value.length > 0 ? [path.resolve(base, value)] : [];
  switch (toolName) {
    case 'write':
    case 'edit':
      return resolve(args['path']);
    case 'codebase-ast-replace':
      return resolve(args['file']);
    case 'format': {
      if (args['check'] === true) return [];
      const files = args['files'];
      const base = typeof args['cwd'] === 'string' ? path.resolve(cwd, args['cwd']) : cwd;
      // A project-wide format names no files; the watcher or next startup run covers it.
      return (Array.isArray(files) ? files : [files]).flatMap((file) => resolve(file, base));
    }
    case 'patch': {
      if (args['dry_run'] === true || typeof args['patch'] !== 'string') return [];
      const base =
        typeof args['directory'] === 'string' ? path.resolve(cwd, args['directory']) : cwd;
      const strip = typeof args['strip'] === 'number' ? args['strip'] : 1;
      const out = new Set<string>();
      for (const match of args['patch'].matchAll(/^(?:\+\+\+|---) ([^\t\r\n]+)/gm)) {
        const header = (match[1] ?? '').trim().replace(/^"(.*)"$/, '$1');
        if (!header || header === '/dev/null') continue;
        const stripped = header.split('/').slice(strip).join('/');
        if (stripped) out.add(path.resolve(base, stripped));
      }
      return [...out];
    }
    default:
      return [];
  }
}

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

  // Semantic retrieval needs a model on the HOST: a function cannot cross the
  // daemon's IPC boundary, so the host embeds the query and only the resulting
  // numbers travel. Loading it is deliberately not awaited — a first-run model
  // download must never delay the prompt, and until it resolves retrieval
  // simply stays lexical, which is what shipped before embeddings existed.
  void createCodebaseEmbeddingPort(idx.embeddings)
    .then((port) => {
      if (port !== undefined) {
        setContextQueryEmbedder(port);
        logger.debug(`codebase semantic retrieval ready (${port.id})`);
      }
    })
    .catch(onError);

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
          if (tool && !payload.result.is_error) {
            const activeRoot = payload.ctx.projectRoot;
            const files = editedFilePaths(tool.name, payload.toolUse.input, payload.ctx.cwd).filter(
              (abs) => {
                const rel = path.relative(activeRoot, abs);
                const inside =
                  rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
                return inside && isIndexableFile(abs);
              },
            );
            if (files.length > 0) {
              enqueueReindex({ projectRoot: activeRoot, files, debounceMs, onError });
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
