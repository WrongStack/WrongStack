import type { SubcommandHandler } from '../contracts.js';

/**
 * `wrongstack quick` — launch directly into the TUI with sensible defaults.
 *
 * NOTE: The actual handling is done in `boot()` (boot.ts) which intercepts 'quick'
 * before the subcommand dispatch in cli-main.ts. boot() sets flags.quick and
 * flags.tui, lists plugins, clears positional, and returns BootContext.
 * execute() then goes to the TUI path with initialAgentsMonitorOpen: true.
 *
 * This handler is kept for completeness (registered in subcommands/index.ts) but
 * is never called in the `wrongstack quick` flow.
 */
export const quickCmd: SubcommandHandler = (_args, _deps) => {
  // This handler is never reached when `wrongstack quick` is used (boot() handles it).
  // Kept for discoverability and as a fallback if the boot() intercept is removed.
  return Promise.resolve(0);
};
