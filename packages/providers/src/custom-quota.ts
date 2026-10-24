/**
 * Config-described plan quota — `ProviderConfig.quotaEndpoint`.
 *
 * For a provider the built-in readers do not know (a New-API / one-api relay,
 * a private gateway, a new vendor), the user names the account endpoint and
 * the JSON paths of its numbers; this reads it with the provider's active key
 * and records one window and/or a balance.
 *
 * The key only ever goes to the provider's own host: an endpoint on any other
 * host is refused, so a config (the in-project one included) cannot turn the
 * read into a way of sending the key elsewhere. `http:` is accepted on
 * loopback only.
 *
 * @module custom-quota
 */

import type { ProviderConfig } from '@wrongstack/contracts/types';
import {
  type ProviderQuotaCredits,
  type ProviderQuotaSnapshot,
  type ProviderQuotaWindow,
  recordProviderQuota,
} from '@wrongstack/core/quota';
import { formatBalance } from './balance-quota.js';
import { upstreamUrl } from './proxy-upstream.js';

export type QuotaEndpointConfig = NonNullable<ProviderConfig['quotaEndpoint']>;

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(upstreamUrl(url)).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * The endpoint URL when it is safe to send the provider's key to: https (or
 * http on loopback) and on the same host as the provider's base URL.
 */
function customQuotaUrl(
  endpoint: QuotaEndpointConfig,
  baseUrl: string | undefined,
): string | undefined {
  if (typeof endpoint.url !== 'string') return undefined;
  let url: URL;
  try {
    url = new URL(endpoint.url);
  } catch {
    return undefined;
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(host))) {
    return undefined;
  }
  if (url.username || url.password) return undefined;
  return host === hostOf(baseUrl) ? url.toString() : undefined;
}

/** Follow a dot path (`data.items.0.used`, `$.` prefix allowed). */
function at(body: unknown, path: string | undefined): unknown {
  if (!path) return undefined;
  const segments = path
    .replace(/^\$\.?/, '')
    .split('.')
    .filter(Boolean);
  let node: unknown = body;
  for (const segment of segments) {
    if (node === null || typeof node !== 'object') return undefined;
    if (segment === '__proto__' || segment === 'constructor' || segment === 'prototype') {
      return undefined;
    }
    node = Array.isArray(node)
      ? /^\d+$/.test(segment)
        ? node[Number(segment)]
        : undefined
      : Object.hasOwn(node, segment)
        ? (node as Record<string, unknown>)[segment]
        : undefined;
  }
  return node;
}

function num(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value);
  return undefined;
}

/** ISO string, or epoch seconds (< 1e12) / milliseconds. Epoch seconds out. */
function resetSeconds(value: unknown): number | undefined {
  const n = num(value);
  if (n !== undefined) return n > 0 ? Math.floor(n < 1e12 ? n : n / 1000) : undefined;
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
  }
  return undefined;
}

/** Parse an endpoint's body by its configured paths into one snapshot, or none. */
function parseCustomQuota(
  providerId: string,
  endpoint: QuotaEndpointConfig,
  body: unknown,
  now: number = Date.now(),
): ProviderQuotaSnapshot[] {
  let usedPercent: number | undefined;
  const percent = num(at(body, endpoint.percent));
  const total = num(at(body, endpoint.total));
  const used = num(at(body, endpoint.used));
  const remaining = num(at(body, endpoint.remaining));
  if (percent !== undefined) usedPercent = percent;
  else if (total !== undefined && total > 0 && used !== undefined)
    usedPercent = (used / total) * 100;
  else if (total !== undefined && total > 0 && remaining !== undefined) {
    usedPercent = ((total - remaining) / total) * 100;
  }

  const windows: ProviderQuotaWindow[] = [];
  if (usedPercent !== undefined && Number.isFinite(usedPercent)) {
    const resetsAt = resetSeconds(at(body, endpoint.resetAt));
    const minutes = endpoint.windowMinutes;
    windows.push({
      id: 'primary',
      ...(endpoint.label ? { label: String(endpoint.label).slice(0, 40) } : {}),
      usedPercent: Math.min(100, Math.max(0, usedPercent)),
      ...(typeof minutes === 'number' && minutes > 0 ? { windowMinutes: minutes } : {}),
      ...(resetsAt !== undefined ? { resetsAt } : {}),
    });
  }
  let credits: ProviderQuotaCredits | undefined;
  const balance = num(at(body, endpoint.balance));
  if (balance !== undefined) {
    const currency =
      typeof endpoint.currency === 'string' && endpoint.currency ? endpoint.currency : 'USD';
    credits = {
      hasCredits: balance > 0,
      unlimited: false,
      balance: formatBalance(balance, currency),
    };
  }
  if (windows.length === 0 && !credits) return [];
  return [
    {
      providerId,
      meterId: 'default',
      windows,
      ...(credits ? { credits } : {}),
      ...(windows[0] && windows[0].usedPercent >= 100 ? { reachedWindowId: 'primary' } : {}),
      capturedAt: now,
    },
  ];
}

export interface CustomQuotaReportOptions {
  apiKey: string;
  baseUrl: string | undefined;
  fetchImpl?: typeof fetch | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
  now?: number | undefined;
}

/**
 * Read and record a config-described quota. Resolves to the snapshots
 * recorded; silent on every failure — a refused URL included.
 */
export async function reportCustomQuota(
  providerId: string,
  endpoint: QuotaEndpointConfig,
  opts: CustomQuotaReportOptions,
): Promise<ProviderQuotaSnapshot[]> {
  const url = customQuotaUrl(endpoint, opts.baseUrl);
  if (!url) return [];
  const auth = endpoint.auth ?? 'bearer';
  const headers: Record<string, string> = { accept: 'application/json' };
  if (auth === 'bearer') headers['authorization'] = `Bearer ${opts.apiKey}`;
  else if (auth === 'x-api-key') headers['x-api-key'] = opts.apiKey;
  const doFetch = opts.fetchImpl ?? fetch;
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 10_000);
  try {
    const res = await doFetch(url, {
      headers,
      // The key must not follow a redirect to another host.
      redirect: 'error',
      signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
    });
    if (!res.ok) return [];
    const snapshots = parseCustomQuota(
      providerId,
      endpoint,
      await res.json(),
      opts.now ?? Date.now(),
    );
    if (snapshots.length > 0) recordProviderQuota(providerId, snapshots);
    return snapshots;
  } catch {
    return [];
  }
}
