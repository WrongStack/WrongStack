/**
 * Antigravity quota reporter — `POST /v1internal:retrieveUserQuota`.
 *
 * Antigravity meters per model, not per account: each Gemini variant has its
 * own bucket with its own reset. Nothing about that is reported on an
 * inference response — not in headers, not in the stream — so like Copilot
 * this reporter has to ask, and unlike Copilot it has to ask the *same* host
 * that serves inference.
 *
 * That makes the call ordering the interesting part. Asking costs a request to
 * a metered host, so it is bound to a moment that has already earned one: the
 * reporter runs after a completed turn, not before, and never on the path of
 * the turn itself.
 *
 * Response shape:
 *
 *   { buckets: [ { modelId, remainingFraction, resetTime } ] }
 *
 * `remainingFraction` is a 0..1 **remaining** fraction — the inverse of every
 * other provider's "used percent" — and its absence is meaningful: it means
 * the backend did not report, which is not the same as 0% left. A 429 carries
 * no bucket at all; its reset arrives as `quotaResetDelay` in the error body.
 *
 * @module google-antigravity-quota
 */

import {
  type ProviderQuotaSnapshot,
  type ProviderQuotaWindow,
  recordProviderQuota,
} from '@wrongstack/core/quota';
import {
  ANTIGRAVITY_QUOTA_PATH,
  ANTIGRAVITY_RUNTIME_HOSTS,
  antigravityHeaders,
} from './google-antigravity-protocol.js';

interface AntigravityBucket {
  modelId?: unknown;
  remainingFraction?: unknown;
  resetTime?: unknown;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * `resetTime` as epoch seconds.
 *
 * Cloud Code sends an RFC-3339 instant here, but a duration string
 * (`"3600s"`) has been seen on sibling endpoints, so both are read. A value
 * that parses as neither is dropped rather than guessed at — a wrong reset
 * time is worse than no countdown.
 */
function parseResetSeconds(value: unknown, now: number): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const durationMatch = /^(\d+(?:\.\d+)?)s$/.exec(trimmed);
  if (durationMatch?.[1]) {
    return Math.floor(now / 1000) + Math.trunc(Number(durationMatch[1]));
  }
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
}

/**
 * Turn a `retrieveUserQuota` body into one snapshot whose windows are models.
 *
 * One meter, one window per model — the same choice made for Copilot's pools,
 * and for the same reason: it is one subscription with one "am I about to be
 * cut off" question. A bucket that reports no fraction is omitted entirely,
 * because rendering "unknown" as a full or empty bar would both be lies.
 */
export function parseAntigravityQuota(
  providerId: string,
  body: unknown,
  now: number = Date.now(),
): ProviderQuotaSnapshot[] {
  if (typeof body !== 'object' || body === null) return [];
  const buckets = (body as { buckets?: unknown }).buckets;
  if (!Array.isArray(buckets)) return [];
  const safeNow = Number.isFinite(now) ? now : Date.now();

  const windows: ProviderQuotaWindow[] = [];
  for (const raw of buckets) {
    if (typeof raw !== 'object' || raw === null) continue;
    const bucket = raw as AntigravityBucket;
    const modelId = typeof bucket.modelId === 'string' ? bucket.modelId.trim() : '';
    if (modelId.length === 0) continue;
    const fraction = num(bucket.remainingFraction);
    if (fraction === undefined) continue;
    const resetsAt = parseResetSeconds(bucket.resetTime, safeNow);
    // A bucket with a full allowance and no reset is not on a rolling window
    // at all — it is unmetered, and a permanently-empty bar for it would be
    // noise in a report whose whole job is showing what is running out.
    if (fraction >= 1 && resetsAt === undefined) continue;
    windows.push({
      id: modelId,
      label: modelId,
      usedPercent: Math.max(0, Math.min(100, (1 - fraction) * 100)),
      ...(resetsAt !== undefined ? { resetsAt } : {}),
    });
  }
  if (windows.length === 0) return [];
  // Worst-first, so a report that gets long still leads with the bucket that
  // is about to bite.
  windows.sort((a, b) => b.usedPercent - a.usedPercent);
  return [
    {
      providerId,
      meterId: 'antigravity',
      meterLabel: 'per-model buckets',
      windows,
      capturedAt: safeNow,
    },
  ];
}

/**
 * Ask Cloud Code for the account's per-model quota and record it.
 *
 * Silent on every failure, like the Copilot reporter and for the same reason:
 * nothing awaits this, so there is no caller to raise to, and a status surface
 * that could not be refreshed is not worth interrupting anyone over. Hosts are
 * tried in order so a bad deploy on the rolling channel does not read as "no
 * quota data".
 */
export async function reportAntigravityQuota(
  providerId: string,
  opts: {
    accessToken: string;
    project: string;
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
    now?: number;
  },
): Promise<boolean> {
  const doFetch = opts.fetchImpl ?? fetch;
  for (const host of ANTIGRAVITY_RUNTIME_HOSTS) {
    try {
      const res = await doFetch(`${host}${ANTIGRAVITY_QUOTA_PATH}`, {
        method: 'POST',
        headers: antigravityHeaders(opts.accessToken),
        body: JSON.stringify({ project: opts.project }),
        signal: opts.signal
          ? AbortSignal.any([opts.signal, AbortSignal.timeout(10_000)])
          : AbortSignal.timeout(10_000),
      });
      if (!res.ok) continue;
      const json: unknown = await res.json();
      const snapshots = parseAntigravityQuota(providerId, json, opts.now ?? Date.now());
      if (snapshots.length === 0) return false;
      recordProviderQuota(providerId, snapshots);
      return true;
    } catch {
      // Try the next host; a total failure leaves the previous reading standing.
    }
  }
  return false;
}
