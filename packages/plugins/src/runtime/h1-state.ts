/**
 * H1 idempotent state — single-slot plugin state with a registry of
 * releasable handles that survives `setup()` reload cycles.
 *
 * The "H1 audit pattern" (per SAGE memory T-03) is documented across
 * the plugin suite: a plugin's module-scope `state` object holds
 * counters plus a `hookUnregister` (or `extensionUnregister`) slot;
 * on reload, the slot MUST be released before a new one is stored.
 * Every plugin implements this inline with subtle variations:
 *
 *   - some use `releaseHandle(state.hookUnregister)` (`accessibility-auditor`)
 *   - some use `try { state.hookUnregister(); } catch {}` (`config-validator`)
 *   - some use a single inline `if (state.hookUnregister) { … }` block
 *
 * The drift cost: in 4 plugins the prior handle was leaked on reload
 * because the inline `if` check raced with the new registration.
 * This helper centralises the contract.
 *
 * Contract:
 *   `createH1State<T>(initial)` returns
 *     {
 *       state:    T,                    // the user's mutable state
 *       register: (key, unregister) => void,
 *       release:  (key) => void,
 *       releaseAll: () => void,
 *     }
 *
 * - `register(key, unregister)` releases any prior handle at `key`
 *   before storing the new one.
 * - `release(key)` is a no-op if no handle is registered.
 * - `releaseAll()` releases every registered handle and clears the map.
 * - A throwing unregister function is swallowed (best-effort), matching
 *   the existing `releaseHandle` semantics at `runtime/handles.ts`.
 *
 * The state object itself is NOT reset by `releaseAll` — counter
 * reset is the plugin's responsibility (it knows the semantics of its
 * counters). This helper owns the handle lifecycle only.
 */

export type Unregister = () => void;

export interface H1State<T> {
  /** The plugin's mutable state. Owned by the caller; never reset by this helper. */
  state: T;
  /**
   * Register an unregister function under `key`. Any prior handle at
   * `key` is released first. Throwing unregister functions are
   * swallowed.
   */
  register: (key: string, unregister: Unregister | null | undefined) => void;
  /**
   * Release the handle at `key` (if any). Idempotent. Throwing
   * unregister functions are swallowed.
   */
  release: (key: string) => void;
  /** Release every registered handle. Idempotent. */
  releaseAll: () => void;
  /** Number of currently registered handles. Observability for health()/status tools. */
  size: () => number;
  /** List the registered keys. Order is insertion order; useful for diagnostics. */
  keys: () => string[];
}

export function createH1State<T>(initial: T): H1State<T> {
  const handles = new Map<string, Unregister>();

  const safeRelease = (unregister: Unregister): void => {
    try {
      unregister();
    } catch {
      // best-effort: a throwing unregister (e.g. a hook already
      // disposed by the runtime) must not propagate. Mirrors
      // `runtime/handles.ts:releaseHandle`.
    }
  };

  return {
    state: initial,

    register(key, unregister) {
      const prior = handles.get(key);
      if (prior) {
        safeRelease(prior);
        handles.delete(key);
      }
      if (unregister) {
        handles.set(key, unregister);
      }
    },

    release(key) {
      const prior = handles.get(key);
      if (!prior) return;
      handles.delete(key);
      safeRelease(prior);
    },

    releaseAll() {
      for (const unregister of handles.values()) {
        safeRelease(unregister);
      }
      handles.clear();
    },

    size() {
      return handles.size;
    },

    keys() {
      return [...handles.keys()];
    },
  };
}
