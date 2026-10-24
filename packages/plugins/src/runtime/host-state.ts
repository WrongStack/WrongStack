import type { PluginAPI } from '@wrongstack/contracts/types';

interface HostState {
  abort: AbortController;
  extensionUnregister: (() => void) | null;
}

/** Reload and disposal belong to the API instance that owns the registration. */
export function createHostStates<T extends HostState>(
  create: () => T,
  dispose?: (state: T) => void,
) {
  const hosts = new Map<PluginAPI, T>();
  function remove(api: PluginAPI): T | undefined {
    const state = hosts.get(api);
    if (!state) return;
    hosts.delete(api);
    state.abort.abort();
    const unregister = state.extensionUnregister;
    state.extensionUnregister = null;
    try {
      unregister?.();
    } catch {
      // The host may already have disposed its extension registry.
    }
    dispose?.(state);
    return state;
  }
  return {
    reset(api: PluginAPI): T {
      remove(api);
      // Aborting the previous host runs listeners synchronously. A listener
      // may reset this API again; keep that later reset instead of replacing
      // its live state when the outer call resumes.
      const reentrant = hosts.get(api);
      if (reentrant) return reentrant;
      const state = create();
      hosts.set(api, state);
      return state;
    },
    remove,
    get: (api: PluginAPI) => hosts.get(api),
    values: () => hosts.values(),
  };
}

export function providerSignal(state: HostState, context: unknown): AbortSignal {
  const signal = (context as { signal?: AbortSignal } | null)?.signal;
  return signal ? AbortSignal.any([state.abort.signal, signal]) : state.abort.signal;
}
