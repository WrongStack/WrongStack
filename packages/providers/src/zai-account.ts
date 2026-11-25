/**
 * Z.AI / BigModel (Zhipu) account plane — the GLM Coding Plan quota and the
 * account reads behind the official ZCode client's usage panel.
 *
 * Nothing about the plan budget rides on an inference response: no rate-limit
 * headers, no usage trailer. ZCode (github.com/zai-org/ZCode,
 * `usage-stats/providers/bigmodelUsageQuotaProvider.ts`) reads it from the
 * account's monitor API, authenticated with the same API key the chat
 * endpoint takes — sent RAW in `authorization`, no `Bearer` prefix. These are
 * account reads: they spend none of the allowance they describe.
 *
 *   GET {origin}/api/monitor/usage/quota/limit
 *     { code: 200, success: true, data: { level: 'lite'|'pro'|'max', limits: [...] } }
 *
 * Each limit row (verified live 2026-09-30 on a Max plan):
 *
 *   type           TOKENS_LIMIT (BigModel/personal) · CREDIT_LIMIT (Z.AI team) —
 *                  the model budget; TIME_LIMIT — MCP tool calls
 *                  (web search / web reader / zread)
 *   unit, number   window length: unit 3 = hours (3,5 → the 5-hour window),
 *                  6 = weeks, 5 = months (anchored to the subscription day)
 *   percentage     USED share, 0..100 — ZCode inverts it for "remaining"
 *   nextResetTime  epoch ms
 *   TIME_LIMIT only: usage = the TOTAL allowance, currentValue = used,
 *                  remaining, usageDetails[{ modelCode, usage }] per tool
 *
 * Failures are HTTP 200 with a business envelope (`{code: 401, msg: 'token
 * expired or incorrect', success: false}`), so success is the envelope, never
 * the status.
 *
 * @module zai-account
 */

import {
  type ProviderQuotaSnapshot,
  type ProviderQuotaWindow,
  recordProviderQuota,
} from '@wrongstack/core/quota';
import { upstreamHost, upstreamUrl } from './proxy-upstream.js';

const QUOTA_PATH = '/api/monitor/usage/quota/limit';
const SUBSCRIPTION_PATH = '/api/biz/subscription/list';
const USAGE_DETAIL_PATH = '/api/monitor/credit-usage/usage-detail';
const ACTIVITY_PATH = '/api/monitor/credit-usage/activity';
const PERFORMANCE_PATH = '/api/monitor/usage/model-performance-day';

const ZAI_ORIGIN = 'https://api.z.ai';
const BIGMODEL_ORIGIN = 'https://open.bigmodel.cn';
/**
 * ZCode's business origin for BigModel account reads. The inference host
 * (`open.bigmodel.cn`) is tried first; this one is the fallback.
 */
const BIGMODEL_BUSINESS_ORIGIN = 'https://bigmodel.cn';

/** Which Zhipu deployment a host belongs to. Keys are bound to one of them. */
export type ZaiRegion = 'zai' | 'bigmodel';

/** Region of the Z.AI / BigModel host `url` reaches (proxied or not). */
export function zaiRegionOf(url: string | undefined): ZaiRegion | undefined {
  const host = upstreamHost(url);
  if (host === undefined) return undefined;
  if (host === 'z.ai' || host.endsWith('.z.ai')) return 'zai';
  if (host === 'bigmodel.cn' || host.endsWith('.bigmodel.cn')) return 'bigmodel';
  return undefined;
}

/**
 * True when `url` is a Coding Plan inference endpoint — the only traffic that
 * draws on the plan. The same key on the metered `/api/paas/v4` bills per
 * token, and showing it the plan's windows would describe a budget those
 * calls never touch.
 */
export function isZaiCodingPlanEndpoint(url: string | undefined): boolean {
  if (url === undefined || zaiRegionOf(url) === undefined) return false;
  let pathname: string;
  try {
    pathname = new URL(upstreamUrl(url)).pathname.toLowerCase();
  } catch {
    return false;
  }
  return /\/api\/coding\//.test(pathname) || /\/api\/anthropic(?:\/|$)/.test(pathname);
}

