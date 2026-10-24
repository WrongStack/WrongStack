import type { Logger } from '@wrongstack/contracts/types/logger';
import { isLoopbackHost } from './exposure.js';
import type { HqRedactionPolicy } from './protocol.js';

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

/**
 * Warn when this publisher is about to send unredacted content over a
 * cleartext link to another machine.
 *
 * `DEFAULT_HQ_REDACTION_POLICY` is `{rawContent: true, toolArgs: 'full',
 * paths: 'full'}` — the most open setting available. That is defensible for
 * the normal case, where HQ is on the same machine and the console is the
 * product. It is not defensible when the endpoint is remote and the transport
 * is plain `ws:`, because the payload then includes prompts, thinking blocks,
 * verbatim tool arguments and absolute paths, in the clear, to anyone on the
 * path.
 *
 * This warns rather than silently clamping. A clamp would be the stronger
 * control, but it changes what an operator sees in a topology they chose
 * deliberately (HQ over a VPN on `ws:` is a legitimate setup), and a console
 * that quietly starts showing `[REDACTED]` reads as a bug. Making the
 * exposure visible to the person who can decide is the honest half; changing
 * the default is an owner decision, recorded in the security report.
 *
 * Deduplicated per endpoint via the same `warnedEndpoints` set the connection
 * warnings use, so a reconnect loop cannot turn this into a log flood.
 */
export function warnIfShippingRawContentInClear(
  url: string,
  policy: HqRedactionPolicy,
  logger: Logger | undefined,
): void {
  const disclosesContent =
    policy.rawContent || policy.toolArgs === 'full' || policy.paths === 'full';
  if (!disclosesContent) return;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return; // Unparseable endpoints are already reported by the connect path.
  }
  // `wss:`/`https:` is encrypted; loopback never leaves the machine.
  if (parsed.protocol === 'wss:' || parsed.protocol === 'https:') return;
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (isLoopbackHost(host) || host === 'localhost' || host.endsWith('.localhost')) return;

  const key = `raw-content-in-clear:${parsed.host}`;
  if (warnedEndpoints.has(key)) return;
  warnedEndpoints.add(key);
  logger?.warn?.(
    JSON.stringify({
      level: 'warn',
      event: 'hq.publisher.raw_content_over_cleartext',
      endpoint: `${parsed.protocol}//${parsed.host}`,
      rawContent: policy.rawContent,
      toolArgs: policy.toolArgs,
      paths: policy.paths,
      message:
        'Publishing unredacted session content (prompts, tool arguments, absolute paths) ' +
        'to a remote HQ over an unencrypted connection. Use wss:// (terminate TLS in front ' +
        'of HQ), or set a stricter redactionPolicy for this publisher.',
    }),
  );
}
