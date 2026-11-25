/**
 * Anthropic quota reporter — the `anthropic-ratelimit-unified-*` headers.
 *
 * A Claude Pro/Max login is metered on rolling windows (a 5-hour one and a
 * 7-day one) rather than per token, and the only place that budget is reported
 * is a header family on every `/v1/messages` response. Nothing about it reaches
 * the SSE body, so a transport that only reads the body cannot tell the user
 * how much of their plan they have burned; they find out when a 429 lands
 * mid-turn.
 *
 * This module is the Anthropic-specific HALF, exactly as
 * `openai-codex-rate-limits` is for Codex: it knows the header names and
 * nothing else. The shape it produces and the store it writes to are
 * provider-neutral (`@wrongstack/core/quota`), so the statusline chip, the
 * quota report, and the WebUI panel render it without learning that Anthropic
 * exists.
 *
 * Header family:
 *
 *   anthropic-ratelimit-unified-5h-utilization      fraction 0..1 (see below)
 *   anthropic-ratelimit-unified-5h-reset            epoch SECONDS
 *   anthropic-ratelimit-unified-5h-status           per-window state
 *   anthropic-ratelimit-unified-7d-utilization      same pair for the long window
 *   anthropic-ratelimit-unified-7d-reset
 *   anthropic-ratelimit-unified-7d-status
 *   anthropic-ratelimit-unified-status              account-wide state
 *   anthropic-ratelimit-unified-representative-claim  which window is binding
 *
 * Two deliberate exclusions:
 *
 * 1. **The per-minute buckets** (`anthropic-ratelimit-requests-remaining`,
 *    `-tokens-remaining`, `-input-tokens-*`, `-output-tokens-*`) are NOT read
 *    here. They are the API-key tier's per-minute throughput allowance, not a
 *    subscription budget: they refill every minute, and a burst that takes one
 *    to 95% is normal operation. Feeding them into the same store would let a
 *    momentary throughput spike win `worstProviderQuotaWindow()` and render as
 *    "your plan is nearly gone" in the status bar. Throughput backpressure
 *    belongs to the retry/backoff path, which already reads `retry-after`.
 *
 * 2. **`GET /api/oauth/usage`** — the endpoint that backs Claude Code's own
 *    usage view — is not polled. It is undocumented, requires the `user:profile`
 *    scope (a `setup-token` credential gets a 403), rate-limits per access token
 *    rather than per account, and hands out permanent 429s to callers that do
 *    not send a `claude-code/<version>` user agent. The header path rides along
 *    on requests we are already making, costs nothing, and cannot be throttled
 *    separately.
 *
 * @module anthropic-rate-limits
 */

import {
  hasQuotaData,
  type ProviderQuotaSnapshot,
  type ProviderQuotaWindow,
} from '@wrongstack/core/quota';
import type { HeadersLike } from './error-parse.js';

/** Header prefix shared by the whole unified family. */
const PREFIX = 'anthropic-ratelimit-unified';

/** Meter id for the account-wide Claude allowance. */
const DEFAULT_LIMIT_ID = 'claude';

/**
 * The windows Anthropic meters, with the length each id stands for.
 *
 * The length is hard-coded because the header family names the window in the
 * header itself (`-5h-`, `-7d-`) and never reports its length as a value. That
 * is the opposite of the Codex family, where the window is positional
 * (`primary`/`secondary`) and the length arrives as `window-minutes` — there,
 * keying off the position rather than the reported length mislabels the UI
 * when the backend reshuffles them, so the length must be read. Here the id
 * *is* the length, so there is nothing to reshuffle.
 */
const WINDOWS: readonly { id: string; windowMinutes: number }[] = [
  { id: '5h', windowMinutes: 300 },
  { id: '7d', windowMinutes: 10_080 },
];

/** Per-window and account-wide status values that mean "not cut off". */
const HEALTHY_STATUSES = new Set(['allowed', 'ok', 'allowed_warning', 'warning']);

