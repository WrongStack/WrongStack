/**
 * Format a token count for human-readable display.
 *   999 → "999"
 *   1_200 → "1.2k"
 *   12_000 → "12k"
 *   1_500_000 → "1.5M"
 */
export function fmtTok(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/**
 * Return a new frozen config object with the given patch applied.
 * Config objects are frozen by the config loader — direct mutation
 * silently fails at runtime. This helper spreads + re-freezes safely.
 */
export function patchConfig<T extends object>(base: T, patch: Partial<T>): T {
  return Object.freeze({ ...base, ...patch }) as T;
}

/**
 * Human-readable duration: 999 → "999ms", 12_500 → "12.5s",
 * 160_016 → "2m40s", 7_200_000 → "2h0m". Used by `/agents` and
 * `/fleet status` so users don't have to read "160016ms" and do the
 * conversion in their head.
 */
export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 59.5) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  let m = Math.floor(s / 60);
  let remSec = Math.round(s - m * 60);
  if (remSec === 60) {
    remSec = 0;
    m++;
  }
  if (m < 60) return remSec === 0 ? `${m}m` : `${m}m${remSec}s`;
  const h = Math.floor(m / 60);
  const remMin = m - h * 60;
  return `${h}h${remMin}m`;
}

/**
 * Render a completed TaskResult into a single line for `/agents` and
 * `/fleet status`. Distinguishes all four terminal statuses with
 * separate icons + colors so users can tell a timeout from a real
 * failure at a glance, and surfaces both the failure kind (e.g.
 * `provider_rate_limit`, `tool_failed`) and a truncated error tail
 * (previously dropped on the floor).
 *
 * Accepts either the structured `SubagentError` envelope (current) or
 * a legacy string error — the field shape is widened to keep older
 * callers compiling while migrations roll through.
 *
 * The caller passes the color helper (it lives in @wrongstack/core)
 * to avoid a circular import from this utility module.
 */
export function fmtTaskResultLine(
  r: {
    status: 'success' | 'failed' | 'timeout' | 'stopped';
    error?:
      | string
      | {
          kind?: string | undefined;
          message?: string | undefined;
          retryable?: boolean | undefined;
          backoffMs?: number | undefined;
        }
      | undefined;
    iterations: number;
    toolCalls: number;
    durationMs: number;
  },
  color: {
    green(s: string): string;
    red(s: string): string;
    yellow(s: string): string;
    dim(s: string): string;
  },
): { mark: string; stats: string; tail: string } {
  const stats = `${r.iterations}it ${r.toolCalls}tc ${fmtDuration(r.durationMs)}`;
  // Error tails are unbounded provider strings — collapse whitespace and
  // truncate so a 2KB stack trace can't blow up the chat line. Lift the
  // structured `kind` chip in front of the tail so the user reads
  // `✗ failed [provider_rate_limit] — server overloaded` instead of
  // raw verbose body.
  const errMsg = typeof r.error === 'string' ? r.error : r.error?.message;
  const errKind = typeof r.error === 'object' ? r.error?.kind : undefined;
  const errTail = errMsg
    ? ` — ${errMsg.replace(/\s+/g, ' ').slice(0, 80)}${errMsg.length > 80 ? '…' : ''}`
    : '';
  const errKindChip = errKind ? color.dim(` [${errKind}]`) : '';
  const errSnip = errMsg || errKind ? `${errKindChip}${color.dim(errTail)}` : '';
  switch (r.status) {
    case 'success':
      return { mark: color.green('✓'), stats, tail: '' };
    case 'timeout':
      return {
        mark: color.yellow('⏱'),
        stats: `${color.yellow('timeout')} ${stats}`,
        tail: errSnip,
      };
    case 'stopped':
      return { mark: color.dim('⊘'), stats: `${color.dim('stopped')} ${stats}`, tail: errSnip };
    case 'failed':
      return { mark: color.red('✗'), stats: `${color.red('failed')} ${stats}`, tail: errSnip };
  }
}
