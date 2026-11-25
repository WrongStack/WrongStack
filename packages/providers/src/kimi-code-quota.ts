/**
 * Kimi Code (Kimi For Coding) plan quota — `GET /coding/v1/usages`.
 *
 * An account read, not a model call: it spends none of the plan it reports.
 * The same key that serves `/coding/v1` inference authenticates it (verified
 * live 2026-09-30, `Authorization: Bearer` and `x-api-key` both accepted).
 *
 * The response carries two generations of the same windows:
 *
 *   usage   {limit, used, remaining, resetTime}          weekly request count
 *   limits  [{window:{duration,timeUnit}, detail:{…}}]    5-hour request count
 *   usages  {limit_5h, limit_7d, limit_month_total}      {used_ratio, reset_time}
 *
 * They can disagree: a live account showed `usage` 20/100 while `limit_7d`
 * reported `used_ratio: 0`, with resets 1.3 s apart. The precedence here is
 * CodexBar's (steipete/CodexBar `KimiUsageSnapshot`), the most careful public
 * reading of this endpoint: ratio pools win, EXCEPT a zero ratio in a response
 * with no monthly pool falls back to a populated counter of the same duration
 * whose reset is within two seconds — the zero is a placeholder there. A
 * non-zero ratio, or any response carrying the monthly pool, keeps the ratio.
 *
 * @module kimi-code-quota
 */

import {
  DEFAULT_QUOTA_METER,
  type ProviderQuotaSnapshot,
  type ProviderQuotaWindow,
  recordProviderQuota,
} from '@wrongstack/core/quota';

/** The Kimi Code API hosts: China (`kimi.com`, the default) and International (`kimi.ai`). */
export const KIMI_CODE_HOSTS = ['api.kimi.com', 'api.kimi.ai'] as const;
export type KimiCodeHost = (typeof KIMI_CODE_HOSTS)[number];

function kimiCodeUsagesUrl(host: KimiCodeHost = 'api.kimi.com'): string {
  return `https://${host}/coding/v1/usages`;
}

const FIVE_HOURS = 300;
const WEEK = 10_080;
/** Reset clocks of the two generations were observed ~1.45 s apart. */
const SAME_RESET_TOLERANCE_MS = 2_000;

type Json = Record<string, unknown>;

function record(value: unknown): Json | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Json)
    : undefined;
}

/** Integers arrive as numbers or numeric strings (`"100"`). */
function integer(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isInteger(value) ? value : undefined;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    const n = Number(value.trim());
    return Number.isSafeInteger(n) ? n : undefined;
  }
  return undefined;
}

function resetMs(value: unknown): number | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

interface Counts {
  used: number;
  limit: number;
  /** False when neither `used` nor a valid `remaining` was reported. */
  reliable: boolean;
}

/** `used` is authoritative (it may pass the limit in overage); `remaining` must be a valid balance. */
function usageCounts(detail: Json | undefined): Counts | undefined {
  if (!detail) return undefined;
  const limit = integer(detail['limit'] ?? detail['Limit']);
  if (limit === undefined || limit <= 0) return undefined;
  const used = integer(detail['used'] ?? detail['Used']);
  if (used !== undefined && used >= 0) return { used, limit, reliable: true };
  const remaining = integer(detail['remaining'] ?? detail['Remaining']);
  if (remaining !== undefined && remaining >= 0 && remaining <= limit) {
    return { used: limit - remaining, limit, reliable: true };
  }
  return { used: 0, limit, reliable: false };
}

function countResetMs(detail: Json | undefined): number | undefined {
  return resetMs(
    detail?.['resetTime'] ?? detail?.['resetAt'] ?? detail?.['reset_time'] ?? detail?.['reset_at'],
  );
}

function windowMinutes(window: Json | undefined): number | undefined {
  const duration = integer(window?.['duration']);
  if (duration === undefined || duration <= 0) return undefined;
  switch (window?.['timeUnit']) {
    case 'TIME_UNIT_MINUTE':
      return duration;
    case 'TIME_UNIT_HOUR':
      return duration * 60;
    case 'TIME_UNIT_DAY':
      return duration * 1440;
    default:
      return undefined;
  }
}

interface RatioWindow {
  usedPercent: number;
  resetMs?: number | undefined;
}

function ratioWindow(pool: Json | undefined): RatioWindow | undefined {
  const ratio = pool?.['used_ratio'];
  if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio < 0) return undefined;
  return { usedPercent: Math.min(1, ratio) * 100, resetMs: resetMs(pool?.['reset_time']) };
}

function toWindow(
  id: string,
  usedPercent: number,
  minutes: number | undefined,
  reset: number | undefined,
  label?: string,
): ProviderQuotaWindow {
  return {
    id,
    ...(label ? { label } : {}),
    usedPercent: clampPercent(usedPercent),
    ...(minutes !== undefined ? { windowMinutes: minutes } : {}),
    ...(reset !== undefined ? { resetsAt: Math.floor(reset / 1000) } : {}),
  };
}

