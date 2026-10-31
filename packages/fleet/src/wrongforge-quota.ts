import {
  DEFAULT_QUOTA_METER,
  type ProviderQuotaSnapshot,
  type ProviderQuotaWindow,
  recordProviderQuota,
} from '@wrongstack/core/quota';
import {
  resolveWrongForgeEndpoint,
  type WrongForgeEndpoint,
  wrongForgeCall,
} from './wrongforge-client.js';

const reads = new Map<
  string,
  { at: number; ok: boolean; forced: boolean; pending?: Promise<boolean> }
>();
const REFRESH_MS = 20_000;

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function percent(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
}

/** Read the signed-in WrongForge account into the shared quota plane; never a model call. */
export async function reportWrongForgeQuota(
  opts: {
    endpoint?: WrongForgeEndpoint | undefined;
    providerId?: string | undefined;
    fetchImpl?: typeof fetch | undefined;
    force?: boolean | undefined;
    timeoutMs?: number | undefined;
  } = {},
): Promise<boolean> {
  const endpoint = opts.endpoint ?? resolveWrongForgeEndpoint();
  if (!endpoint) return false;
  const providerId = opts.providerId ?? 'wrongforge';
  const key = `${providerId}\0${endpoint.url}\0${endpoint.apiKey}`;
  const prior = reads.get(key);
  if (prior?.pending) {
    if (opts.force && !prior.forced) {
      await prior.pending;
      return reportWrongForgeQuota(opts);
    }
    return prior.pending;
  }
  if (!opts.force && prior && Date.now() - prior.at < REFRESH_MS) return prior.ok;
  const state = { at: Date.now(), ok: false, forced: opts.force === true } as {
    at: number;
    ok: boolean;
    forced: boolean;
    pending?: Promise<boolean>;
  };
  reads.set(key, state);
  // Keep endpoint/credential rotations from retaining an unbounded history.
  if (reads.size > 128)
    for (const [id, entry] of reads) {
      if (!entry.pending && id !== key) {
        reads.delete(id);
        break;
      }
    }
  state.pending = (async () => {
    try {
      const signal = AbortSignal.timeout(opts.timeoutMs ?? 10_000);
      const body = object(
        await wrongForgeCall(endpoint, opts.fetchImpl)(
          'GET',
          `/v1/usage${opts.force ? '?force=1' : ''}`,
          undefined,
          signal,
        ),
      );
      if (signal.aborted) return false;
      const windows: ProviderQuotaWindow[] = [];
      for (const spec of [
        { key: 'five_hour', id: 'primary', label: '5h', windowMinutes: 300 },
        { key: 'weekly', id: 'secondary', label: 'weekly', windowMinutes: 10_080 },
      ]) {
        const raw = object(body[spec.key]);
        if (!percent(raw.percent)) continue;
        const reset = typeof raw.resetsAt === 'string' ? Date.parse(raw.resetsAt) : Number.NaN;
        windows.push({
          id: spec.id,
          label: spec.label,
          windowMinutes: spec.windowMinutes,
          usedPercent: raw.percent,
          ...(Number.isFinite(reset) ? { resetsAt: Math.floor(reset / 1000) } : {}),
        });
      }
      if (windows.length === 0) return false;
      const extra = object(body.extra_usage);
      const snapshot: ProviderQuotaSnapshot = {
        providerId,
        meterId: DEFAULT_QUOTA_METER,
        meterLabel: 'WrongForge · Claude subscription',
        windows,
        capturedAt: Date.now(),
      };
      if (extra.enabled === false) snapshot.credits = { hasCredits: false, unlimited: false };
      if (extra.enabled === true) {
        snapshot.note = percent(extra.utilization)
          ? `Extra usage enabled · ${extra.utilization}% used`
          : 'Extra usage enabled';
        if (
          typeof extra.usedCredits === 'number' &&
          Number.isFinite(extra.usedCredits) &&
          extra.usedCredits >= 0 &&
          typeof extra.monthlyLimit === 'number' &&
          Number.isFinite(extra.monthlyLimit) &&
          extra.monthlyLimit >= 0
        ) {
          const remaining = Math.max(0, extra.monthlyLimit - extra.usedCredits);
          snapshot.credits = {
            hasCredits: remaining > 0,
            unlimited: false,
            balance: `${remaining} credits remaining (${extra.usedCredits}/${extra.monthlyLimit})`,
          };
        }
      } else if (extra.enabled === false) snapshot.note = 'Extra usage disabled';
      const exhausted = windows.filter(
        (window) =>
          window.usedPercent >= 100 &&
          (window.resetsAt === undefined || window.resetsAt * 1000 > snapshot.capturedAt),
      );
      exhausted.sort((a, b) => (b.resetsAt ?? Infinity) - (a.resetsAt ?? Infinity));
      if (exhausted[0]) snapshot.reachedWindowId = exhausted[0].id;
      recordProviderQuota(providerId, [snapshot]);
      state.ok = true;
      return true;
    } catch {
      return false;
    } finally {
      delete state.pending;
    }
  })();
  return state.pending;
}
