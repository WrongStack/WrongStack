import type { Context } from './context.js';
import type { RunEnv } from '../types/run-env.js';

/**
 * Immutable run environment — the set-once dependencies for an agent run.
 *
 * `Context` today doubles as both a DI bag (provider, session, tokenCounter,
 * cwd, …) and a mutable state container (messages, todos, meta). That makes
 * it hard to test (every test reconstructs the full bag) and easy to abuse
 * (any tool can swap the provider mid-run).
 *
 * `RunEnv` is the immutable half: a read-only projection that subsystems
 * can hold instead of the whole `Context`. It's a view, not a copy — pulling
 * a `RunEnv` from a `Context` is O(1) and reflects the same underlying
 * references. The opposite direction (set things on Context) still works,
 * and `extractRunEnv` rebuilds the view if you need a snapshot.
 *
 * Roadmap 10A: the interface itself now lives in `types/run-env.ts` (a
 * dependency leaf that never imports `core/`), so the type module graph
 * stays acyclic; this module keeps `extractRunEnv` and re-exports the
 * interface for existing import paths.
 *
 * Migration path: new APIs accept `RunEnv` instead of `Context` when they
 * only need read access. Existing APIs continue to accept `Context` until
 * a full split is scheduled.
 */
export type { RunEnv } from '../types/run-env.js';

export function extractRunEnv(ctx: Context): RunEnv {
  return Object.freeze({
    provider: ctx.provider,
    session: ctx.session,
    signal: ctx.signal,
    tokenCounter: ctx.tokenCounter,
    cwd: ctx.cwd,
    projectRoot: ctx.projectRoot,
    workingDir: ctx.workingDir,
    model: ctx.model,
    systemPrompt: ctx.systemPrompt,
    tools: ctx.tools,
    agentId: ctx.agentId,
    agentName: ctx.agentName,
  });
}
