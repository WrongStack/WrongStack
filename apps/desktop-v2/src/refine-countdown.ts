/**
 * The grace period before an automatic prompt refinement starts (the WebUI's "refine countdown",
 * `enhanceCountdownMs`): while it runs the prompt can still be sent as written. Like the WebUI's,
 * it is a setting of this computer, not of the profile; 0 starts the refinement at once.
 */
const REFINE_COUNTDOWN_KEY = 'wrongstack.desktop.refine-countdown-ms';
const DEFAULT_REFINE_COUNTDOWN_MS = 3000;
const MAX_REFINE_COUNTDOWN_MS = 10_000;

/** A stored or entered countdown in whole seconds within 0–10 s, or the default when invalid. */
function normalizeRefineCountdown(value: unknown): number {
  const ms = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return DEFAULT_REFINE_COUNTDOWN_MS;
  return Math.min(MAX_REFINE_COUNTDOWN_MS, Math.round(ms / 1000) * 1000);
}

export function readRefineCountdownMs(): number {
  try {
    return normalizeRefineCountdown(localStorage.getItem(REFINE_COUNTDOWN_KEY));
  } catch {
    return DEFAULT_REFINE_COUNTDOWN_MS;
  }
}

/** Saves the countdown for this computer and returns the value kept. */
export function writeRefineCountdownMs(value: unknown): number {
  const ms = normalizeRefineCountdown(value);
  try {
    localStorage.setItem(REFINE_COUNTDOWN_KEY, String(ms));
  } catch {
    /* a blocked storage keeps the default next time */
  }
  return ms;
}

/** Whole seconds the countdown shows, or 0 when refinement starts at once. */
export const countdownSeconds = (ms: number) => Math.max(0, Math.ceil(ms / 1000));
