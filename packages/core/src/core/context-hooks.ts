export async function drainHooks(hooks: Set<() => void | Promise<void>>): Promise<void> {
  const snapshot = [...hooks].reverse();
  // Clear before running so new hooks registered during iteration
  // fire on the next abort cycle (not the current one — hook chains
  // are intentionally not supported).
  hooks.clear();
  for (const fn of snapshot) {
    try {
      await fn();
    } catch {
      // hooks must be best-effort; swallow so siblings still fire
    }
  }
}

export function registerHook(
  hooks: Set<() => void | Promise<void>>,
  fn: () => void | Promise<void>,
): () => void {
  hooks.add(fn);
  return () => hooks.delete(fn);
}
