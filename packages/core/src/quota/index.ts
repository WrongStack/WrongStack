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
  /**
   * Derived, never reported by a provider: when the last hour's pace fills the
   * window (epoch **seconds**), set only when that lands before `resetsAt`.
   * Added by {@link withQuotaPace} for surfaces that cannot see the pace record.
   */
  exhaustsAt?: number | undefined;
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
  /**
   * The gateway that relayed this reading (`omniroute`), when it describes one
   * account of a gateway's pool rather than the plan the session draws on. The
   * gateway rotates across its accounts, so one of them running out does not
   * cut the session off: {@link worstProviderQuotaWindow} leaves these out.
   */
  via?: string | undefined;
  /** Local wall-clock ms at which this reading was observed. */
  capturedAt: number;
}

/** The default meter id, used by providers that meter a single pool. */
export const DEFAULT_QUOTA_METER = 'default';

/** True when a snapshot carries an actual reading rather than an empty shell. */
export function hasQuotaData(snapshot: ProviderQuotaSnapshot): boolean {
  return (
    snapshot.windows.length > 0 ||
    snapshot.credits !== undefined ||
    snapshot.note !== undefined ||
    snapshot.reachedWindowId !== undefined
  );
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
  now: number = Date.now(),
): void {
  const meaningful = snapshots.filter(hasQuotaData);
  for (const snapshot of meaningful) recordPace(providerId, snapshot, now);
  const note = snapshots.find((s) => s.note !== undefined)?.note;
  const reached = snapshots.find((s) => s.reachedWindowId !== undefined);
  if (meaningful.length === 0 && note === undefined && reached === undefined) return;

  const byMeter = _byProvider.get(providerId) ?? new Map<string, ProviderQuotaSnapshot>();
  for (const snapshot of meaningful) {
    const previous = byMeter.get(snapshot.meterId);
    byMeter.set(snapshot.meterId, {
      ...snapshot,
      providerId,
      // A reading that omits a field restates nothing: the last known value
      // survives. Windows/credits/reachedWindowId/note are carried forward so a
      // note-only or reached-only snapshot stores its information WITHOUT
      // erasing the quota reading it arrived alongside.
      ...(snapshot.windows.length === 0 && previous?.windows !== undefined
        ? { windows: previous.windows }
        : {}),
      ...(snapshot.credits === undefined && previous?.credits !== undefined
        ? { credits: previous.credits }
        : {}),
      // …except the cut-off flag and transient note across a fresh window
      // reading: that reading is the provider restating the meter, and its
      // silence means "not cut off / no note". Carrying them forward kept the
      // chip red or warning-annotated after the window reset.
      ...(snapshot.reachedWindowId === undefined &&
      snapshot.windows.length === 0 &&
      previous?.reachedWindowId !== undefined
        ? { reachedWindowId: previous.reachedWindowId }
        : {}),
      ...(snapshot.note === undefined &&
      snapshot.windows.length === 0 &&
      previous?.note !== undefined
        ? { note: previous.note }
        : {}),
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
  _pace.clear();
}

// ── Pace ────────────────────────────────────────────────────────────────────

/**
 * Readings of one window, oldest first, for the pace forecast. A reading is
 * where the plan stood when a request returned, so the forecast needs no
 * timer: it moves exactly when a new reading lands.
 */
interface PaceSample {
  at: number;
  usedPercent: number;
  resetsAt: number | undefined;
}

const _pace = new Map<string, PaceSample[]>();
/** RAM guard per window; the forecast reads only the last hour anyway. */
const MAX_PACE_SAMPLES = 256;
/** The pace is the climb over the readings of the last hour... */
const PACE_LOOKBACK_MS = 60 * 60_000;
/** ...and needs at least this much of it: two readings a minute apart are noise. */
const MIN_PACE_SPAN_MS = 10 * 60_000;

function paceKey(providerId: string, meterId: string, windowId: string): string {
  return `${providerId}\0${meterId}\0${windowId}`;
}

/**
 * Seconds a reset clock may drift between readings of one cycle. Several
 * providers report the reset only as "N seconds from now" (Codex's
 * `reset-after-seconds` fallback, MiniMax `remains_time`), which turns into an
 * absolute time that wobbles by a second from one reading to the next. An exact
 * comparison treated each wobble as a new cycle and threw the pace record away,
 * so the forecast never got its ten minutes. A real new cycle moves the reset
 * by a whole window.
 */
const RESET_JITTER_SECONDS = 60;

function resetMoved(previous: number | undefined, next: number | undefined): boolean {
  if (previous === undefined || next === undefined) return previous !== next;
  return Math.abs(next - previous) > RESET_JITTER_SECONDS;
}

function recordPace(providerId: string, snapshot: ProviderQuotaSnapshot, now: number): void {
  for (const window of snapshot.windows) {
    if (!Number.isFinite(window.usedPercent)) continue;
    const key = paceKey(providerId, snapshot.meterId, window.id);
    let samples = _pace.get(key) ?? [];
    const last = samples.at(-1);
    // A new reset time or a falling percentage is a new cycle: the old
    // readings describe spending that no longer counts.
    if (
      last &&
      (resetMoved(last.resetsAt, window.resetsAt) || window.usedPercent < last.usedPercent)
    ) {
      samples = [];
    }
    samples.push({ at: now, usedPercent: window.usedPercent, resetsAt: window.resetsAt });
    if (samples.length > MAX_PACE_SAMPLES) samples.splice(0, samples.length - MAX_PACE_SAMPLES);
    _pace.set(key, samples);
  }
}

/**
 * Milliseconds until the window reaches 100% at the pace of the last hour,
 * or undefined when that does not happen before it resets, when the plan is
 * not climbing, or when there is not enough of a record to tell.
 */
export function quotaExhaustionInMs(
  providerId: string,
  meterId: string,
  window: ProviderQuotaWindow,
  now: number = Date.now(),
): number | undefined {
  if (!Number.isFinite(window.usedPercent) || window.usedPercent >= 100) return undefined;
  const samples = (_pace.get(paceKey(providerId, meterId, window.id)) ?? []).filter(
    (s) => now - s.at <= PACE_LOOKBACK_MS,
  );
  const first = samples[0];
  const last = samples.at(-1);
  if (!first || !last || last.at - first.at < MIN_PACE_SPAN_MS) return undefined;
  const climb = last.usedPercent - first.usedPercent;
  if (climb <= 0) return undefined;
  const perMs = climb / (last.at - first.at);
  const eta = (100 - window.usedPercent) / perMs;
  if (window.resetsAt !== undefined) {
    const resetIn = quotaResetInMs(window, now);
    if (resetIn === undefined || eta >= resetIn) return undefined;
  }
  return eta;
}

/**
 * Copies of `snapshots` whose windows carry `exhaustsAt` where the pace
 * forecast has one. For a surface in another process (the WebUI page), which
 * receives snapshots but not the pace record they were measured against.
 */
export function withQuotaPace(
  snapshots: readonly ProviderQuotaSnapshot[],
  now: number = Date.now(),
): ProviderQuotaSnapshot[] {
  return snapshots.map((snapshot) => ({
    ...snapshot,
    windows: snapshot.windows.map((window) => {
      const eta = quotaExhaustionInMs(snapshot.providerId, snapshot.meterId, window, now);
      return eta === undefined ? window : { ...window, exhaustsAt: (now + eta) / 1000 };
    }),
  }));
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
    if (snapshot.via !== undefined) continue;
    for (const window of snapshot.windows) {
      // F2026101031: NaN/Infinity never compare as greater, so a non-finite
      // first window would hide every later finite reading.
      if (!Number.isFinite(window.usedPercent)) continue;
      if (!best) {
        best = { snapshot, window };
        continue;
      }
      if (window.usedPercent > best.window.usedPercent) {
        best = { snapshot, window };
        continue;
      }
      if (window.usedPercent === best.window.usedPercent) {
        const a =
          window.resetsAt !== undefined && Number.isFinite(window.resetsAt)
            ? window.resetsAt
            : undefined;
        const b =
          best.window.resetsAt !== undefined && Number.isFinite(best.window.resetsAt)
            ? best.window.resetsAt
            : undefined;
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

/** Readings that are one account seen through several saved providers. */
export interface ProviderQuotaGroup {
  /** The first reading of the group, in input order. */
  snapshot: ProviderQuotaSnapshot;
  /** Every provider id that reported this exact reading, in input order. */
  providerIds: string[];
}

/**
 * The identity of a reading, or undefined when it is too thin to prove two
 * providers share an account. Only readings whose every window carries a
 * reset clock qualify: two unrelated accounts can both sit at 0% of a
 * clockless window, but not on the same reset second of every window.
 */
function accountReadingKey(snapshot: ProviderQuotaSnapshot): string | undefined {
  if (snapshot.windows.length === 0) return undefined;
  if (snapshot.windows.some((w) => w.resetsAt === undefined)) return undefined;
  return JSON.stringify([
    snapshot.meterId,
    snapshot.meterLabel ?? null,
    snapshot.planLabel ?? null,
    snapshot.reachedWindowId ?? null,
    snapshot.note ?? null,
    snapshot.credits ?? null,
    snapshot.windows.map((w) => [
      w.id,
      w.label ?? null,
      w.usedPercent,
      w.windowMinutes ?? null,
      w.resetsAt,
    ]),
  ]);
}

/**
 * Fold readings that are the same account seen through several saved
 * providers — every OpenCode key of an account, Zen and Go alike, reads the
 * one account usage — into one entry listing all their provider ids, so a
 * surface shows one card instead of identical copies. Readings that differ in
 * any window, or carry a window without a reset clock, stay separate.
 */
export function groupQuotaSnapshots(
  snapshots: readonly ProviderQuotaSnapshot[],
): ProviderQuotaGroup[] {
  const groups: ProviderQuotaGroup[] = [];
  const byKey = new Map<string, ProviderQuotaGroup>();
  for (const snapshot of snapshots) {
    const key = accountReadingKey(snapshot);
    const existing = key === undefined ? undefined : byKey.get(key);
    if (existing) {
      if (!existing.providerIds.includes(snapshot.providerId)) {
        existing.providerIds.push(snapshot.providerId);
      }
      continue;
    }
    const group = { snapshot, providerIds: [snapshot.providerId] };
    groups.push(group);
    if (key !== undefined) byKey.set(key, group);
  }
  return groups;
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
  if (window?.resetsAt === undefined || !Number.isFinite(window.resetsAt)) return undefined;
  const ms = window.resetsAt * 1000 - now;
  return ms > 0 ? ms : undefined;
}

/** Compact `4h 12m` / `38m` / `45s` rendering of a reset countdown. */
export function formatQuotaResetIn(ms: number | undefined): string | undefined {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return undefined;
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 1) {
    const secs = Math.max(1, Math.round(ms / 1000));
    return secs >= 60 ? '1m' : `${secs}s`;
  }
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

/** Percentage rendered the way both the chip and the report show it. */
export function formatQuotaPercent(usedPercent: number): string {
  // Rounding must not announce a cut-off that has not happened: 99.6 read as
  // "100%" on a window that still had room. 9.96 rounds to "10%", not "10.0%".
  if (usedPercent > 99 && usedPercent < 100) return '99%';
  const digits = usedPercent >= 10 || usedPercent <= 0 ? 0 : 1;
  const text = usedPercent.toFixed(digits);
  return digits === 1 && text === '10.0' ? '10%' : `${text}%`;
}
