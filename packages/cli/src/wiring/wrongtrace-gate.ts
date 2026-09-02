/**
 * Re-export shim — the implementation moved into `@wrongstack/wrongtrace`
 * so the CLI leader, fleet subagents, and the standalone WebUI server all
 * share one gate without any of them importing `@wrongstack/cli` (the
 * dependency direction cli → webui-server forbids the reverse edge).
 *
 * Every historical import path (`../wiring/wrongtrace-gate.js`) keeps
 * working unchanged through this shim. NOTE: this is NOT core/utils'
 * `withFileLock` (a local file lock) — same name, different mechanism.
 */

export {
  getWrongTrace,
  preflightFileEdit,
  resetWrongTraceGate,
  withFileLock,
} from '@wrongstack/wrongtrace';
export type { PreflightOptions, PreflightVerdict } from '@wrongstack/wrongtrace';
