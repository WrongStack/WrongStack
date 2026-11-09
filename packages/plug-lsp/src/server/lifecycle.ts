import type { ServerState } from '../types.js';

/**
 * The server lifecycle. Every production write of `LSPServer.state` goes
 * through `LSPServer.transition`, which refuses an edge missing here — so this
 * table is the machine, not documentation of it.
 *
 * Edges worth knowing:
 * - `starting`/`initializing`/`failed`/`reconnecting` → `shutting_down`: a
 *   shutdown may arrive at any point of a startup or a reconnect wait.
 * - `shutting_down` → `failed` → `exited`: the child can report an error while
 *   the shutdown handshake is pending; the shutdown still ends in `exited`.
 */
const ALLOWED: Readonly<Record<ServerState, readonly ServerState[]>> = {
  disabled: ['starting'],
  starting: ['initializing', 'failed', 'shutting_down'],
  initializing: ['ready', 'failed', 'shutting_down'],
  ready: ['shutting_down', 'failed'],
  failed: ['reconnecting', 'disabled', 'starting', 'shutting_down', 'exited'],
  reconnecting: ['starting', 'failed', 'shutting_down'],
  shutting_down: ['exited', 'failed'],
  exited: ['starting', 'disabled'],
};

export function canTransition(from: ServerState, to: ServerState): boolean {
  if (from === to) return true;
  return Object.hasOwn(ALLOWED, from) && ALLOWED[from].includes(to);
}

export function nextReconnectDelay(attempt: number): number {
  /* v8 ignore next -- array fallback is defensive after clamping. */
  return [1000, 4000, 16_000][Math.max(0, Math.min(2, attempt))] ?? 16_000;
}
