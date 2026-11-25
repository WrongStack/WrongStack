/**
 * Boot-phase marks for one `startWebUI` boot: milliseconds from "Starting backend services" to
 * each named step, reported once when the backend is ready. Only a host that passes
 * `reportBootTiming` receives them (the desktop engine logs them), so a terminal WebUI prints
 * nothing extra. One process runs one boot; a second boot simply starts a new set of marks.
 */
export interface WebuiBootTiming {
  /** Milliseconds since this process started, when the boot began. */
  startedAfterMs: number;
  /** Milliseconds from the boot's start to each step, in the order the steps finished. */
  marks: Record<string, number>;
}

let current: { started: number; marks: Record<string, number> } | undefined;

export function beginBootTiming(): void {
  current = { started: performance.now(), marks: {} };
}

/** Records the first time `name` finished in the current boot. A no-op outside a boot. */
export function markBoot(name: string): void {
  if (!current || Object.hasOwn(current.marks, name)) return;
  Object.defineProperty(current.marks, name, {
    value: Math.round(performance.now() - current.started),
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

/** Ends the current boot and returns its marks, or undefined when none is running. */
export function finishBootTiming(): WebuiBootTiming | undefined {
  const boot = current;
  if (!boot) return undefined;
  current = undefined;
  boot.marks['ready'] ??= Math.round(performance.now() - boot.started);
  return { startedAfterMs: Math.round(boot.started), marks: boot.marks };
}
