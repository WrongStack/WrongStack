/**
 * Pay-as-you-go balances — DeepSeek, Moonshot (Kimi Open Platform) and
 * SiliconFlow. None of them has a plan window; what runs out is the prepaid
 * balance, so each reading is one `balance` meter carrying credits only.
 *
 * All three are documented account reads that spend nothing, authenticated by
 * the inference key (`Authorization: Bearer`):
 *
 *   DeepSeek     GET https://api.deepseek.com/user/balance
 *                { is_available, balance_infos: [{ currency, total_balance: "110.00", … }] }
 *   Moonshot     GET https://api.moonshot.{ai,cn}/v1/users/me/balance
 *                { code: 0, status: true, data: { available_balance: 49.58, … } }
 *   SiliconFlow  GET https://api.siliconflow.{com,cn}/v1/user/info
 *                { code: 20000, status: true, data: { totalBalance: "88.00", … } }
 *
 * Moonshot and SiliconFlow report a bare number; the currency is the region's
 * (USD on the international host, CNY on the China one). SiliconFlow's body
 * also carries profile fields — only the balance is read.
 *
 * @module balance-quota
 */

import {
  type ProviderQuotaCredits,
  type ProviderQuotaSnapshot,
  recordProviderQuota,
} from '@wrongstack/core/quota';

export type BalanceVendor = 'deepseek' | 'moonshot' | 'siliconflow';

type Json = Record<string, unknown>;

function record(value: unknown): Json | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Json)
    : undefined;
}

/** Amounts arrive as numbers or decimal strings (`"110.00"`). */
function amount(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value);
  return undefined;
}

const SYMBOL: Readonly<Record<string, string>> = { USD: '$', CNY: '¥' };

export function formatBalance(value: number, currency: string): string {
  const safeValue = Number.isFinite(value) ? value : 0;
  const rounded = Math.round(safeValue * 100) / 100;
  const sign = rounded < 0 ? '-' : '';
  const abs = Math.abs(rounded).toFixed(2);
  const symbol = Object.hasOwn(SYMBOL, currency) ? SYMBOL[currency] : undefined;
  return symbol ? `${sign}${symbol}${abs}` : `${sign}${abs} ${currency}`;
}

function parseDeepSeek(body: unknown): ProviderQuotaCredits | undefined {
  const json = record(body);
  const infos = json?.['balance_infos'];
  if (!Array.isArray(infos)) return undefined;
  const parts: string[] = [];
  let positive = false;
  for (const raw of infos) {
    const info = record(raw);
    const total = amount(info?.['total_balance']);
    const currency = info?.['currency'];
    if (total === undefined || typeof currency !== 'string') continue;
    parts.push(formatBalance(total, currency));
    if (total > 0) positive = true;
  }
  if (parts.length === 0) return undefined;
  const available = json?.['is_available'];
  return {
    hasCredits: typeof available === 'boolean' ? available : positive,
    unlimited: false,
    balance: parts.join(' + '),
  };
}

function parseSingle(
  body: unknown,
  field: string,
  currency: string,
): ProviderQuotaCredits | undefined {
  const json = record(body);
  if (json?.['status'] === false) return undefined;
  const value = amount(record(json?.['data'])?.[field]);
  if (value === undefined) return undefined;
  return { hasCredits: value > 0, unlimited: false, balance: formatBalance(value, currency) };
}

export interface BalanceEndpoint {
  url: string;
  label: string;
  parse: (body: unknown) => ProviderQuotaCredits | undefined;
}

/** The read for a vendor on a given API host, or undefined for an unknown host. */
export function balanceEndpoint(vendor: BalanceVendor, host: string): BalanceEndpoint | undefined {
  switch (vendor) {
    case 'deepseek':
      return host === 'api.deepseek.com'
        ? { url: 'https://api.deepseek.com/user/balance', label: 'DeepSeek', parse: parseDeepSeek }
        : undefined;
    case 'moonshot': {
      if (host !== 'api.moonshot.ai' && host !== 'api.moonshot.cn') return undefined;
      const currency = host.endsWith('.cn') ? 'CNY' : 'USD';
      return {
        url: `https://${host}/v1/users/me/balance`,
        label: 'Moonshot',
        parse: (body) => parseSingle(body, 'available_balance', currency),
      };
    }
    case 'siliconflow': {
      if (host !== 'api.siliconflow.com' && host !== 'api.siliconflow.cn') return undefined;
      const currency = host.endsWith('.cn') ? 'CNY' : 'USD';
      return {
        url: `https://${host}/v1/user/info`,
        label: 'SiliconFlow',
        parse: (body) => parseSingle(body, 'totalBalance', currency),
      };
    }
  }
}

/** The vendor whose balance lives on an API host, if any. */
export function balanceVendorOfHost(host: string): BalanceVendor | undefined {
  if (host === 'api.deepseek.com') return 'deepseek';
  if (host === 'api.moonshot.ai' || host === 'api.moonshot.cn') return 'moonshot';
  if (host === 'api.siliconflow.com' || host === 'api.siliconflow.cn') return 'siliconflow';
  return undefined;
}

export interface BalanceReportOptions {
  apiKey: string;
  fetchImpl?: typeof fetch | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
  now?: number | undefined;
}

/**
 * Read and record a prepaid balance. Resolves to the snapshots recorded;
 * silent on every failure, leaving the previous reading standing.
 */
export async function reportBalanceQuota(
  providerId: string,
  endpoint: BalanceEndpoint,
  opts: BalanceReportOptions,
): Promise<ProviderQuotaSnapshot[]> {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs =
    typeof opts.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
      ? opts.timeoutMs
      : 10_000;
  try {
    const timeout = AbortSignal.timeout(timeoutMs);
    const res = await doFetch(endpoint.url, {
      headers: { accept: 'application/json', authorization: `Bearer ${opts.apiKey}` },
      signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
    });
    if (!res.ok) return [];
    const credits = endpoint.parse(await res.json());
    if (!credits) return [];
    const snapshot: ProviderQuotaSnapshot = {
      providerId,
      meterId: 'balance',
      meterLabel: endpoint.label,
      windows: [],
      credits,
      capturedAt: opts.now ?? Date.now(),
    };
    recordProviderQuota(providerId, [snapshot]);
    return [snapshot];
  } catch {
    return [];
  }
}
