/**
 * Granular subpath for the session-shell resolver.
 *
 * The CLI's boot-path `preflight.ts` needs exactly one symbol from this
 * module (`ensureSessionShell`) on the fast path that every `wstack`
 * invocation runs — including `--version`. Importing it from the
 * `@wrongstack/tools` barrel eagerly loads the whole tools entry graph
 * (~81 modules) for that one call; this subpath keeps the same public
 * symbol reachable without the barrel (round cli-sessionshell-r1).
 */
export { ensureSessionShell } from './_session-shell.js';