/** Account-read origins for a region, in the order they are tried. */
function zaiAccountOrigins(region: ZaiRegion): readonly string[] {
  return region === 'zai' ? [ZAI_ORIGIN] : [BIGMODEL_ORIGIN, BIGMODEL_BUSINESS_ORIGIN];
}

// ── Envelope ────────────────────────────────────────────────────────────────

interface Envelope {
  code?: unknown;
  msg?: unknown;
  success?: unknown;
  data?: unknown;
}

/** Both `code: 200` and `code: 0` are success envelopes on this API. */
function envelopeData(json: unknown): unknown {
  if (typeof json !== 'object' || json === null) return undefined;
  const env = json as Envelope;
  if (env.success === false) return undefined;
  if (env.code !== undefined && env.code !== null && env.code !== 0 && env.code !== 200) {
    return undefined;
  }
  return env.data;
}

function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function str(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

// ── Quota ───────────────────────────────────────────────────────────────────

const UNIT_HOURS = 3;
const UNIT_MONTHS = 5;
const UNIT_WEEKS = 6;

interface ZaiLimitRow {
  type?: unknown;
  unit?: unknown;
  number?: unknown;
  usage?: unknown;
  currentValue?: unknown;
  remaining?: unknown;
  percentage?: unknown;
  nextResetTime?: unknown;
  usageDetails?: unknown;
}

/** The model budget. Z.AI's team plan names it CREDIT_LIMIT; the meaning is identical. */
function isTokenLimit(type: string | undefined): boolean {
  return type === 'TOKENS_LIMIT' || type === 'CREDIT_LIMIT';
}

/**
 * Used percentage of a row: the reported `percentage` when present, else the
 * counts. On TIME_LIMIT rows `usage` is the TOTAL allowance and `currentValue`
 * the consumed part — the names read backwards, so the counts are only a
 * fallback.
 */
function usedPercentOf(row: ZaiLimitRow): number | undefined {
  const pct = num(row.percentage);
  if (pct !== undefined) return clampPercent(pct);
  const used = num(row.currentValue);
  const remaining = num(row.remaining);
  if (used !== undefined && remaining !== undefined && used + remaining > 0) {
    return clampPercent((used / (used + remaining)) * 100);
  }
  return undefined;
}

function tokenWindow(row: ZaiLimitRow, usedPercent: number): ProviderQuotaWindow {
  const unit = num(row.unit);
  const count = num(row.number) ?? 1;
  const resetMs = num(row.nextResetTime);
  const resetsAt = resetMs !== undefined && resetMs > 0 ? Math.floor(resetMs / 1000) : undefined;
  let id = `u${unit ?? '?'}n${count}`;
  let windowMinutes: number | undefined;
  let label: string | undefined;
  if (unit === UNIT_HOURS) {
    windowMinutes = count * 60;
    if (count === 5) id = 'primary';
  } else if (unit === UNIT_WEEKS) {
    windowMinutes = count * 10_080;
    id = 'secondary';
  } else if (unit === UNIT_MONTHS) {
    // A month has no fixed length; the plan anchors it to the subscription day.
    id = 'monthly';
    label = count === 1 ? 'month' : `${count}mo`;
  }
  return {
    id,
    usedPercent,
    ...(label !== undefined ? { label } : {}),
    ...(windowMinutes !== undefined ? { windowMinutes } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  };
}

/** One MCP tool's share of the monthly tool-call allowance. */
export interface ZaiToolUsage {
  tool: string;
  calls: number;
}

/** The monthly MCP tool-call allowance (web search, web reader, zread). */
export interface ZaiToolQuota {
  used: number;
  total: number | undefined;
  remaining: number | undefined;
  usedPercent: number | undefined;
  resetsAt: number | undefined;
  tools: ZaiToolUsage[];
}

/** A parsed `quota/limit` reading. */
export interface ZaiQuotaReading {
  level: string | undefined;
  windows: ProviderQuotaWindow[];
  tools: ZaiToolQuota | undefined;
}

function parseToolQuota(row: ZaiLimitRow): ZaiToolQuota | undefined {
  const used = num(row.currentValue);
  if (used === undefined) return undefined;
  const remaining = num(row.remaining);
  const total = num(row.usage) ?? (remaining !== undefined ? used + remaining : undefined);
  const resetMs = num(row.nextResetTime);
  const tools: ZaiToolUsage[] = [];
  if (Array.isArray(row.usageDetails)) {
    for (const detail of row.usageDetails) {
      if (typeof detail !== 'object' || detail === null) continue;
      const d = detail as { modelCode?: unknown; usage?: unknown };
      const tool = str(d.modelCode);
      if (tool !== undefined) tools.push({ tool, calls: num(d.usage) ?? 0 });
    }
  }
  return {
    used,
    total,
    remaining,
    usedPercent: usedPercentOf(row),
    resetsAt: resetMs !== undefined && resetMs > 0 ? Math.floor(resetMs / 1000) : undefined,
    tools,
  };
}

/** Parse a `quota/limit` body. Undefined for a failed envelope or no limits. */
function parseZaiQuota(json: unknown): ZaiQuotaReading | undefined {
  const data = envelopeData(json);
  if (typeof data !== 'object' || data === null) return undefined;
  const d = data as { level?: unknown; limits?: unknown };
  if (!Array.isArray(d.limits)) return undefined;
  const windows: ProviderQuotaWindow[] = [];
  let tools: ZaiToolQuota | undefined;
  for (const raw of d.limits) {
    if (typeof raw !== 'object' || raw === null) continue;
    const row = raw as ZaiLimitRow;
    const type = str(row.type);
    if (isTokenLimit(type)) {
      const usedPercent = usedPercentOf(row);
      if (usedPercent !== undefined) windows.push(tokenWindow(row, usedPercent));
    } else if (type === 'TIME_LIMIT') {
      tools = parseToolQuota(row) ?? tools;
    }
  }
  // Short window first, the way the ordering helpers expect.
  windows.sort((a, b) => (a.windowMinutes ?? Infinity) - (b.windowMinutes ?? Infinity));
  if (windows.length === 0 && tools === undefined) return undefined;
  return { level: str(d.level), windows, tools };
}

function formatDate(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

/**
 * The store's view of a reading.
 *
 * The model budget is one meter with its windows. The MCP tool allowance is
 * kept OUT of the windows on purpose: the status chip shows the single most
 * consumed window across every provider, and a monthly web-search pool at 95%
 * would paint "your plan is about to run out" while every model call still
 * goes through. It is recorded as a note on its own meter instead, where the
 * quota report shows it.
 */
export function zaiQuotaSnapshots(
  providerId: string,
  reading: ZaiQuotaReading,
  now: number = Date.now(),
): ProviderQuotaSnapshot[] {
  const planLabel = reading.level !== undefined ? `coding ${reading.level}` : undefined;
  const out: ProviderQuotaSnapshot[] = [];
  if (reading.windows.length > 0) {
    const reached = reading.windows.find((w) => w.usedPercent >= 100);
    out.push({
      providerId,
      meterId: 'default',
      meterLabel: 'GLM Coding Plan',
      ...(planLabel !== undefined ? { planLabel } : {}),
      windows: reading.windows,
      ...(reached !== undefined ? { reachedWindowId: reached.id } : {}),
      capturedAt: now,
    });
  }
  const tools = reading.tools;
  if (tools !== undefined) {
    const total = tools.total !== undefined ? `/${tools.total}` : '';
    const reset = tools.resetsAt !== undefined ? ` · resets ${formatDate(tools.resetsAt)}` : '';
    const breakdown = tools.tools
      .filter((t) => t.calls > 0)
      .map((t) => `${t.tool} ${t.calls}`)
      .join(', ');
    out.push({
      providerId,
      meterId: 'mcp-tools',
      meterLabel: 'MCP tool calls (web search / reader / zread)',
      ...(planLabel !== undefined ? { planLabel } : {}),
      windows: [],
      note: `${tools.used}${total} calls this month${breakdown ? ` (${breakdown})` : ''}${reset}`,
      capturedAt: now,
    });
  }
  return out;
}

/**
 * Milliseconds until the model window that is cutting the account off resets,
 * or undefined when no model window reads as exhausted. Several exhausted
 * windows: the account is usable only once all of them have reset.
 */
export function zaiQuotaResetInMs(
  reading: ZaiQuotaReading | undefined,
  now: number = Date.now(),
): number | undefined {
  let best: number | undefined;
  for (const window of reading?.windows ?? []) {
    if (window.usedPercent < 100 || window.resetsAt === undefined) continue;
    const ms = window.resetsAt * 1000 - now;
    if (ms > 0) best = best === undefined ? ms : Math.max(best, ms);
  }
  return best;
}

// ── Fetch ───────────────────────────────────────────────────────────────────

export interface ZaiAccountFetchOptions {
  apiKey: string;
  region: ZaiRegion;
  fetchImpl?: typeof fetch | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
}

/**
 * GET one account path, trying the region's origins in order. Resolves to the
 * envelope's `data`, or undefined when no origin answered with a success
 * envelope. Never throws.
 */
async function fetchZaiAccountData(path: string, opts: ZaiAccountFetchOptions): Promise<unknown> {
  const doFetch = opts.fetchImpl ?? fetch;
  for (const origin of zaiAccountOrigins(opts.region)) {
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? 10_000);
    try {
      const res = await doFetch(`${origin}${path}`, {
        headers: {
          accept: 'application/json',
          'accept-language': 'en-US,en',
          // Raw key, no `Bearer` — the monitor API's contract (ZCode sends it
          // this way; a Bearer-prefixed key is also accepted today, but the
          // raw form is the documented one).
          authorization: opts.apiKey,
        },
        signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
      });
      if (!res.ok) continue;
      const json: unknown = await res.json();
      const data = envelopeData(json);
      if (data !== undefined) return data;
    } catch {
      // Try the next origin; the caller treats "nothing" as "no reading".
    }
  }
  return undefined;
}

/** Read the plan quota. Undefined when it could not be read. */
async function fetchZaiQuota(opts: ZaiAccountFetchOptions): Promise<ZaiQuotaReading | undefined> {
  const data = await fetchZaiAccountData(QUOTA_PATH, opts);
  return data === undefined ? undefined : parseZaiQuota({ code: 200, data });
}

/**
 * Read the plan quota and record it under `providerId`. Resolves to the
 * reading, or undefined when nothing could be read — a reading that could
 * not be refreshed leaves the previous one standing.
 */
export async function reportZaiQuota(
  providerId: string,
  opts: ZaiAccountFetchOptions & { now?: number | undefined },
): Promise<ZaiQuotaReading | undefined> {
  const reading = await fetchZaiQuota(opts);
  if (reading === undefined) return undefined;
  const snapshots = zaiQuotaSnapshots(providerId, reading, opts.now ?? Date.now());
  if (snapshots.length > 0) recordProviderQuota(providerId, snapshots);
  return reading;
}

/**
 * True when `apiKey` authenticates against `region`'s account API. Used only
 * to explain a 401: Z.AI and BigModel are separate accounts with separate
 * keys, and a key sent to the other one fails with a bare "token expired or
 * incorrect". The probe is the quota read, which spends nothing.
 */
export async function zaiKeyAuthorizesIn(
  region: ZaiRegion,
  apiKey: string,
  opts: { fetchImpl?: typeof fetch | undefined; timeoutMs?: number | undefined } = {},
): Promise<boolean> {
  const data = await fetchZaiAccountData(QUOTA_PATH, {
    apiKey,
    region,
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 5_000,
  });
  return data !== undefined;
}

// ── Plan report ─────────────────────────────────────────────────────────────

/** The active Coding Plan subscription — product and renewal only, no billing detail. */
export interface ZaiSubscription {
  product: string;
  billingCycle: string | undefined;
  autoRenew: boolean;
  /** ISO date the plan renews (auto-renew on) or ends (off), when known. */
  renewsOrEndsOn: string | undefined;
}

export interface ZaiModelUsage {
  model: string;
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export interface ZaiUsageSummary {
  days: number;
  totalTokens: number;
  /** 0..1, as the server reports it. */
  cacheHitRate: number | undefined;
  /** 0..1 share of tokens spent in the off-peak window. */
  offPeakRate: number | undefined;
  models: ZaiModelUsage[];
  currentStreakDays: number | undefined;
  peakDay: { date: string; tokens: number } | undefined;
}

export interface ZaiServiceHealth {
  date: string;
  /** Decode speed in tokens/s and success rate 0..1, per plan tier. */
  lite: { tokensPerSecond: number | undefined; successRate: number | undefined };
  proMax: { tokensPerSecond: number | undefined; successRate: number | undefined };
}

export interface ZaiPlanReport {
  region: ZaiRegion;
  quota: ZaiQuotaReading | undefined;
  subscription: ZaiSubscription | undefined;
  usage: ZaiUsageSummary | undefined;
  health: ZaiServiceHealth | undefined;
}

/**
 * Pick the subscription that is in force now. The list is the account's whole
 * order history (renewals, gifted months, a queued annual plan); the one that
 * counts is VALID and `inCurrentPeriod` — the same rule ZCode applies.
 */
function parseZaiSubscription(data: unknown): ZaiSubscription | undefined {
  if (!Array.isArray(data)) return undefined;
  for (const raw of data) {
    if (typeof raw !== 'object' || raw === null) continue;
    const row = raw as Record<string, unknown>;
    const product = str(row['productName']) ?? str(row['productId']);
    if (product === undefined || !/coding/i.test(product)) continue;
    if (row['status'] !== 'VALID' || row['inCurrentPeriod'] !== true) continue;
    const autoRenew = row['autoRenew'] === true || row['autoRenew'] === 1;
    // Auto-renew on: `nextRenewTime` is the next charge. Off: it is when the
    // current term ends. `valid` ("start-end") is the fallback end.
    const next = str(row['nextRenewTime']);
    const validEnd = str(row['valid'])
      ?.match(/\d{4}-\d{2}-\d{2}/g)
      ?.at(-1);
    return {
      product,
      billingCycle: str(row['billingCycle']),
      autoRenew,
      renewsOrEndsOn: next?.slice(0, 10) ?? validEnd,
    };
  }
  return undefined;
}

function sumSeries(value: unknown): number {
  if (!Array.isArray(value)) return 0;
  let total = 0;
  for (const v of value) total += num(v) ?? 0;
  return total;
}

function rate(value: unknown): number | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  return num((value as { value?: unknown }).value);
}

/** Parse `credit-usage/usage-detail` (MODEL) + `credit-usage/activity`. */
function parseZaiUsage(
  detail: unknown,
  activity: unknown,
  days: number,
): ZaiUsageSummary | undefined {
  if (typeof detail !== 'object' || detail === null) return undefined;
  const d = detail as { summary?: unknown; modelUsage?: unknown };
  const summary = (d.summary ?? {}) as Record<string, unknown>;
  const modelUsage = (d.modelUsage ?? {}) as { totalUsage?: unknown; modelDataList?: unknown };
  const models: ZaiModelUsage[] = [];
  if (Array.isArray(modelUsage.modelDataList)) {
    for (const raw of modelUsage.modelDataList) {
      if (typeof raw !== 'object' || raw === null) continue;
      const m = raw as Record<string, unknown>;
      const model = str(m['modelName']) ?? str(m['modelCode']);
      if (model === undefined) continue;
      models.push({
        model,
        totalTokens: sumSeries(m['totalTokensUsage']),
        inputTokens: sumSeries(m['inputTokensUsage']),
        cachedInputTokens: sumSeries(m['cachedInputTokensUsage']),
        outputTokens: sumSeries(m['outputTokensUsage']),
      });
    }
  }
  models.sort((a, b) => b.totalTokens - a.totalTokens);
  const total =
    num((modelUsage.totalUsage as { totalTokens?: unknown } | undefined)?.totalTokens) ??
    models.reduce((sum, m) => sum + m.totalTokens, 0);

  let currentStreakDays: number | undefined;
  let peakDay: ZaiUsageSummary['peakDay'];
  if (typeof activity === 'object' && activity !== null) {
    const s = ((activity as { summary?: unknown }).summary ?? {}) as Record<string, unknown>;
    currentStreakDays = num(s['currentStreakDays']);
    const peakTokens = num(s['peakDailyTokens']);
    const peakDate = str(s['peakDailyTokensDate']);
    if (peakTokens !== undefined && peakDate !== undefined) {
      peakDay = { date: peakDate, tokens: peakTokens };
    }
  }
  return {
    days,
    totalTokens: total,
    cacheHitRate: rate(summary['cacheHitRate']),
    offPeakRate: rate(summary['offPeakUsageRate']),
    models,
    currentStreakDays,
    peakDay,
  };
}

/** Latest day of `model-performance-day`. */
function parseZaiHealth(data: unknown): ZaiServiceHealth | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const d = data as Record<string, unknown>;
  const days = d['x_time'];
  if (!Array.isArray(days) || days.length === 0) return undefined;
  const i = days.length - 1;
  const at = (key: string): number | undefined => {
    const series = d[key];
    return Array.isArray(series) ? num(series[i]) : undefined;
  };
  const date = str(days[i]);
  if (date === undefined) return undefined;
  return {
    date,
    lite: { tokensPerSecond: at('liteDecodeSpeed'), successRate: at('liteSuccessRate') },
    proMax: { tokensPerSecond: at('proMaxDecodeSpeed'), successRate: at('proMaxSuccessRate') },
  };
}

function localDateKey(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** `startTime`/`endTime` query for the last `days` local days, the monitor API's format. */
function rangeQuery(days: number, now: Date): string {
  const start = new Date(now);
  start.setDate(start.getDate() - (days - 1));
  // Percent-encoded by hand: URLSearchParams writes the space as `+`, and the
  // verified form of this query is `%20`.
  const startTime = encodeURIComponent(`${localDateKey(start)} 00:00:00`);
  const endTime = encodeURIComponent(`${localDateKey(now)} 23:59:59`);
  return `startTime=${startTime}&endTime=${endTime}`;
}

/**
 * Everything the ZCode usage panel shows for a personal Coding Plan, fetched
 * in parallel. Each part is independent: one failing read blanks only its own
 * section. Team plans need organization/project headers that only ZCode's
 * OAuth login carries, so this reads the personal plan the key belongs to.
 */
export async function fetchZaiPlanReport(
  opts: ZaiAccountFetchOptions & { days?: number | undefined; now?: Date | undefined },
): Promise<ZaiPlanReport> {
  const days =
    typeof opts.days === 'number' && Number.isFinite(opts.days) && opts.days >= 1
      ? Math.floor(opts.days)
      : 7;
  const now =
    opts.now instanceof Date && Number.isFinite(opts.now.getTime()) ? opts.now : new Date();
  const range = rangeQuery(days, now);
  const [quota, subscription, detail, activity, performance] = await Promise.all([
    fetchZaiQuota(opts),
    fetchZaiAccountData(SUBSCRIPTION_PATH, opts),
    fetchZaiAccountData(`${USAGE_DETAIL_PATH}?type=1&usageType=MODEL&${range}`, opts),
    fetchZaiAccountData(`${ACTIVITY_PATH}?type=1&${range}`, opts),
    fetchZaiAccountData(`${PERFORMANCE_PATH}?${range}`, opts),
  ]);
  return {
    region: opts.region,
    quota,
    subscription: parseZaiSubscription(subscription),
    usage: parseZaiUsage(detail, activity, days),
    health: parseZaiHealth(performance),
  };
}