function headerStr(headers: HeadersLike, name: string): string | undefined {
  let raw: string | null = null;
  try {
    raw = headers.get(name);
  } catch {
    return undefined;
  }
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function headerNum(headers: HeadersLike, name: string): number | undefined {
  const raw = headerStr(headers, name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Utilization as a percentage, from a header documented as a 0..1 fraction.
 *
 * The dual reading is deliberate. The fraction form is what the responses
 * carry, but the sibling `-status` headers are strings and the family is
 * undocumented, so a backend switching to whole percents would otherwise
 * silently report a 40% burn as 0.4%. Anything above 1 can only be a percent
 * already (a fraction cannot exceed 1), which makes the two forms
 * distinguishable everywhere except the single point where they agree in
 * meaning to within a rounding error.
 */
function utilizationPercent(headers: HeadersLike, windowId: string): number | undefined {
  const raw = headerNum(headers, `${PREFIX}-${windowId}-utilization`);
  if (raw === undefined || raw < 0) return undefined;
  const percent = raw <= 1 ? raw * 100 : raw;
  return Math.min(100, percent);
}

function parseWindow(
  headers: HeadersLike,
  spec: { id: string; windowMinutes: number },
): ProviderQuotaWindow | undefined {
  const usedPercent = utilizationPercent(headers, spec.id);
  if (usedPercent === undefined) return undefined;
  const resetsAt = headerNum(headers, `${PREFIX}-${spec.id}-reset`);
  const resetSec = resetsAt !== undefined ? Math.trunc(resetsAt) : 0;
  return {
    id: spec.id,
    // The id already reads as the window length (`5h`, `7d`), and it is what
    // the operator sees in the provider's own docs. Deriving a label from the
    // minutes would produce the same string by a longer route.
    label: spec.id,
    usedPercent,
    windowMinutes: spec.windowMinutes,
    ...(resetSec > 0 ? { resetsAt: resetSec } : {}),
  };
}

/**
 * The window that is currently cutting the account off, when one is.
 *
 * `-representative-claim` names the binding window, but it names one whether
 * or not a limit has actually been hit — it is "the window that would bite
 * first", which on a fresh account is still the 5-hour one at 0%. Reporting
 * that as `reachedWindowId` would paint the status chip red on an idle plan,
 * so a status header has to agree that something is exhausted before the claim
 * is taken as the reached window.
 */
function parseReachedWindowId(headers: HeadersLike): string | undefined {
  const accountStatus = headerStr(headers, `${PREFIX}-status`)?.toLowerCase();
  const exhausted = new Set<string>();
  for (const spec of WINDOWS) {
    const status = headerStr(headers, `${PREFIX}-${spec.id}-status`)?.toLowerCase();
    if (status !== undefined && !HEALTHY_STATUSES.has(status)) exhausted.add(spec.id);
  }
  const accountExhausted = accountStatus !== undefined && !HEALTHY_STATUSES.has(accountStatus);
  if (exhausted.size === 0 && !accountExhausted) return undefined;

  const claim = headerStr(headers, `${PREFIX}-representative-claim`)?.toLowerCase();
  if (claim !== undefined) {
    // The claim is a free-form window name. Match it against the ids we know
    // rather than trusting it verbatim, so an unrecognized name falls through
    // to the per-window statuses instead of pointing `reachedQuotaWindow()` at
    // a window that is not in the snapshot.
    const matched = WINDOWS.find(
      (spec) => spec.id === claim || claim.includes(spec.id) || spec.id.includes(claim),
    );
    if (matched && (exhausted.has(matched.id) || exhausted.size === 0)) return matched.id;
  }
  const firstExhausted = WINDOWS.find((spec) => exhausted.has(spec.id));
  return firstExhausted?.id;
}

/**
 * Parse the unified quota headers from one Anthropic response.
 *
 * `providerId` is the caller's own id rather than a constant: the same
 * transport serves the first-party login and any number of configured custom
 * Anthropic-compatible providers, and two accounts' burn must not be merged
 * into one reading. Returns an empty array when the response carried no quota
 * channel at all — an API-key account on a gateway that strips the family, or
 * any non-`/v1/messages` call.
 */
export function parseAnthropicRateLimitHeaders(
  providerId: string,
  headers: HeadersLike | undefined,
  now: number = Date.now(),
): ProviderQuotaSnapshot[] {
  if (!headers) return [];
  const windows: ProviderQuotaWindow[] = [];
  for (const spec of WINDOWS) {
    const window = parseWindow(headers, spec);
    if (window) windows.push(window);
  }
  const reachedWindowId = parseReachedWindowId(headers);
  const snapshot: ProviderQuotaSnapshot = {
    providerId,
    meterId: DEFAULT_LIMIT_ID,
    windows,
    ...(reachedWindowId !== undefined ? { reachedWindowId } : {}),
    capturedAt: now,
  };
  // An empty shell would blank a good reading downstream if the store did not
  // guard against it; not returning one at all keeps that contract local.
  return hasQuotaData(snapshot) || reachedWindowId !== undefined ? [snapshot] : [];
}
