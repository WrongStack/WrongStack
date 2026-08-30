/**
 * Shared Vitest worker cap — imported by every vitest/vite config in this repo.
 *
 * Why this exists at all: at Vitest's default (`maxWorkers` = all logical cores,
 * 32 on the main development machine) spawn-heavy tests starve. Tests here shell
 * out to bash/git/biome/tree-kill and boot mock servers, so the workers compete
 * with the processes those workers spawn: every `release:check` run failed a
 * different set of files with empty output, wrong exit codes, or timeouts while
 * each passed in isolation. Live dev servers share the machine too.
 *
 * Why it is a function and not a constant: the right cap depends on the mode.
 * A single run wants throughput (four workers still leave headroom for
 * test-spawned shells); watch mode wants to stay responsive while editing and
 * only ever re-runs a handful of files, so two workers is plenty and keeps the
 * remaining cores free for the editor and dev servers.
 *
 * Mode is read off the Vitest CLI argv rather than an env var so a plain
 * `vitest` / `vitest run` needs no extra wiring. Configs are loaded in the main
 * process, so `process.argv` there is the real command line.
 */

/** Argv tokens that put Vitest in watch mode. */
const WATCH_ARGS = new Set(['--watch', '-w', '--watch=true']);

/** Argv tokens that put Vitest in single-run mode. */
const RUN_ARGS = new Set(['run', '--run', '--run=true', '--watch=false']);

/** Workers for watch mode — also the default when the mode is not stated. */
const WATCH_MAX_WORKERS = 2;

/** Workers for a single run. */
const RUN_MAX_WORKERS = 4;

/**
 * Resolve the `test.maxWorkers` cap for the current Vitest invocation.
 *
 * Watch wins over run when both appear (`vitest run --watch`): the interactive
 * intent is the one that must not hog the machine. An unrecognized or empty
 * argv is treated as watch, matching bare `vitest`, which watches by default.
 *
 * @param argv Vitest CLI arguments; defaults to this process's arguments.
 */
export function getVitestMaxWorkers(argv: string[] = process.argv.slice(2)): number {
  // Explicit env override wins over both mode defaults: local group sweeps
  // (e.g. WRONGSTACK_VITEST_MAX_WORKERS=8 pnpm exec vitest run ...) opt in to
  // more workers for import-heavy runs without touching the release-safe
  // defaults below. Invalid or non-positive values fall through.
  const override = Number(process.env.WRONGSTACK_VITEST_MAX_WORKERS);
  if (Number.isInteger(override) && override >= 1) {
    return override;
  }
  if (argv.some((arg) => WATCH_ARGS.has(arg))) {
    return WATCH_MAX_WORKERS;
  }
  if (argv.some((arg) => RUN_ARGS.has(arg))) {
    return RUN_MAX_WORKERS;
  }
  return WATCH_MAX_WORKERS;
}
