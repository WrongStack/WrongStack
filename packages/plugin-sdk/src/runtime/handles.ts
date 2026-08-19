/**
 * @wrongstack/plugins — unregister-handle discipline.
 *
 * Plugins keep their hook/listener unregister functions in module-scope
 * state, and every plugin's `setup()` is expected to be idempotent: calling
 * it twice must not leave two live registrations. The house style calls
 * this the "H1 pattern".
 *
 * The failure mode this helper exists to prevent is subtle and was present
 * in ~15 plugins: `setup()` reset the handle with
 *
 * ```ts
 * state.hookUnregister = null;   // WRONG
 * ```
 *
 * which drops the only reference to the *previous* registration without
 * calling it. The old hook stays live in the registry, unreachable, and
 * fires alongside the new one — so counters double, warnings appear twice,
 * and a gate can block on a stale closure holding the previous config.
 *
 * `releaseHandle` makes the correct spelling a one-liner with the same
 * shape as the wrong one, so the two are hard to confuse:
 *
 * ```ts
 * state.hookUnregister = releaseHandle(state.hookUnregister);
 * ```
 */

/** An unregister function returned by `registerHook`/`onEvent`/etc. */
export type Unregister = (() => void) | null | undefined;

/**
 * Invoke `off` if present, swallowing any error, and return `null` so the
 * caller can assign the result straight back to the handle.
 *
 * Unregistering is best-effort by design: a handle whose owner has already
 * been torn down may throw, and that must never prevent the rest of
 * `setup()`/`teardown()` from running.
 */
export function releaseHandle(off: Unregister): null {
  if (off) {
    try {
      off();
    } catch {
      // best-effort — a already-disposed registry must not break re-init
    }
  }
  return null;
}

/**
 * Release several handles held on one state object, clearing each in place.
 *
 * @example
 * releaseHandles(state, ['hookUnregister', 'postHookUnregister']);
 */
export function releaseHandles<S extends object, K extends keyof S>(
  state: S,
  keys: readonly K[],
): void {
  for (const key of keys) {
    state[key] = releaseHandle(state[key] as Unregister) as S[K];
  }
}
