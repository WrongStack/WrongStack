// PR 1 of Issue #30 (webui-server 8-PR refactor): extract
// the inlined `Logger` shim into its own file.
//
// Why this split:
//
//   - The shim is a stand-in for the real `Logger` while
//     the CLI module is consumed by other CLI modules
//     (AutoPhaseWebSocketHandler in particular) that don't
//     import the full `@wrongstack/core` tree. Lifting it
//     makes that "stand-in" status explicit: this file is
//     the CLI's structured-log adapter.
//
//   - Once extracted, the shim can be unit-tested in
//     isolation: pin the JSON shape, pin the level
//     mapping, pin the `child()` self-return. None of
//     these were testable while the shim was buried
//     between L88 and L113 of `webui-server.ts`.
//
//   - `webui-server.ts` loses 25 lines of unrelated
//     boilerplate. The next two PRs (cost-helpers,
//     context-breakdown) follow the same template.
//
// What is *not* in this file:
//
//   - The `structuredLine` helper. It is exported and
//     remains private to this module; nothing outside the
//     shim needs it.

import type { Logger } from '@wrongstack/core';

/**
 * Structured-log line shape used by the CLI webui-server
 * shim. The line is one JSON object per write, with a
 * stable `event: 'webui.autophase'` discriminator so the
 * TUI/WebUI log filter can route these to a dedicated
 * autophase channel.
 */
const structuredLine = (level: string, message: string): string =>
  JSON.stringify({
    level,
    event: 'webui.autophase',
    message,
    timestamp: new Date().toISOString(),
  });

/**
 * Console-backed `Logger` adapter for the CLI. Routes each
 * level to the matching `console.*` method and wraps the
 * message in a structured JSON line. The `child()` method
 * returns the same logger — the CLI shim does not maintain
 * a binding chain.
 */
export const consoleLogger: Logger = {
  level: 'debug',
  error(msg: string, _ctx?: unknown) {
    console.error(structuredLine('error', msg));
  },
  warn(msg: string, _ctx?: unknown) {
    console.warn(structuredLine('warn', msg));
  },
  info(msg: string, _ctx?: unknown) {
    console.log(structuredLine('info', msg));
  },
  debug(msg: string, _ctx?: unknown) {
    console.debug(structuredLine('debug', msg));
  },
  trace(msg: string, _ctx?: unknown) {
    console.debug(structuredLine('trace', msg));
  },
  child(_bindings: Record<string, unknown>): Logger {
    return this;
  },
};
