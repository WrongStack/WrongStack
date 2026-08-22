/**
 * Pure data-shaping helpers for the `<SettingsPanel>` provider
 * callbacks. Extracted out of the parent so the test suite can
 * exercise the data flow without rendering React.
 *
 * These reducers are the single source of truth for "what does
 * the local `savedProviders` array look like after a clear / undo
 * cycle?" — the parent wires them up via `setSavedProviders` and
 * the WS round-trip.
 *
 * Both functions are immutable: they return new arrays and new
 * provider objects, never mutate inputs. The undo reducer also
 * defensive-copies the input `previousModels` list so a caller
 * who later mutates the array they passed in cannot surprise the
 * saved state.
 */
import type { SavedProvider } from './ProviderSection';

/**
 * Whether the parent's "Clear allowlist" button should be visible
 * for a given saved provider. Mirrors the panel's
 * `shouldOfferClear(savedModels)` filter but reads the saved
 * provider shape instead of a bare `string[]`.
 */
export function shouldOfferClearFromSaved(sp: SavedProvider): boolean {
  return (sp.models?.length ?? 0) > 0;
}

/**
 * Drop `models` and `pickedModelId` from the targeted provider —
 * the optimistic state after the user confirms a clear. Untouched
 * providers are returned by reference. Returns a new top-level
 * array; the targeted provider is a new object.
 */
export function applyClearModels(providers: SavedProvider[], providerId: string): SavedProvider[] {
  let touched = false;
  const next = providers.map((sp) => {
    if (sp.id !== providerId) return sp;
    touched = true;
    const { pickedModelId: _drop, models: _drop2, ...rest } = sp;
    void _drop;
    void _drop2;
    return { ...rest } as SavedProvider;
  });
  // If no provider matched, return the original array to preserve
  // referential equality for the no-op case.
  return touched ? next : providers;
}

/**
 * Restore `models` (and `pickedModelId` derived from the first
 * id) for the targeted provider — the optimistic state after the
 * user clicks "Undo" on the toast. Untouched providers are
 * returned by reference. Returns a new top-level array; the
 * targeted provider is a new object.
 */
export function applyUndoClear(
  providers: SavedProvider[],
  providerId: string,
  previousModels: string[],
): SavedProvider[] {
  // Defensive copy so a caller mutating their input list later
  // doesn't leak into the saved state.
  const restored = [...previousModels];
  let touched = false;
  const next = providers.map((sp) => {
    if (sp.id !== providerId) return sp;
    touched = true;
    const pickedModelId = restored[0];
    return {
      ...sp,
      ...(pickedModelId !== undefined ? { pickedModelId } : {}),
      models: restored,
    };
  });
  return touched ? next : providers;
}
