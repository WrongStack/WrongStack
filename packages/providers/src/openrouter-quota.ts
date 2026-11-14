/**
 * OpenRouter account limits — `GET /api/v1/key` and `GET /api/v1/credits`.
 *
 * Both are documented account reads (openrouter.ai/docs/api/reference/limits)
 * and spend nothing. Verified live 2026-09-30 with an ordinary inference key.
 *
 *   /key      { data: { limit, limit_remaining, limit_reset, is_free_tier,
 *                       free_model_daily_requests: { used, limit, remaining } } }
 *   /credits  { data: { total_credits, total_usage } }            (USD)
 *
 * OpenRouter is pay-as-you-go, so the "plan" is three separate things:
 * - the daily request allowance for free (`:free`) models,
 * - an optional per-key USD spending cap (`limit`, `null` = none) that may
 *   reset daily/weekly/monthly,
 * - the account's credit balance (`total_credits - total_usage`).
 *
 * No reset timestamp is reported for either window, so none is invented; the
 * window length alone is recorded.
 *
 * @module openrouter-quota
 */

import {
  DEFAULT_QUOTA_METER,
  type ProviderQuotaCredits,
  type ProviderQuotaSnapshot,
  type ProviderQuotaWindow,
  recordProviderQuota,
} from '@wrongstack/core/quota';

const OPENROUTER_API_ROOT = 'https://openrouter.ai/api/v1';

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

const RESET_MINUTES: Readonly<Record<string, number>> = Object.assign(Object.create(null), {
  daily: 1440,
  weekly: 10_080,
});
const RESET_LABEL: Readonly<Record<string, string>> = Object.assign(Object.create(null), {
  daily: 'key/day',
  weekly: 'key/week',
  monthly: 'key/month',
});

/** The windows `/key` describes, in display order. */
function parseOpenRouterKey(body: unknown): {
  windows: ProviderQuotaWindow[];
  freeTier: boolean;
} {
  const data = record(record(body)?.['data']);
  const windows: ProviderQuotaWindow[] = [];
  if (!data) return { windows, freeTier: false };

  const free = record(data['free_model_daily_requests']);
  const freeLimit = finite(free?.['limit']);
  const freeUsed = finite(free?.['used']);
  if (freeLimit !== undefined && freeLimit > 0 && freeUsed !== undefined && freeUsed >= 0) {
    windows.push({
      id: 'free-daily',
      label: 'free/day',
      usedPercent: clampPercent((freeUsed / freeLimit) * 100),
      windowMinutes: 1440,
    });
  }

  const limit = finite(data['limit']);
  const remaining = finite(data['limit_remaining']);
  if (limit !== undefined && limit > 0 && remaining !== undefined) {
    const reset = typeof data['limit_reset'] === 'string' ? data['limit_reset'] : undefined;
    const minutes = reset ? RESET_MINUTES[reset] : undefined;
    windows.push({
      id: 'key-limit',
      label: (reset && RESET_LABEL[reset]) || 'key limit',
      usedPercent: clampPercent(((limit - remaining) / limit) * 100),
      ...(minutes !== undefined ? { windowMinutes: minutes } : {}),
    });
  }
  return { windows, freeTier: data['is_free_tier'] === true };
}

/** The credit balance `/credits` describes, or undefined when unreadable. */
function parseOpenRouterCredits(body: unknown): ProviderQuotaCredits | undefined {
  const data = record(record(body)?.['data']);
  const total = finite(data?.['total_credits']);
  const used = finite(data?.['total_usage']);
  if (total === undefined || used === undefined) return undefined;
  const balance = total - used;
  const rounded = Math.round(balance * 100) / 100;
  return {
    hasCredits: balance > 0,
    unlimited: false,
    balance: `${rounded < 0 ? '-' : ''}$${Math.abs(rounded).toFixed(2)}`,
  };
}

export interface OpenRouterQuotaReportOptions {
  apiKey: string;
  fetchImpl?: typeof fetch | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
  now?: number | undefined;
}

async function getJson(
  doFetch: typeof fetch,
  url: string,
  apiKey: string,
  signal: AbortSignal,
): Promise<unknown> {
  try {
    const res = await doFetch(url, {
      headers: { accept: 'application/json', authorization: `Bearer ${apiKey}` },
      signal,
    });
    return res.ok ? await res.json() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read and record the OpenRouter limits and balance. Either read may fail on
 * its own; whatever arrived is recorded. Silent on every failure.
 */
export async function reportOpenRouterQuota(
  providerId: string,
  opts: OpenRouterQuotaReportOptions,
): Promise<ProviderQuotaSnapshot[]> {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 10_000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const [keyBody, creditsBody] = await Promise.all([
    getJson(doFetch, `${OPENROUTER_API_ROOT}/key`, opts.apiKey, signal),
    getJson(doFetch, `${OPENROUTER_API_ROOT}/credits`, opts.apiKey, signal),
  ]);
  const key = keyBody === undefined ? undefined : parseOpenRouterKey(keyBody);
  const credits = creditsBody === undefined ? undefined : parseOpenRouterCredits(creditsBody);
  if (!key?.windows.length && !credits) return [];
  const snapshot: ProviderQuotaSnapshot = {
    providerId,
    meterId: DEFAULT_QUOTA_METER,
    meterLabel: 'OpenRouter',
    ...(key?.freeTier ? { planLabel: 'free tier' } : {}),
    windows: key?.windows ?? [],
    ...(credits ? { credits } : {}),
    capturedAt: opts.now ?? Date.now(),
  };
  recordProviderQuota(providerId, [snapshot]);
  return [snapshot];
}
