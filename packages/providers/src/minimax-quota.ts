/**
 * MiniMax Token Plan quota reporter — `GET /v1/token_plan/remains`.
 *
 * MiniMax puts nothing about the plan's budget on an inference response: no
 * rate-limit headers, no usage trailer. The 5-hour rolling window and the
 * weekly window a Token Plan meters against live behind a separate account
 * endpoint, so — like Copilot and Antigravity — this reporter has to ask.
 *
 * Asking is cheap for the reason that matters: `token_plan/remains` is an
 * account read, not a model call, so it spends none of the allowance it
 * describes. It is still bound to moments that have already earned it (a
 * completed turn, a quota failure) rather than a timer.
 *
 * A pay-as-you-go secret key (`sk-api-…`) has no plan to meter. Its budget is
 * the account balance, read from `GET /account/query_balance` and recorded as
 * credits instead of windows. The prefix is how MiniMax's own CLI picks the
 * endpoint; the plan endpoint answers such a key with an error anyway.
 *
 * Response shape (`token_plan/remains`, the fields this reads):
 *
 *   base_resp.status_code                 0 on success
 *   model_remains[]                       one row per metered model family
 *     .model_name                         `MiniMax-M*` (glob), `speech-hd`, `general`, …
 *     .start_time / .end_time             current short window, epoch ms
 *     .remains_time                       ms until that window resets
 *     .current_interval_total_count       allowance in the short window
 *     .current_interval_usage_count       AMBIGUOUS — see resolveMiniMaxQuotaCounts
 *     .current_interval_remaining_percent 0..100, authoritative when present
 *     .current_interval_status            1 normal · 2 exhausted · 3 unlimited
 *     .current_weekly_*                   the same, for the weekly window
 *     .weekly_start_time / .weekly_end_time
 *     .weekly_boost_permille              DISPLAY multiplier only (1500 ⇒ "150%")
 *
 * @module minimax-quota
 */

import {
  type ProviderQuotaCredits,
  type ProviderQuotaSnapshot,
  type ProviderQuotaWindow,
  recordProviderQuota,
} from '@wrongstack/core/quota';

const MINIMAX_QUOTA_PATH = '/v1/token_plan/remains';
const MINIMAX_BALANCE_PATH = '/account/query_balance';

/** Server status for a quota window: 1 normal, 2 exhausted, 3 unlimited. */
const STATUS_EXHAUSTED = 2;
const STATUS_UNLIMITED = 3;

/** A secret API key bills pay-as-you-go; everything else is a plan key. */
function isMiniMaxPayAsYouGoKey(apiKey: string): boolean {
  return apiKey.startsWith('sk-api-');
}

