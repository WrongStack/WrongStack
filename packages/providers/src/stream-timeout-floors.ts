/**
 * Longer stream watchdogs for backends whose normal behaviour trips the 60s
 * defaults.
 *
 * Measured 2026-10-22 on the coding plans: MiniMax-M3 sends nothing for more
 * than a minute while it produces one large tool call (a 35-48KB `write`), and
 * Z.AI GLM-5.3 can take over a minute to send response headers. With 60s
 * budgets every such turn failed all four attempts; with 240s/180s the same
 * jobs completed. A floor applies only where nobody chose a value: an explicit
 * per-instance option or a host-configured budget other than the built-in
 * default always wins.
 *
 * No imports from the provider modules: they extend the wire adapter that
 * reads this, so the checks are restated here as plain patterns.
 */

import { upstreamHost } from './proxy-upstream.js';
import { DEFAULT_HEADERS_TIMEOUT_MS, DEFAULT_STREAM_HANG_TIMEOUT_MS } from './stream-timeouts.js';

export const SLOW_BACKEND_HANG_TIMEOUT_MS = 240_000;
export const SLOW_BACKEND_HEADERS_TIMEOUT_MS = 180_000;

function hostOf(url: string): string {
  return upstreamHost(url) ?? '';
}

/** MiniMax by catalog id family or API host; Z.AI / BigModel by host or id. */
function isSlowBackend(providerId: string | undefined, baseUrl: string): boolean {
  const id = (providerId ?? '').toLowerCase();
  if (/^(?:minimax|zai)(?:-|$)/.test(id)) return true;
  const host = hostOf(baseUrl);
  return /(?:^|\.)(?:minimax\.io|minimaxi\.com|minimax\.chat|z\.ai|bigmodel\.cn)$/.test(host);
}

/**
 * The budget to run with. `value` is what construction resolved; `explicit`
 * says a per-instance option set it. A built-in default on a slow backend is
 * raised to the floor; `0` (disabled) and every chosen value pass through.
 */
export function streamBudget(
  kind: 'hang' | 'headers',
  value: number,
  explicit: boolean,
  providerId: string | undefined,
  baseUrl: string,
): number {
  if (explicit || value === 0) return value;
  const builtIn = kind === 'hang' ? DEFAULT_STREAM_HANG_TIMEOUT_MS : DEFAULT_HEADERS_TIMEOUT_MS;
  if (value !== builtIn || !isSlowBackend(providerId, baseUrl)) return value;
  return kind === 'hang' ? SLOW_BACKEND_HANG_TIMEOUT_MS : SLOW_BACKEND_HEADERS_TIMEOUT_MS;
}
