/**
 * OpenCode Go plan quota — `GET https://opencode.ai/zen/go/v1/usage`.
 *
 * An account read, not a model call. Verified live 2026-09-30: every OpenCode
 * key of an account — Zen (`/zen/v1`) and Go (`/zen/go/v1`) alike — reads the
 * SAME account usage, so several saved OpenCode providers show identical
 * readings (surfaces fold those into one card, see `groupQuotaSnapshots`).
 *
 *   { usage: { rolling|weekly|monthly: { status: 'ok'|'rate-limited',
 *                                         percent: 0..100, resetsAt: ISO } } }
 *
 * `rate-limited` means the window is cut off, whatever `percent` says. A
 * window with an unknown status or a malformed field is skipped rather than
 * guessed at.
 *
 * @module opencode-quota
 */

import {
  DEFAULT_QUOTA_METER,
  type ProviderQuotaSnapshot,
  type ProviderQuotaWindow,
  recordProviderQuota,
} from '@wrongstack/core/quota';

const OPENCODE_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage';

const WINDOWS = [
  { key: 'rolling', id: 'primary', minutes: 300, label: undefined },
  { key: 'weekly', id: 'secondary', minutes: 10_080, label: undefined },
  // Monthly resets on the subscription anniversary, not a fixed length.
  { key: 'monthly', id: 'monthly', minutes: undefined, label: 'month' },
] as const;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

interface ParsedWindow {
  window: ProviderQuotaWindow;
  limited: boolean;
}

function parseWindow(raw: unknown, spec: (typeof WINDOWS)[number]): ParsedWindow | undefined {
  const w = record(raw);
  const status = w?.['status'];
  const percent = w?.['percent'];
  const resetsAt = w?.['resetsAt'];
  if (status !== 'ok' && status !== 'rate-limited') return undefined;
  if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0 || percent > 100) {
    return undefined;
  }
  const resetMs = typeof resetsAt === 'string' ? Date.parse(resetsAt) : Number.NaN;
  if (!Number.isFinite(resetMs)) return undefined;
  const limited = status === 'rate-limited';
  return {
    limited,
    window: {
      id: spec.id,
      ...(spec.label ? { label: spec.label } : {}),
      usedPercent: limited ? 100 : percent,
      ...(spec.minutes !== undefined ? { windowMinutes: spec.minutes } : {}),
      resetsAt: Math.floor(resetMs / 1000),
    },
  };
}

/** Parse a `/zen/go/v1/usage` body into one snapshot, or none when it holds no window. */
function parseOpenCodeUsage(
  providerId: string,
  body: unknown,
  now: number = Date.now(),
): ProviderQuotaSnapshot[] {
  const usage = record(record(body)?.['usage']);
  if (!usage) return [];
  const parsed = WINDOWS.map((spec) => parseWindow(usage[spec.key], spec)).filter(
    (p): p is ParsedWindow => p !== undefined,
  );
  if (parsed.length === 0) return [];
  // Of the cut-off windows, the one that reopens last is what keeps the
  // account blocked.
  let reached: ProviderQuotaWindow | undefined;
  for (const { window, limited } of parsed) {
    if (limited && (reached === undefined || (window.resetsAt ?? 0) > (reached.resetsAt ?? 0))) {
      reached = window;
    }
  }
  return [
    {
      providerId,
      meterId: DEFAULT_QUOTA_METER,
      meterLabel: 'OpenCode Go',
      windows: parsed.map((p) => p.window),
      ...(reached ? { reachedWindowId: reached.id } : {}),
      capturedAt: now,
    },
  ];
}

export interface OpenCodeQuotaReportOptions {
  apiKey: string;
  fetchImpl?: typeof fetch | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
  now?: number | undefined;
}

/**
 * Read and record the OpenCode Go plan quota. Resolves to the snapshots
 * recorded; silent on every failure (a Zen-only account without a Go plan
 * simply records nothing), leaving the previous reading standing.
 */
export async function reportOpenCodeQuota(
  providerId: string,
  opts: OpenCodeQuotaReportOptions,
): Promise<ProviderQuotaSnapshot[]> {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs =
    typeof opts.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
      ? opts.timeoutMs
      : 10_000;
  try {
    const timeout = AbortSignal.timeout(timeoutMs);
    const res = await doFetch(OPENCODE_USAGE_URL, {
      headers: { accept: 'application/json', authorization: `Bearer ${opts.apiKey}` },
      signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
    });
    if (!res.ok) return [];
    const snapshots = parseOpenCodeUsage(providerId, await res.json(), opts.now ?? Date.now());
    if (snapshots.length > 0) recordProviderQuota(providerId, snapshots);
    return snapshots;
  } catch {
    return [];
  }
}
