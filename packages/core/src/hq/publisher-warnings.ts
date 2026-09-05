import type { Logger } from '../types/logger.js';

export const CONNECT_WARN_AFTER_FAILURES = 5;
export const DEFAULT_CONNECT_WARN_COOLDOWN_MS = 5 * 60_000;

/**
 * Module-level set of endpoints (urls) for which a connect-failure warning has
 * already been emitted in THIS process. Shared across all HqPublisher instances so
 * that only one diagnostic warning is emitted across the entire process lifetime
 * while the server is unreachable, rather than repeating warnings periodically or
 * across multiple instances.
 */
export const warnedEndpoints = new Set<string>();

/** Test helper to reset the module-level process warning state. */
export function resetHqPublisherWarningStateForTests(): void {
  warnedEndpoints.clear();
}

export interface EmitConnectWarningOptions {
  targetUrl: string;
  reconnectAttempt: number;
  lastAttempt: { url: string; hadToken: boolean } | null;
  connectWarnCooldownMs: number;
  now: () => string;
  logger?: Logger | undefined;
  warn?: ((message: string) => void) | undefined;
}

export function emitConnectWarning(opts: EmitConnectWarningOptions): boolean {
  // Process-wide suppression: multiple agents failing against the same HQ
  // collapse to ONE warning across the entire process lifetime while unreachable.
  if (opts.connectWarnCooldownMs > 0) {
    if (warnedEndpoints.has(opts.targetUrl)) {
      return false;
    }
    warnedEndpoints.add(opts.targetUrl);
  }
  const attempt = opts.lastAttempt;
  const message =
    `WrongStack HQ publisher: ${opts.reconnectAttempt} consecutive connection failures` +
    `${attempt !== null ? ` to ${attempt.url} (client token ${attempt.hadToken ? 'present' : 'absent'})` : ''}. ` +
    'Either the HQ server is unreachable or it rejected the token (401). ' +
    'If HQ runs in client-token mode, verify WRONGSTACK_HQ_TOKEN / auth.json. Retries continue with backoff.';
  if (opts.logger) {
    opts.logger.warn(message, { event: 'hq.publisher.connect_failed' });
    return true;
  }
  const warn =
    opts.warn ??
    ((msg: string) =>
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'hq.publisher.connect_failed',
          message: msg,
          timestamp: opts.now(),
        }),
      ));
  try {
    warn(message);
  } catch {
    /* diagnostics must never break publishing */
  }
  return true;
}
