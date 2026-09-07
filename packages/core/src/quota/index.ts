/**
 * Provider quota plane — "how much of this subscription is left, and when does
 * it come back".
 *
 * Subscription-metered providers (ChatGPT/Codex today; Claude Pro/Max, GitHub
 * Copilot, and any future plan-backed login on the same footing) charge against
 * rolling windows rather than per token. None of them put that budget in the
 * response body: it arrives in headers, or in a side channel, or not at all.
 * A transport that only reads the body cannot tell the user how much of their
 * plan they have burned — they find out when a 429 lands mid-turn.
 *
 * This module is the provider-neutral shape and the store. Each transport
 * parses its own wire format and reports a {@link ProviderQuotaSnapshot};
 * surfaces (the statusline chip, `/openai-quota`, WebUI) read the store and
 * never learn which provider they are looking at beyond its id. That split is
 * the point: the first implementation was Codex-shaped end to end, which would
 * have meant a second parser, a second store, a second chip, and a status bar
 * that grew a row per provider.
 *
 * Placement in `core` rather than `providers`: a status surface must be able to
 * read the last reading without constructing — or bundling — a transport, and
 * `providers` already depends on `core`, never the reverse.
 *
 * The store holds only what a provider actually observed. It is never a
 * fetcher: spending a request to ask "how much have I spent" is exactly the
 * wrong trade on a metered plan, so a reading appears after the session's first
 * real request and not before.
 *
 * @module quota
 */

// ── Shape ───────────────────────────────────────────────────────────────────

/**
 * One rolling budget window.
 *
 * `id` is the provider's own name for the window, not a fixed enum: providers
 * disagree on how many windows they meter and what they call them. Two
 * conventional ids — `primary` (the short window) and `secondary` (the long
 * one) — are what the ordering helpers assume when a provider supplies them,
 * but any id renders.
 */
export interface ProviderQuotaWindow {
  id: string;
  /** Display name for the window (`5h`, `weekly`). Derived when absent. */
  label?: string | undefined;
  /** Percentage of the window's allowance consumed, 0..100. */
  usedPercent: number;
  /** Window length in minutes (300 = 5h, 10080 = 7d), when reported. */
  windowMinutes?: number | undefined;
  /** Absolute reset time in epoch **seconds**, when reported. */
  resetsAt?: number | undefined;
}

/** Pay-as-you-go balance that backs an account past its plan allowance. */
export interface ProviderQuotaCredits {
  hasCredits: boolean;
  unlimited: boolean;
  /** Provider-formatted balance. A string because currency and unit vary. */
  balance?: string | undefined;
}

/** A full quota reading for one meter of one provider. */
export interface ProviderQuotaSnapshot {
  /** The provider whose plan this measures, e.g. `openai-codex`. */
  providerId: string;
  /**
   * Sub-meter id, for a provider that meters more than one pool (a per-model
   * allowance beside the account-wide one). `default` when there is only one.
   */
  meterId: string;
  /** Display name for the meter, when the provider supplies one. */
  meterLabel?: string | undefined;
  /** Subscription tier (`plus`, `pro`, `max`, …) when known. */
  planLabel?: string | undefined;
  windows: ProviderQuotaWindow[];
  credits?: ProviderQuotaCredits | undefined;
  /** `id` of the window that is currently cutting the account off, if any. */
  reachedWindowId?: string | undefined;
  /** Free-form provider message attached to the reading (upgrade prompts). */
  note?: string | undefined;
  /** Local wall-clock ms at which this reading was observed. */
  capturedAt: number;
}

/** The default meter id, used by providers that meter a single pool. */
export const DEFAULT_QUOTA_METER = 'default';

/** True when a snapshot carries an actual reading rather than an empty shell. */
export function hasQuotaData(snapshot: ProviderQuotaSnapshot): boolean {
  return snapshot.windows.length > 0 || snapshot.credits !== undefined;
}

// ── Store ───────────────────────────────────────────────────────────────────

export type ProviderQuotaListener = (
  providerId: string,
  snapshots: readonly ProviderQuotaSnapshot[],
) => void;

const _byProvider = new Map<string, Map<string, ProviderQuotaSnapshot>>();
const _listeners = new Set<ProviderQuotaListener>();

/**
 * Record what a provider observed, merged per meter.
 *
 * A reading that carries no data never erases one that did. Providers omit the
 * quota channel on some responses (a 304, an error path, a cached catalog
 * probe), and blanking the status line every few turns would read as "quota
 * unknown" when we do in fact know it. Fields the new reading does not restate
 * — the plan label, the meter's display name — are carried forward for the same
 * reason.
 */
