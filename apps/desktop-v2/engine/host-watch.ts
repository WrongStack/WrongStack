/**
 * The session host that started this engine reads its output and is the only one that can stop
 * it. Windows does not end a process with its parent, so an engine whose host died (an update,
 * a host restart, a crash) kept running with nobody to stop it, holding its memory, its project
 * files and its daemons' clients until a later launch swept it. The host passes its pid; once
 * that process is gone the engine stops itself.
 */
export const HOST_WATCH_INTERVAL_MS = 2_000;
/** How long the graceful shutdown may take before the engine exits anyway. */
export const HOST_GONE_EXIT_GRACE_MS = 15_000;

/** The host pid from the environment, or undefined when none (or an invalid one) was passed. */
export function hostPidFrom(value: string | undefined): number | undefined {
  const pid = Number(value);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/** Whether a process with this pid exists. EPERM means it exists but belongs to another user. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Calls `onGone` once, the first time `alive(pid)` answers false. Returns a cancel function. */
export function watchHost(
  pid: number,
  onGone: () => void,
  {
    intervalMs = HOST_WATCH_INTERVAL_MS,
    alive = processAlive,
  }: { intervalMs?: number; alive?: (pid: number) => boolean } = {},
): () => void {
  const timer = setInterval(() => {
    if (alive(pid)) return;
    clearInterval(timer);
    onGone();
  }, intervalMs);
  // The watch alone never keeps the engine running.
  timer.unref?.();
  return () => clearInterval(timer);
}