interface MiniMaxModelRemain {
  model_name?: unknown;
  start_time?: unknown;
  end_time?: unknown;
  remains_time?: unknown;
  current_interval_total_count?: unknown;
  current_interval_usage_count?: unknown;
  current_interval_remaining_percent?: unknown;
  current_interval_status?: unknown;
  current_weekly_total_count?: unknown;
  current_weekly_usage_count?: unknown;
  current_weekly_remaining_percent?: unknown;
  current_weekly_status?: unknown;
  weekly_start_time?: unknown;
  weekly_end_time?: unknown;
  weekly_remains_time?: unknown;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function str(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function baseRespOk(body: Record<string, unknown>): boolean {
  const baseResp = body['base_resp'];
  if (typeof baseResp !== 'object' || baseResp === null) return true;
  const code = (baseResp as { status_code?: unknown }).status_code;
  return code === undefined || code === 0;
}

/**
 * Used percentage for one window.
 *
 * The `*_usage_count` fields have shipped with both meanings under the same
 * name: older responses report the REMAINING count, newer ones the CONSUMED
 * count. The `*_remaining_percent` field is unambiguous, so it wins whenever
 * present. Without it the legacy remaining-count reading stands — the same
 * rule MiniMax's own CLI applies.
 *
 * Returns undefined when neither the percentage nor the counts are usable.
 */
function resolveMiniMaxUsedPercent(
  reportedCount: number | undefined,
  total: number | undefined,
  remainingPercent: number | undefined,
): number | undefined {
  // The percentage is the authoritative reading whenever it is present; the
  // counts only disambiguate it or stand in for it.
  if (remainingPercent !== undefined) return clampPercent(100 - remainingPercent);
  if (
    reportedCount === undefined ||
    total === undefined ||
    total <= 0 ||
    reportedCount < 0 ||
    reportedCount > total
  ) {
    return undefined;
  }
  return clampPercent(((total - reportedCount) / total) * 100);
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

/**
 * Text-generation meters only. The plan also meters speech, image and video
 * models; those are irrelevant to a coding agent, and an untouched image
 * bucket read under the legacy count interpretation would otherwise surface
 * as the "worst" window and paint the status chip red for no reason.
 */
function isTextMeter(modelName: string): boolean {
  return /^minimax-m/i.test(modelName) || /^(?:general|text)$/i.test(modelName);
}

function windowMinutes(start: number | undefined, end: number | undefined): number | undefined {
  if (start === undefined || end === undefined || end <= start) return undefined;
  return Math.round((end - start) / 60_000);
}

function resetSeconds(
  end: number | undefined,
  remainsMs: number | undefined,
  now: number,
): number | undefined {
  if (end !== undefined && end > 0) return Math.floor(end / 1000);
  if (remainsMs !== undefined && remainsMs >= 0) return Math.floor((now + remainsMs) / 1000);
  return undefined;
}

function parseRemain(
  providerId: string,
  row: MiniMaxModelRemain,
  now: number,
): ProviderQuotaSnapshot | undefined {
  const name = str(row.model_name);
  if (name === undefined || !isTextMeter(name)) return undefined;

  const intervalTotal = num(row.current_interval_total_count);
  const weeklyTotal = num(row.current_weekly_total_count);
  const intervalStatus = num(row.current_interval_status);
  const weeklyStatus = num(row.current_weekly_status);
  // Both windows "unlimited" with zero allowance is how the API says the model
  // is not part of this plan at all — not that it is free to use.
  if (
    intervalTotal === 0 &&
    weeklyTotal === 0 &&
    intervalStatus === STATUS_UNLIMITED &&
    weeklyStatus === STATUS_UNLIMITED
  ) {
    return undefined;
  }

  const windows: ProviderQuotaWindow[] = [];
  let reachedWindowId: string | undefined;

  if (intervalStatus !== STATUS_UNLIMITED) {
    const usedPercent =
      intervalStatus === STATUS_EXHAUSTED
        ? 100
        : resolveMiniMaxUsedPercent(
            num(row.current_interval_usage_count),
            intervalTotal,
            num(row.current_interval_remaining_percent),
          );
    if (usedPercent !== undefined) {
      const minutes = windowMinutes(num(row.start_time), num(row.end_time));
      const resetsAt = resetSeconds(num(row.end_time), num(row.remains_time), now);
      windows.push({
        id: 'primary',
        usedPercent,
        ...(minutes !== undefined ? { windowMinutes: minutes } : {}),
        ...(resetsAt !== undefined ? { resetsAt } : {}),
      });
      if (intervalStatus === STATUS_EXHAUSTED) reachedWindowId = 'primary';
    }
  }

  // A weekly total of 0 with no percentage means the plan has no weekly cap
  // for this model; a bar for it would be a permanent, meaningless 0% or 100%.
  const weeklyPercent = num(row.current_weekly_remaining_percent);
  if (weeklyStatus !== STATUS_UNLIMITED && !(weeklyTotal === 0 && weeklyPercent === undefined)) {
    // `weekly_boost_permille` is deliberately ignored: it scales the DISPLAYED
    // remaining value (up to 150%+), not the budget, and a used-percent below
    // zero would read as "more than empty".
    const usedPercent =
      weeklyStatus === STATUS_EXHAUSTED
        ? 100
        : resolveMiniMaxUsedPercent(
            num(row.current_weekly_usage_count),
            weeklyTotal,
            weeklyPercent,
          );
    if (usedPercent !== undefined) {
      const minutes = windowMinutes(num(row.weekly_start_time), num(row.weekly_end_time));
      const resetsAt = resetSeconds(num(row.weekly_end_time), num(row.weekly_remains_time), now);
      windows.push({
        id: 'secondary',
        usedPercent,
        ...(minutes !== undefined ? { windowMinutes: minutes } : {}),
        ...(resetsAt !== undefined ? { resetsAt } : {}),
      });
      if (weeklyStatus === STATUS_EXHAUSTED && reachedWindowId === undefined) {
        reachedWindowId = 'secondary';
      }
    }
  }

  if (windows.length === 0) return undefined;
  return {
    providerId,
    meterId: name,
    meterLabel: name,
    planLabel: 'token plan',
    windows,
    ...(reachedWindowId !== undefined ? { reachedWindowId } : {}),
    capturedAt: now,
  };
}

/** Turn a `token_plan/remains` body into one snapshot per text meter. */
function parseMiniMaxQuota(
  providerId: string,
  body: unknown,
  now: number = Date.now(),
): ProviderQuotaSnapshot[] {
  if (typeof body !== 'object' || body === null) return [];
  const json = body as Record<string, unknown>;
  if (!baseRespOk(json)) return [];
  const rows = json['model_remains'];
  if (!Array.isArray(rows)) return [];
  const out: ProviderQuotaSnapshot[] = [];
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const snapshot = parseRemain(providerId, row as MiniMaxModelRemain, now);
    if (snapshot) out.push(snapshot);
  }
  return out;
}

/** Turn an `account/query_balance` body into a credits-only snapshot. */
function parseMiniMaxBalance(
  providerId: string,
  body: unknown,
  now: number = Date.now(),
): ProviderQuotaSnapshot[] {
  if (typeof body !== 'object' || body === null) return [];
  const json = body as Record<string, unknown>;
  if (!baseRespOk(json)) return [];
  const raw = json['available_amount'];
  const balance = typeof raw === 'number' ? String(raw) : str(raw);
  if (balance === undefined) return [];
  const amount = Number(balance);
  const credits: ProviderQuotaCredits = {
    hasCredits: Number.isFinite(amount) ? amount > 0 : true,
    unlimited: false,
    balance,
  };
  return [
    {
      providerId,
      meterId: 'balance',
      meterLabel: 'pay-as-you-go balance',
      windows: [],
      credits,
      capturedAt: now,
    },
  ];
}

/**
 * Milliseconds until the window that is cutting the account off resets.
 *
 * Prefers the window the server marked exhausted; failing that, the most
 * consumed window at or past 100%. Undefined when nothing is exhausted — a
 * quota error on a plan that reads as healthy is a different failure, and
 * inventing a reset for it would park the model for no reason.
 */
export function miniMaxQuotaResetInMs(
  snapshots: readonly ProviderQuotaSnapshot[],
  now: number = Date.now(),
): number | undefined {
  let best: number | undefined;
  for (const snapshot of snapshots) {
    for (const window of snapshot.windows) {
      const exhausted = snapshot.reachedWindowId === window.id || window.usedPercent >= 100;
      if (!exhausted || window.resetsAt === undefined || !Number.isFinite(window.resetsAt))
        continue;
      const ms = window.resetsAt * 1000 - now;
      if (!Number.isFinite(ms) || ms <= 0) continue;
      // Several exhausted windows: the account is usable only once ALL of
      // them have reset, so the latest reset is the honest wait.
      best = best === undefined ? ms : Math.max(best, ms);
    }
  }
  return best;
}

export interface MiniMaxQuotaReportOptions {
  apiKey: string;
  /** API root, e.g. `https://api.minimax.io` (no `/v1`, no `/anthropic`). */
  root: string;
  fetchImpl?: typeof fetch | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
  now?: number | undefined;
}

/**
 * Read the account's plan quota (or balance, for a pay-as-you-go key) and
 * record it. Resolves to the snapshots recorded, or an empty array when
 * nothing could be read.
 *
 * Silent on every failure: callers run this detached from the turn, or use it
 * only to sharpen an error that is already being thrown. A reading that could
 * not be refreshed leaves the previous one standing.
 */
export async function reportMiniMaxQuota(
  providerId: string,
  opts: MiniMaxQuotaReportOptions,
): Promise<ProviderQuotaSnapshot[]> {
  const doFetch = opts.fetchImpl ?? fetch;
  const payAsYouGo = isMiniMaxPayAsYouGoKey(opts.apiKey);
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 10_000);
  try {
    const res = await doFetch(
      `${opts.root}${payAsYouGo ? MINIMAX_BALANCE_PATH : MINIMAX_QUOTA_PATH}`,
      {
        headers: { accept: 'application/json', authorization: `Bearer ${opts.apiKey}` },
        signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
      },
    );
    if (!res.ok) return [];
    const json: unknown = await res.json();
    const now = opts.now ?? Date.now();
    const snapshots = payAsYouGo
      ? parseMiniMaxBalance(providerId, json, now)
      : parseMiniMaxQuota(providerId, json, now);
    if (snapshots.length > 0) recordProviderQuota(providerId, snapshots);
    return snapshots;
  } catch {
    return [];
  }
}

/**
 * True when `apiKey` authenticates against the MiniMax deployment at `root`.
 *
 * Used only to explain a 401: MiniMax keys are bound to the region that issued
 * them, and a China-region key sent to the international host (or the reverse)
 * fails with a bare "invalid api key" that never names the real cause. The
 * probe hits the quota endpoint, which is an account read and spends nothing.
 */
export async function miniMaxKeyAuthorizesAt(
  root: string,
  apiKey: string,
  opts: { fetchImpl?: typeof fetch | undefined; timeoutMs?: number | undefined } = {},
): Promise<boolean> {
  const doFetch = opts.fetchImpl ?? fetch;
  try {
    const res = await doFetch(
      `${root}${isMiniMaxPayAsYouGoKey(apiKey) ? MINIMAX_BALANCE_PATH : MINIMAX_QUOTA_PATH}`,
      {
        headers: { accept: 'application/json', authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 5_000),
      },
    );
    if (!res.ok) return false;
    const json: unknown = await res.json();
    // Require an explicit success envelope: a 200 without `base_resp` proves
    // nothing about the key (a captive portal or proxy page answers 200 too).
    if (typeof json !== 'object' || json === null) return false;
    const baseResp = (json as { base_resp?: unknown }).base_resp;
    return (
      typeof baseResp === 'object' &&
      baseResp !== null &&
      (baseResp as { status_code?: unknown }).status_code === 0
    );
  } catch {
    return false;
  }
}
