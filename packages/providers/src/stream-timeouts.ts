/**
 * Process-wide defaults for the two stream watchdogs every HTTP+SSE provider
 * runs: the inter-chunk gap that declares a hang, and the deadline for the
 * response headers.
 *
 * `WireAdapterStreamOptions` has always accepted both, but no host ever passed
 * them — the factory builds providers from a per-provider `ProviderConfig` and
 * never saw the user's settings, and the composite providers (MiniMax,
 * OpenCode Go, the catalog-routed gateways) do not forward stream options to
 * their delegates at all. So the values were effectively hard-coded at 60s and
 * the config knob did nothing. Following `stream-debug-state.ts`, the host sets
 * the defaults once at boot and every provider — however it was constructed —
 * picks them up; an explicit `streamOpts` still wins per instance.
 */

/** Both watchdogs default to a minute; `0` disables one. */
export const DEFAULT_STREAM_HANG_TIMEOUT_MS = 60_000;
export const DEFAULT_HEADERS_TIMEOUT_MS = 60_000;

export interface StreamTimeoutDefaults {
  /** Max gap between body chunks before a StreamHangError. `0` disables. */
  hangTimeoutMs: number;
  /** Max wait for response headers before a retryable abort. `0` disables. */
  headersTimeoutMs: number;
}

let defaults: StreamTimeoutDefaults = {
  hangTimeoutMs: DEFAULT_STREAM_HANG_TIMEOUT_MS,
  headersTimeoutMs: DEFAULT_HEADERS_TIMEOUT_MS,
};

/**
 * A non-negative finite millisecond count clamped to Node's timer range, else
 * undefined (keep the default). Shared with per-instance `streamOpts`.
 */
export function sanitizeStreamTimeoutMs(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return Math.min(Math.floor(value), 2_147_483_647);
}

/**
 * Install the host's configured timeouts. Unset / malformed fields keep the
 * current value, so a partial settings object never resurrects a default the
 * user already changed.
 */
export function setStreamTimeoutDefaults(
  next: { hangTimeoutMs?: number | undefined; headersTimeoutMs?: number | undefined } | undefined,
): void {
  if (!next) return;
  const hang = sanitizeStreamTimeoutMs(next.hangTimeoutMs);
  const headers = sanitizeStreamTimeoutMs(next.headersTimeoutMs);
  defaults = {
    hangTimeoutMs: hang ?? defaults.hangTimeoutMs,
    headersTimeoutMs: headers ?? defaults.headersTimeoutMs,
  };
}

/** Restore the built-in 60s/60s pair (tests, host teardown). */
export function resetStreamTimeoutDefaults(): void {
  defaults = {
    hangTimeoutMs: DEFAULT_STREAM_HANG_TIMEOUT_MS,
    headersTimeoutMs: DEFAULT_HEADERS_TIMEOUT_MS,
  };
}

export function streamTimeoutDefaults(): StreamTimeoutDefaults {
  return defaults;
}
