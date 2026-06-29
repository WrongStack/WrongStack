import {
  type Container,
  type Logger,
  type ProviderRunner,
  ReplayLogStore,
  type ReplayMode,
  ReplayProviderRunner,
  runProviderWithRetry,
  TOKENS,
  type WstackPaths,
} from '@wrongstack/core';

/**
 * Bind a `ReplayProviderRunner` into the container under
 * `TOKENS.ProviderRunner`. The agent picks this up at construction
 * time and uses the wrapped runner for every LLM call.
 *
 * Three modes are exposed via the `mode` parameter:
 *
 *   - 'record' — every real API call is persisted. Used in
 *     production-like runs to build a replay log that can later
 *     be re-exercised in dev / CI.
 *   - 'replay' — only the log is consulted. The inner runner is
 *     never called. Useful for deterministic regression tests
 *     and offline debugging.
 *   - 'auto' — record on miss, serve on hit. This is the
 *     "warm start" mode for dev iterations: the first time a
 *     particular request is seen, it is recorded; subsequent
 *     identical requests are served from the log.
 *
 * The log lives next to the session JSONL via
 * `sessionScopedPath(projectSessions, sessionId, '.replay.jsonl')`,
 * colocated with annotations and audit sidecars.
 */
export interface BindReplayOptions {
  container: Container;
  wpaths: WstackPaths;
  sessionId: string;
  mode: ReplayMode;
  logger?: Logger | undefined;
}

export function bindReplayToContainer(opts: BindReplayOptions): void {
  const { container, wpaths, sessionId, mode, logger } = opts;
  if (!opts.container.has(TOKENS.ProviderRunner)) {
    // No prior binding — install the default `runProviderWithRetry`
    // first so the replay wrapper has a real inner to delegate to.
    container.bind(
      TOKENS.ProviderRunner,
      () =>
        ({
          run: (o) => runProviderWithRetry(o),
        }) satisfies ProviderRunner,
    );
  }
  const inner = container.resolve(TOKENS.ProviderRunner);
  const log = new ReplayLogStore({ dir: wpaths.projectSessions });
  const wrapped = new ReplayProviderRunner(inner, {
    log,
    sessionId,
    mode,
    logger: logger
      ? {
          debug: (m) => logger.debug?.(m),
          warn: (m) => logger.warn?.(m),
        }
      : undefined,
  });
  // Re-bind to override the just-installed default with the wrapped
  // version. Container's `bind` is replace-by-default; if a project's
  // container disallows rebinding, callers should use a decorator
  // pattern via `AgentExtension.wrapProviderRunner` instead.
  container.bind(TOKENS.ProviderRunner, () => wrapped);
}
