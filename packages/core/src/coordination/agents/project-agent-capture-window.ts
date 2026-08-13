/**
 * Capture rate-limiting window.
 *
 * The frequency cap is documented as "per session", but the counters used to
 * live in module-level Maps that were never reset. In a long-lived project
 * daemon that made the cap "3 captures per role per *process lifetime*" — the
 * observable symptom being roles that silently stopped learning days ago.
 *
 * The window is now time-boxed: counters roll over after
 * `CAPTURE_SESSION_WINDOW_MS`, and a host can reset them explicitly when a real
 * session boundary occurs (`/clear`, resume, new REPL turn batch).
 */

/** Minimum spacing between two automatic captures for one role. */
export const CAPTURE_COOLDOWN_MS = 120_000;

/** Automatic captures allowed per role within one window. */
export const CAPTURE_MAX_PER_SESSION = 3;

/** How long a counting window lasts before it rolls over. */
export const CAPTURE_SESSION_WINDOW_MS = 30 * 60_000;

interface CaptureWindow {
  windowStartedAt: number;
  count: number;
  lastCaptureAt: number | undefined;
}

const MAX_WINDOWS = 1_000;
const windows = new Map<string, CaptureWindow>();

function currentWindow(key: string, now: number): CaptureWindow {
  const existing = windows.get(key);
  if (!existing || now - existing.windowStartedAt >= CAPTURE_SESSION_WINDOW_MS) {
    // A rolled-over window keeps `lastCaptureAt` so the cooldown still applies
    // across the boundary — only the frequency budget is refreshed.
    const fresh: CaptureWindow = {
      windowStartedAt: now,
      count: 0,
      lastCaptureAt: existing?.lastCaptureAt,
    };
    if (windows.size >= MAX_WINDOWS && !windows.has(key)) {
      const oldestKey = windows.keys().next().value;
      if (oldestKey !== undefined) {
        windows.delete(oldestKey);
      }
    }
    windows.set(key, fresh);
    return fresh;
  }
  // Refresh insertion order for LRU retention
  windows.delete(key);
  windows.set(key, existing);
  return existing;
}

export function captureWindowState(
  key: string,
  now: number = Date.now(),
): { count: number; lastCaptureAt: number | undefined; remaining: number } {
  const window = currentWindow(key, now);
  return {
    count: window.count,
    lastCaptureAt: window.lastCaptureAt,
    remaining: Math.max(0, CAPTURE_MAX_PER_SESSION - window.count),
  };
}

export function recordCaptureAttempt(key: string, now: number = Date.now()): void {
  const window = currentWindow(key, now);
  window.count += 1;
  window.lastCaptureAt = now;
}

/** Drop every counter. Called on an explicit session boundary and by tests. */
export function resetCaptureWindows(): void {
  windows.clear();
}

/** Drop the counters for one role/project key. */
export function resetCaptureWindow(key: string): void {
  windows.delete(key);
}