/**
 * One Kimi Code window: the ratio pool unless it is a zero placeholder beside
 * a populated counter for the same duration and reset (see module comment).
 */
function resolveWindow(args: {
  id: string;
  pool: Json | undefined;
  detail: Json | undefined;
  minutes: number;
  countMinutes: number | undefined;
  hasMonthlyPool: boolean;
  weeklyReliable: boolean;
}): ProviderQuotaWindow | undefined {
  const ratio = ratioWindow(args.pool);
  const counts = usageCounts(args.detail);
  const countReset = countResetMs(args.detail);
  const placeholder =
    ratio !== undefined &&
    ratio.usedPercent === 0 &&
    !args.hasMonthlyPool &&
    args.weeklyReliable &&
    args.countMinutes === args.minutes &&
    counts?.reliable === true &&
    counts.used > 0 &&
    countReset !== undefined &&
    ratio.resetMs !== undefined &&
    Math.abs(countReset - ratio.resetMs) <= SAME_RESET_TOLERANCE_MS;
  if (ratio && !placeholder)
    return toWindow(args.id, ratio.usedPercent, args.minutes, ratio.resetMs);
  if (!counts) return undefined;
  // An unreliable counter keeps its 0% gauge but no duration, so it cannot
  // feed a pace forecast.
  return toWindow(
    args.id,
    (counts.used / counts.limit) * 100,
    counts.reliable ? (args.countMinutes ?? args.minutes) : undefined,
    countReset,
  );
}

/** Parse a `/coding/v1/usages` body into one snapshot, or none when it holds no window. */
function parseKimiCodeUsages(
  providerId: string,
  body: unknown,
  now: number = Date.now(),
): ProviderQuotaSnapshot[] {
  const json = record(body);
  if (!json) return [];
  const pools = record(json['usages']);
  const weeklyDetail = record(json['usage']);
  const firstLimit = Array.isArray(json['limits']) ? record(json['limits'][0]) : undefined;
  const sessionDetail = record(firstLimit?.['detail']);
  const sessionMinutes = windowMinutes(record(firstLimit?.['window']));
  const monthlyPool = record(pools?.['limit_month_total']);
  const hasMonthlyPool = ratioWindow(monthlyPool) !== undefined;
  const weeklyReliable = usageCounts(weeklyDetail)?.reliable === true;

  const windows: ProviderQuotaWindow[] = [];
  const session = resolveWindow({
    id: 'primary',
    pool: record(pools?.['limit_5h']),
    detail: sessionDetail,
    minutes: FIVE_HOURS,
    countMinutes: sessionDetail ? (sessionMinutes ?? FIVE_HOURS) : undefined,
    hasMonthlyPool,
    weeklyReliable,
  });
  if (session) windows.push(session);
  const weekly = resolveWindow({
    id: 'secondary',
    pool: record(pools?.['limit_7d']),
    detail: weeklyDetail,
    minutes: WEEK,
    countMinutes: weeklyDetail ? WEEK : undefined,
    hasMonthlyPool,
    weeklyReliable,
  });
  if (weekly) windows.push(weekly);
  const monthly = ratioWindow(monthlyPool);
  if (monthly)
    windows.push(toWindow('monthly', monthly.usedPercent, undefined, monthly.resetMs, 'month'));

  if (windows.length === 0) return [];
  return [
    {
      providerId,
      meterId: DEFAULT_QUOTA_METER,
      meterLabel: 'Kimi Code',
      windows,
      capturedAt: now,
    },
  ];
}

export interface KimiCodeQuotaReportOptions {
  apiKey: string;
  /** The region host the key was issued for; keys are region-bound. */
  host?: KimiCodeHost | undefined;
  fetchImpl?: typeof fetch | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
  now?: number | undefined;
}

/**
 * Read and record the Kimi Code plan quota. Resolves to the snapshots
 * recorded; silent on every failure, leaving the previous reading standing.
 */
export async function reportKimiCodeQuota(
  providerId: string,
  opts: KimiCodeQuotaReportOptions,
): Promise<ProviderQuotaSnapshot[]> {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs =
    typeof opts.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
      ? opts.timeoutMs
      : 10_000;
  try {
    const timeout = AbortSignal.timeout(timeoutMs);
    const res = await doFetch(kimiCodeUsagesUrl(opts.host), {
      headers: { accept: 'application/json', authorization: `Bearer ${opts.apiKey}` },
      signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
    });
    if (!res.ok) return [];
    const snapshots = parseKimiCodeUsages(providerId, await res.json(), opts.now ?? Date.now());
    if (snapshots.length > 0) recordProviderQuota(providerId, snapshots);
    return snapshots;
  } catch {
    return [];
  }
}
