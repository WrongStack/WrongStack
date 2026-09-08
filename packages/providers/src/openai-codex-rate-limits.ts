/**
 * Codex (ChatGPT-login) quota reporter — the `x-codex-*` rate-limit headers.
 *
 * The ChatGPT backend reports a subscription's remaining quota out-of-band on
 * every `/codex/responses` response: two rolling windows (typically 5h
 * "primary" and 7d "secondary"), an optional credits balance, and — once a
 * limit is actually reached — the kind of limit that was hit. None of it
 * appears in the SSE body, so a transport that only reads the body cannot tell
 * the user how much of their plan they have burned; they find out when a 429
 * arrives.
 *
 * This module is the Codex-specific HALF: it knows the header names and the
 * SSE event shape, and nothing else. The shape it produces and the store it
 * writes to are provider-neutral and live in `@wrongstack/core/quota`, so the
 * statusline chip and the quota report work the same way for the next metered
 * provider without a second parser, a second store, and a second chip.
 *
 * Header family (verified against openai/codex `codex-rs/codex-api/src/rate_limits.rs`):
 *
 *   x-codex-primary-used-percent      f64, 0..100
 *   x-codex-primary-window-minutes    i64, e.g. 300 (5h) or 10080 (7d)
 *   x-codex-primary-reset-at          i64, epoch SECONDS (can be EMPTY)
 *   x-codex-primary-reset-after-seconds  i64, relative fallback for reset-at
 *   x-codex-plan-type                 string, live plan tier (`pro`, `plus`, …)
 *   x-codex-secondary-…               same triple for the second window
 *   x-codex-credits-has-credits       bool
 *   x-codex-credits-unlimited         bool
 *   x-codex-credits-balance           string
 *   x-codex-limit-name                string, e.g. a model slug
 *   x-codex-rate-limit-reached-type   string, set when a limit was hit
 *   x-codex-promo-message             string
 *
 * The backend can also meter *additional* limit families under their own
 * prefix (`x-codex-secondary-primary-used-percent` → meter id
 * `codex_secondary`). Any header ending in `-primary-used-percent` names a
 * family, so the parser discovers them instead of hard-coding one.
 *
 * The same numbers arrive a second time as a `codex.rate_limits` SSE event on
 * some backends; {@link parseCodexRateLimitEvent} reads that shape so the two
 * paths produce one snapshot type.
 *
 * @module openai-codex-rate-limits
 */

import {
  hasQuotaData,
  type ProviderQuotaCredits,
  type ProviderQuotaSnapshot,
  type ProviderQuotaWindow,
} from '@wrongstack/core/quota';
import type { HeadersLike } from './error-parse.js';

/** Provider id under which ChatGPT-login quota is recorded. */
export const CODEX_QUOTA_PROVIDER_ID = 'openai-codex';

/** Meter id for the account-wide Codex allowance. */
const DEFAULT_LIMIT_ID = 'codex';

/** Headers that can be enumerated. Node/undici `Headers` satisfies this. */
interface EnumerableHeaders extends HeadersLike {
  keys?: () => Iterable<string>;
  forEach?: (cb: (value: string, key: string) => void) => void;
}

// ── Header reading ──────────────────────────────────────────────────────────

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

function headerInt(headers: HeadersLike, name: string): number | undefined {
  const n = headerNum(headers, name);
  return n === undefined ? undefined : Math.trunc(n);
}

function headerBool(headers: HeadersLike, name: string): boolean | undefined {
  const raw = headerStr(headers, name)?.toLowerCase();
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  return undefined;
}

/** `codex-secondary` / `codex_secondary` → `codex_secondary`. */
function normalizeLimitId(name: string): string {
  return name.trim().toLowerCase().replaceAll('-', '_');
}

/** `codex_secondary` → `x-codex-secondary` (the header prefix for the family). */
function limitHeaderPrefix(limitId: string): string {
  return `x-${limitId.trim().toLowerCase().replaceAll('_', '-')}`;
}

