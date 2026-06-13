// Side-effect orchestration that runs *after* `boot()` and *before*
// any heavy subsystem (mailbox, autonomy, brain, eternal engine,
// webui) is constructed. PR 2 of Issue #29 extracts these from
// the 2,300-line `main()` body so the post-help-short-circuit
// flow reads as:
//
//   if (--help) return help();
//   const ctx = await boot(argv);
//   if (typeof ctx === 'number') return ctx;
//   const pre = await preflight(ctx.config, ctx.updateInfo);  // <-- this module
//   ctx.updateInfo = pre.updateInfo;
//   // ... rest of main() with the side effects already applied
//
// The four operations live here, in order:
//
//   1. `applyNodeEnvDefault()` \u2014 default to React/Ink PRODUCTION
//      builds when NODE_ENV is unset. Must run before the lazy
//      `--tui` import evaluates ink/react. Explicit user/test
//      overrides win (vitest sets NODE_ENV=test). The marker
//      flag lets `buildChildEnv()` strip the injected value from
//      child processes \u2014 a leaked NODE_ENV=production would
//      make `pnpm install` skip devDependencies and flip
//      test-runner behavior.
//
//   2. `applyPrintUpdateNotice(info)` \u2014 best-effort update
//      notification. Never blocks boot (2-second timeout). The
//      result supersedes the initial `updateInfo` so the
//      version-aware UI (slash bar, release-notice on the TUI
//      status line) can use it without re-fetching.
//
//   3. `applyDebugStreamSeed(config)` \u2014 seed the stream-debug
//      singleton from persisted config so `WireAdapter` picks
//      it up on construction. Runtime toggles update this
//      singleton directly; the config file is the source of
//      truth for restarts. The default debug-stream callback
//      is intentionally left unset \u2014 the TUI installs its
//      own reducer-bound callback, and in REPL/headless mode
//      stderr output from the default callback would
//      interfere with the readline prompt and flood the
//      terminal. Data is still collected (and accessible via
//      /diag-stats) but not dumped to the console.
//
// The `runPreflight()` orchestrator wraps all three so the
// caller doesn't have to remember the order, and so the order
// is documented in one place (here) instead of at the top of
// every test that needs to set up a fake `BootContext`.

import type { Config } from '@wrongstack/core';
import type { UpdateInfo } from './update-check.js';
import { printUpdateNotice } from './cli-update-notice.js';

export interface PreflightResult {
  /** The (possibly refreshed) update info, after the 2-second
   *  quick-check. Undefined if the check was aborted. */
  updateInfo: UpdateInfo | undefined;
  /** Whether `setDebugStreamEnabled(true)` was called. Callers
   *  don't need this today, but exporting it makes the
   *  orchestrator's effect explicit. */
  debugStreamEnabled: boolean;
}

/**
 * Default `NODE_ENV=production` when unset, so the React/Ink
 * `react-reconciler.development.js` path (which ticks
 * `performance.measure()` per render and leaks ~200 user-timing
 * entries/sec into Node's global timeline) is never picked.
 *
 * Must run before the lazy `--tui` import evaluates ink/react.
 * The marker flag lets `buildChildEnv()` strip the injected
 * value from child processes \u2014 a leaked `NODE_ENV=production`
 * would make `pnpm install` skip devDependencies and flip
 * test-runner behavior.
 */
export function applyNodeEnvDefault(): void {
  if (process.env['NODE_ENV'] === undefined) {
    process.env['NODE_ENV'] = 'production';
    process.env['WRONGSTACK_NODE_ENV_DEFAULTED'] = '1';
  }
}

/**
 * Best-effort `printUpdateNotice()` wrapper. The 2-second
 * quick-check is a network call that must not block boot;
 * callers get back the (possibly refreshed) `UpdateInfo`
 * so version-aware UI can render without re-fetching.
 */
export async function applyPrintUpdateNotice(
  initialUpdateInfo: UpdateInfo | undefined,
): Promise<UpdateInfo | undefined> {
  return await printUpdateNotice(initialUpdateInfo);
}

/**
 * Seed the stream-debug singleton from persisted config so
 * `WireAdapter` picks it up on construction. Runtime toggles
 * (e.g. `/diag-stats stream-debug on`) update this singleton
 * directly; the config file is the source of truth for
 * restarts. The default debug-stream callback is intentionally
 * left unset \u2014 see the module-level docstring for why.
 */
export async function applyDebugStreamSeed(config: Config): Promise<void> {
  const { setDebugStreamEnabled } = await import('@wrongstack/providers');
  if (config.debugStream) {
    setDebugStreamEnabled(true);
  }
}

/**
 * Apply every pre-boot side effect, in dependency order. Returns
 * the (possibly refreshed) update info so the caller can write
 * it back into the `BootContext` for downstream consumers.
 */
export async function runPreflight(
  config: Config,
  initialUpdateInfo: UpdateInfo | undefined,
): Promise<PreflightResult> {
  applyNodeEnvDefault();
  const updateInfo = await applyPrintUpdateNotice(initialUpdateInfo);
  await applyDebugStreamSeed(config);
  return {
    updateInfo,
    debugStreamEnabled: Boolean(config.debugStream),
  };
}