export function recordProviderQuota(
  providerId: string,
  snapshots: readonly ProviderQuotaSnapshot[],
): void {
  const meaningful = snapshots.filter(hasQuotaData);
  const note = snapshots.find((s) => s.note !== undefined)?.note;
  const reached = snapshots.find((s) => s.reachedWindowId !== undefined);
  if (meaningful.length === 0 && note === undefined && reached === undefined) return;

  const byMeter = _byProvider.get(providerId) ?? new Map<string, ProviderQuotaSnapshot>();
  for (const snapshot of meaningful) {
    const previous = byMeter.get(snapshot.meterId);
    byMeter.set(snapshot.meterId, {
      ...snapshot,
      ...(snapshot.planLabel === undefined && previous?.planLabel !== undefined
        ? { planLabel: previous.planLabel }
        : {}),
      ...(snapshot.meterLabel === undefined && previous?.meterLabel !== undefined
        ? { meterLabel: previous.meterLabel }
        : {}),
    });
  }
  if (byMeter.size === 0) return;
  _byProvider.set(providerId, byMeter);

  const current = getProviderQuota(providerId);
  for (const listener of _listeners) {
    try {
      listener(providerId, current);
    } catch {
      // A broken status surface must never take down a live request.
    }
  }
}

/** Latest readings for one provider, newest per meter. */
export function getProviderQuota(providerId: string): readonly ProviderQuotaSnapshot[] {
  const byMeter = _byProvider.get(providerId);
  return byMeter ? [...byMeter.values()] : [];
}

/** Latest readings across every provider that has reported one. */
export function getAllProviderQuota(): readonly ProviderQuotaSnapshot[] {
  const out: ProviderQuotaSnapshot[] = [];
  for (const byMeter of _byProvider.values()) out.push(...byMeter.values());
  return out;
}

/** Ids of the providers that have reported a reading this process. */
export function listQuotaProviders(): readonly string[] {
  return [..._byProvider.keys()];
}

/** Subscribe to quota updates. Returns an unsubscribe function. */
export function onProviderQuota(listener: ProviderQuotaListener): () => void {
  _listeners.add(listener);
  return () => {
    _listeners.delete(listener);
  };
}

/** Test seam — drops all readings and listeners. */
export function resetProviderQuota(): void {
  _byProvider.clear();
  _listeners.clear();
}

// ── Selection ───────────────────────────────────────────────────────────────

/**
 * The window a one-line surface should show: the most-consumed one across
 * every provider and meter.
 *
 * A statusline chip has room for a single number, and the number that matters
 * is the one nearest to cutting the user off — not the account-wide window,
 * not the first provider to report. Ties break toward the sooner reset, so a
 * five-hour window at 90% wins over a weekly window at 90%.
 */
export function worstProviderQuotaWindow(
  snapshots: readonly ProviderQuotaSnapshot[] = getAllProviderQuota(),
): { snapshot: ProviderQuotaSnapshot; window: ProviderQuotaWindow } | undefined {
  let best: { snapshot: ProviderQuotaSnapshot; window: ProviderQuotaWindow } | undefined;
  for (const snapshot of snapshots) {
    for (const window of snapshot.windows) {
      if (!best) {
        best = { snapshot, window };
        continue;
      }
      if (window.usedPercent > best.window.usedPercent) {
        best = { snapshot, window };
        continue;
      }
      if (window.usedPercent === best.window.usedPercent) {
        const a = window.resetsAt;
        const b = best.window.resetsAt;
        if (a !== undefined && (b === undefined || a < b)) best = { snapshot, window };
      }
    }
  }
  return best;
}

/** The window currently cutting the account off, if the provider named one. */
export function reachedQuotaWindow(
  snapshot: ProviderQuotaSnapshot,
): ProviderQuotaWindow | undefined {
  if (snapshot.reachedWindowId === undefined) return undefined;
  return snapshot.windows.find((w) => w.id === snapshot.reachedWindowId);
}

// ── Presentation ────────────────────────────────────────────────────────────

/**
 * Display name for a window: its own label, else one derived from its length
 * (300 → `5h`, 10080 → `7d`), else its id.
 */
export function quotaWindowLabel(window: ProviderQuotaWindow): string {
  if (window.label) return window.label;
  const minutes = window.windowMinutes;
  if (minutes !== undefined && Number.isFinite(minutes) && minutes > 0) {
    if (minutes % 1440 === 0) return `${minutes / 1440}d`;
    if (minutes % 60 === 0) return `${minutes / 60}h`;
    return `${minutes}m`;
  }
  return window.id;
}

/** Milliseconds until a window resets, or undefined when unknown or past. */
export function quotaResetInMs(
  window: ProviderQuotaWindow | undefined,
  now: number = Date.now(),
): number | undefined {
  if (window?.resetsAt === undefined) return undefined;
  const ms = window.resetsAt * 1000 - now;
  return ms > 0 ? ms : undefined;
}

/** Compact `4h 12m` / `38m` / `45s` rendering of a reset countdown. */
export function formatQuotaResetIn(ms: number | undefined): string | undefined {
  if (ms === undefined || ms <= 0) return undefined;
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 1) return `${Math.max(1, Math.round(ms / 1000))}s`;
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

/** Percentage rendered the way both the chip and the report show it. */
export function formatQuotaPercent(usedPercent: number): string {
  return `${usedPercent.toFixed(usedPercent >= 10 || usedPercent <= 0 ? 0 : 1)}%`;
}
