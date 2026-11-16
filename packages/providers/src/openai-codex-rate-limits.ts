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
  const isDefault = meterId === DEFAULT_LIMIT_ID;
  const credits = isDefault ? parseCredits(headers) : undefined;
  const meterLabel = headerStr(headers, `${prefix}-limit-name`);
  const note = isDefault ? headerStr(headers, 'x-codex-promo-message') : undefined;
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
    ...(note !== undefined ? { note } : {}),
    capturedAt: now,
  };
}

/**
 * The window that is actually cutting a meter off: of the windows at or above
 * 100%, the one that reopens LAST, because the meter stays blocked until every
 * exhausted window has reset. Undefined when nothing is exhausted.
 */
export function codexBlockingWindow(
  snapshot: ProviderQuotaSnapshot,
): ProviderQuotaWindow | undefined {
  let blocking: ProviderQuotaWindow | undefined;
  for (const window of snapshot.windows) {
    if (window.usedPercent < 100) continue;
    if (
      blocking === undefined ||
      (window.resetsAt !== undefined &&
        (blocking.resetsAt === undefined || window.resetsAt > blocking.resetsAt))
    ) {
      blocking = window;
    }
  }
  return blocking;
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
  return markCodexReachedWindow(out, headers);
}

/**
 * Name the window that cut the account off, on the meter that did it.
 *
 * `x-codex-rate-limit-reached-type` is a REASON (`rate_limit_reached`,
 * `workspace_owner_credits_depleted`, …), not a window id, and
 * `x-codex-active-limit` names the family it applies to (`codex` when absent)
 * — both as the official client reads them. The window is the exhausted one
 * in that family; a credits-depleted reason with no window at 100% names none.
 */
function markCodexReachedWindow(
  snapshots: ProviderQuotaSnapshot[],
  headers: HeadersLike,
): ProviderQuotaSnapshot[] {
  if (headerStr(headers, 'x-codex-rate-limit-reached-type') === undefined) return snapshots;
  const active = normalizeLimitId(headerStr(headers, 'x-codex-active-limit') ?? DEFAULT_LIMIT_ID);
  return snapshots.map((snapshot) => {
    if (snapshot.meterId !== (active || DEFAULT_LIMIT_ID)) return snapshot;
    const blocking = codexBlockingWindow(snapshot);
    return blocking ? { ...snapshot, reachedWindowId: blocking.id } : snapshot;
  });
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
    typeof w.window_minutes === 'number' &&
    Number.isFinite(w.window_minutes) &&
    w.window_minutes > 0
      ? Math.trunc(w.window_minutes)
      : undefined;
  const resetsAt =
    typeof w.reset_at === 'number' && Number.isFinite(w.reset_at) && w.reset_at >= 0
      ? Math.trunc(w.reset_at)
      : undefined;
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

// ── Account usage read (`GET /wham/usage`) ─────────────────────────────────

interface UsageWindow {
  used_percent?: unknown;
  limit_window_seconds?: unknown;
  reset_after_seconds?: unknown;
  reset_at?: unknown;
}

interface UsageRateLimit {
  limit_reached?: unknown;
  primary_window?: unknown;
  secondary_window?: unknown;
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function usageWindow(id: string, raw: unknown, now: number): ProviderQuotaWindow | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const w = raw as UsageWindow;
  const usedPercent = finite(w.used_percent);
  if (usedPercent === undefined) return undefined;
  const seconds = finite(w.limit_window_seconds);
  const resetAfter = finite(w.reset_after_seconds);
  const resetsAt =
    finite(w.reset_at) ??
    (resetAfter !== undefined && resetAfter > 0 ? Math.floor(now / 1000) + resetAfter : undefined);
  return {
    id,
    usedPercent,
    ...(seconds !== undefined && seconds > 0 ? { windowMinutes: Math.round(seconds / 60) } : {}),
    ...(resetsAt !== undefined && resetsAt > 0 ? { resetsAt: Math.trunc(resetsAt) } : {}),
  };
}

function usageMeter(
  providerId: string,
  meterId: string,
  raw: unknown,
  extra: Partial<ProviderQuotaSnapshot>,
  now: number,
): ProviderQuotaSnapshot {
  const limit = (raw && typeof raw === 'object' ? raw : {}) as UsageRateLimit;
  const windows: ProviderQuotaWindow[] = [];
  for (const [id, value] of [
    ['primary', limit.primary_window],
    ['secondary', limit.secondary_window],
  ] as const) {
    const window = usageWindow(id, value, now);
    if (window) windows.push(window);
  }
  // `limit_reached` names no window; the exhausted one that reopens last is the
  // one cutting off — the same rule the header path applies.
  const reached =
    limit.limit_reached === true
      ? codexBlockingWindow({ providerId, meterId, windows, capturedAt: now })?.id
      : undefined;
  return {
    providerId,
    meterId,
    ...extra,
    windows,
    ...(reached !== undefined ? { reachedWindowId: reached } : {}),
    capturedAt: now,
  };
}

/**
 * Parse the ChatGPT account usage read (`GET /wham/usage`, verified live
 * 2026-09-30 on a Pro plan) into the same snapshots the response headers
 * produce, so a reading taken before any turn and one taken from a turn land
 * on the same meters:
 *
 *   plan_type                         `pro`, `plus`, …
 *   rate_limit.{primary,secondary}_window
 *     .used_percent                   0..100
 *     .limit_window_seconds           604800 = weekly (a Pro plan had only this one)
 *     .reset_at / .reset_after_seconds
 *   rate_limit.limit_reached          true once a window is exhausted
 *   credits.{has_credits,unlimited,balance}
 *   additional_rate_limits[]          { limit_name, metered_feature, rate_limit } —
 *                                     separate pools such as `gpt-reserve`
 *
 * Identity fields in the same body (email, user and account ids) are never
 * read.
 */
export function parseCodexUsagePayload(
  providerId: string,
  json: unknown,
  now: number = Date.now(),
): ProviderQuotaSnapshot[] {
  if (!json || typeof json !== 'object') return [];
  const body = json as Record<string, unknown>;
  const planLabel = typeof body['plan_type'] === 'string' ? body['plan_type'] : undefined;
  const rawCredits = body['credits'] as
    | { has_credits?: unknown; unlimited?: unknown; balance?: unknown }
    | null
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
  const out: ProviderQuotaSnapshot[] = [
    usageMeter(
      providerId,
      DEFAULT_LIMIT_ID,
      body['rate_limit'],
      {
        ...(planLabel !== undefined ? { planLabel } : {}),
        ...(credits !== undefined ? { credits } : {}),
      },
      now,
    ),
  ];
  const additional = body['additional_rate_limits'];
  if (Array.isArray(additional)) {
    for (const raw of additional) {
      if (!raw || typeof raw !== 'object') continue;
      const entry = raw as {
        limit_name?: unknown;
        metered_feature?: unknown;
        rate_limit?: unknown;
      };
      const feature = typeof entry.metered_feature === 'string' ? entry.metered_feature : undefined;
      const name = typeof entry.limit_name === 'string' ? entry.limit_name : undefined;
      const meterId = normalizeLimitId(feature ?? name ?? '');
      if (!meterId) continue;
      const snapshot = usageMeter(
        providerId,
        meterId,
        entry.rate_limit,
        {
          ...(name !== undefined ? { meterLabel: name } : {}),
          ...(planLabel !== undefined ? { planLabel } : {}),
        },
        now,
      );
      if (hasQuotaData(snapshot)) out.push(snapshot);
    }
  }
  return out.filter(hasQuotaData);
}
