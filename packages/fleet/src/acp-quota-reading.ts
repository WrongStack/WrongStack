/**
 * A delegated Claude worker's subscription quota, on WrongStack's quota plane.
 *
 * Claude's ACP adapter forwards the account's rate-limit reading on
 * `usage_update` (`_meta["_claude/rateLimit"]`: status, resetsAt and a
 * `unifiedWindows` map of utilization per window). Recorded under the agent's
 * id (`claude-code`), it shows in `/provider-quota`, the WebUI quota page and,
 * when it is the fullest window, the status chip — named as the worker's, so
 * the user sees the delegation plan running out before a delegation fails.
 */
import { type ProviderQuotaWindow, recordProviderQuota } from '@wrongstack/core/quota';

/** Claude's window names, with the short id and length the quota plane uses. */
const WINDOWS: Readonly<Record<string, { id: string; minutes: number }>> = {
  five_hour: { id: '5h', minutes: 300 },
  seven_day: { id: '7d', minutes: 10_080 },
  seven_day_opus: { id: '7d opus', minutes: 10_080 },
  seven_day_sonnet: { id: '7d sonnet', minutes: 10_080 },
};

/** Last windows seen per agent: a reading names only the windows it re-reports. */
const lastWindows = new Map<string, Map<string, ProviderQuotaWindow>>();

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;

/** Epoch seconds, whether the agent sent seconds or milliseconds. */
const toSeconds = (v: number): number => Math.trunc(v > 1e12 ? v / 1000 : v);

function windowFrom(name: string, raw: unknown): ProviderQuotaWindow | undefined {
  const spec = WINDOWS[name];
  if (!spec || !raw || typeof raw !== 'object') return undefined;
  const utilization = num((raw as { utilization?: unknown }).utilization);
  if (utilization === undefined) return undefined;
  const resetsAt = num((raw as { resetsAt?: unknown }).resetsAt);
  return {
    id: spec.id,
    label: spec.id,
    // Sent as a 0..1 fraction; anything above 1 can only be a percent already.
    usedPercent: Math.min(
      100,
      Math.round((utilization <= 1 ? utilization * 100 : utilization) * 100) / 100,
    ),
    windowMinutes: spec.minutes,
    ...(resetsAt !== undefined && resetsAt > 0 ? { resetsAt: toSeconds(resetsAt) } : {}),
  };
}

/** Record one rate-limit reading from `agentId`; ignores readings it cannot read. */
export function recordAcpRateLimit(
  agentId: string,
  info: Record<string, unknown>,
  now: number = Date.now(),
): void {
  const known = lastWindows.get(agentId) ?? new Map<string, ProviderQuotaWindow>();
  const unified = info.unifiedWindows;
  if (unified && typeof unified === 'object') {
    for (const [name, raw] of Object.entries(unified)) {
      const window = windowFrom(name, raw);
      if (window) known.set(window.id, window);
    }
  }
  const type = typeof info.rateLimitType === 'string' ? info.rateLimitType : undefined;
  const reached = info.status === 'rejected' && type ? WINDOWS[type]?.id : undefined;
  if (known.size === 0 && reached === undefined) return;
  lastWindows.set(agentId, known);
  recordProviderQuota(
    agentId,
    [
      {
        providerId: agentId,
        meterId: 'claude',
        meterLabel: 'Claude subscription (delegated worker)',
        windows: [...known.values()],
        ...(reached !== undefined ? { reachedWindowId: reached } : {}),
        capturedAt: now,
      },
    ],
    now,
  );
}