function parseWindow(
  headers: HeadersLike,
  prefix: string,
  id: string,
  now: number,
): ProviderQuotaWindow | undefined {
  const usedPercent = headerNum(headers, `${prefix}-${id}-used-percent`);
  if (usedPercent === undefined) return undefined;
  const windowMinutes = headerInt(headers, `${prefix}-${id}-window-minutes`);
  // The backend sends the reset both ways and does not always fill in both:
  // a live `pro` response carried `x-codex-secondary-reset-after-seconds` with
  // an EMPTY `x-codex-secondary-reset-at`. The relative form is also immune to
  // client clock skew, so it is the fallback rather than an alternative that
  // gets ignored.
  const resetAfterSeconds = headerInt(headers, `${prefix}-${id}-reset-after-seconds`);
  const resetsAt =
    headerInt(headers, `${prefix}-${id}-reset-at`) ??
    (resetAfterSeconds !== undefined && resetAfterSeconds > 0
      ? Math.floor(now / 1000) + resetAfterSeconds
      : undefined);
  // A window reported as a flat zero with no other field carries no signal —
  // upstream treats that as "not metered" rather than "0% used", and showing a
  // fabricated 0%/no-reset bar in the UI would be worse than showing nothing.
  const hasData =
    usedPercent !== 0 ||
    (windowMinutes !== undefined && windowMinutes !== 0) ||
    resetsAt !== undefined;
  if (!hasData) return undefined;
  return {
    id,
    usedPercent,
    ...(windowMinutes !== undefined ? { windowMinutes } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  };
}

function parseCredits(headers: HeadersLike): ProviderQuotaCredits | undefined {
  const hasCredits = headerBool(headers, 'x-codex-credits-has-credits');
  const unlimited = headerBool(headers, 'x-codex-credits-unlimited');
  if (hasCredits === undefined || unlimited === undefined) return undefined;
  const balance = headerStr(headers, 'x-codex-credits-balance');
  return { hasCredits, unlimited, ...(balance !== undefined ? { balance } : {}) };
}

/**
 * Parse one limit family. `limitId` defaults to the account-wide `codex`
 * family, which is the one every ChatGPT-login response carries.
 */
export function parseCodexRateLimitForLimit(
  headers: HeadersLike,
  limitId: string = DEFAULT_LIMIT_ID,
  now: number = Date.now(),
): ProviderQuotaSnapshot {
  const meterId = normalizeLimitId(limitId) || DEFAULT_LIMIT_ID;
  const prefix = limitHeaderPrefix(meterId);
  const windows: ProviderQuotaWindow[] = [];
  for (const id of ['primary', 'secondary']) {
    const window = parseWindow(headers, prefix, id, now);
    if (window) windows.push(window);
  }
  const credits = parseCredits(headers);
  const meterLabel = headerStr(headers, `${prefix}-limit-name`);
  const reachedWindowId = headerStr(headers, 'x-codex-rate-limit-reached-type')?.toLowerCase();
  const note = headerStr(headers, 'x-codex-promo-message');
  // Authoritative plan tier as the backend sees it right now. The JWT claim
  // that used to be the only source is a snapshot from when the token was
  // minted, so it lags an upgrade until the next refresh.
  const planLabel = headerStr(headers, 'x-codex-plan-type');
  return {
    providerId: CODEX_QUOTA_PROVIDER_ID,
    meterId,
    ...(planLabel !== undefined ? { planLabel } : {}),
    ...(meterLabel !== undefined ? { meterLabel } : {}),
    windows,
    ...(credits !== undefined ? { credits } : {}),
    ...(reachedWindowId !== undefined ? { reachedWindowId } : {}),
    ...(note !== undefined ? { note } : {}),
    capturedAt: now,
  };
}

function enumerateHeaderNames(headers: EnumerableHeaders): string[] {
  const names: string[] = [];
  try {
    if (typeof headers.keys === 'function') {
      for (const key of headers.keys()) names.push(key.toLowerCase());
    } else if (typeof headers.forEach === 'function') {
      headers.forEach((_value, key) => {
        names.push(key.toLowerCase());
      });
    }
  } catch {
    return [];
  }
  return names;
}

/**
 * Parse every metered limit family present in the response headers.
 *
 * The account-wide `codex` family is always returned (even empty) so callers
 * can distinguish "the backend reported nothing" from "we never asked"; every
 * other family is included only when it carries data.
 */
export function parseCodexRateLimitHeaders(
  headers: HeadersLike | undefined,
  now: number = Date.now(),
): ProviderQuotaSnapshot[] {
  if (!headers) return [];
  const out: ProviderQuotaSnapshot[] = [
    parseCodexRateLimitForLimit(headers, DEFAULT_LIMIT_ID, now),
  ];

  const extra = new Set<string>();
  for (const name of enumerateHeaderNames(headers as EnumerableHeaders)) {
    if (!name.startsWith('x-') || !name.endsWith('-primary-used-percent')) continue;
    const family = normalizeLimitId(name.slice(2, name.length - '-primary-used-percent'.length));
    if (family && family !== DEFAULT_LIMIT_ID) extra.add(family);
  }
  for (const limitId of [...extra].sort()) {
    const snapshot = parseCodexRateLimitForLimit(headers, limitId, now);
    if (hasQuotaData(snapshot)) out.push(snapshot);
  }
  return out;
}

// ── SSE event ───────────────────────────────────────────────────────────────

interface RateLimitEventWindow {
  used_percent?: unknown;
  window_minutes?: unknown;
  reset_at?: unknown;
}

function eventWindow(id: string, raw: unknown): ProviderQuotaWindow | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const w = raw as RateLimitEventWindow;
  const usedPercent =
    typeof w.used_percent === 'number' && Number.isFinite(w.used_percent)
      ? w.used_percent
      : undefined;
  if (usedPercent === undefined) return undefined;
  const windowMinutes =
    typeof w.window_minutes === 'number' ? Math.trunc(w.window_minutes) : undefined;
  const resetsAt = typeof w.reset_at === 'number' ? Math.trunc(w.reset_at) : undefined;
  return {
    id,
    usedPercent,
    ...(windowMinutes !== undefined ? { windowMinutes } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  };
}

/**
 * Parse a `codex.rate_limits` SSE event body into a snapshot.
 *
 * Returns null for any other event so the caller can pass every parsed SSE
 * envelope through without pre-filtering.
 */
export function parseCodexRateLimitEvent(
  evt: Record<string, unknown> | null | undefined,
  now: number = Date.now(),
): ProviderQuotaSnapshot | null {
  if (evt?.['type'] !== 'codex.rate_limits') return null;
  const details = evt['rate_limits'] as { primary?: unknown; secondary?: unknown } | undefined;
  const windows: ProviderQuotaWindow[] = [];
  for (const id of ['primary', 'secondary'] as const) {
    const window = eventWindow(id, details?.[id]);
    if (window) windows.push(window);
  }

  const rawCredits = evt['credits'] as
    | { has_credits?: unknown; unlimited?: unknown; balance?: unknown }
    | undefined;
  const credits: ProviderQuotaCredits | undefined =
    rawCredits &&
    typeof rawCredits.has_credits === 'boolean' &&
    typeof rawCredits.unlimited === 'boolean'
      ? {
          hasCredits: rawCredits.has_credits,
          unlimited: rawCredits.unlimited,
          ...(typeof rawCredits.balance === 'string' ? { balance: rawCredits.balance } : {}),
        }
      : undefined;

  const rawMeter = evt['metered_limit_name'] ?? evt['limit_name'];
  const meterId =
    typeof rawMeter === 'string' && rawMeter.trim() ? normalizeLimitId(rawMeter) : DEFAULT_LIMIT_ID;
  const planLabel = typeof evt['plan_type'] === 'string' ? (evt['plan_type'] as string) : undefined;

  return {
    providerId: CODEX_QUOTA_PROVIDER_ID,
    meterId,
    ...(planLabel !== undefined ? { planLabel } : {}),
    windows,
    ...(credits !== undefined ? { credits } : {}),
    capturedAt: now,
  };
}
