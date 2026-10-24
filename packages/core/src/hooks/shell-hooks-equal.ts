/**
 * Helpers for comparing and counting shell-hook configurations.
 * Used by the hot-reload path: the `ConfigStore` watcher fires on every
 * `configStore.update` call (model, log level, anything), so we need a
 * cheap predicate to decide whether `config.hooks` actually changed before
 * re-running `replaceShellHooks`.
 *
 * Pure functions — no I/O, no logger, no side effects. Safe to import
 * from anywhere.
 */
import type { ConfiguredHook, HookEvent } from '@wrongstack/contracts/types/hooks';

/**
 * Compare two `config.hooks` maps. Returns true when they describe the
 * same set of entries (same events, same order, same transport/configuration).
 * Both arguments may be undefined — the absence of
 * `hooks` is a valid state.
 *
 * Object-identity per entry is **not** required because `configStore.update`
 * may rebuild the maps from JSON. Object key order (including header order)
 * is ignored, while array/registration order remains significant.
 */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function shellHooksEqual(
  a: Partial<Record<HookEvent, ConfiguredHook[]>> | undefined,
  b: Partial<Record<HookEvent, ConfiguredHook[]>> | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return !a && !b;
  const aKeys = Object.keys(a).filter((k) => a[k as HookEvent] !== undefined);
  const bKeys = Object.keys(b).filter((k) => b[k as HookEvent] !== undefined);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    const event = k as HookEvent;
    const aList = a[event];
    const bList = b[event];
    if (aList === bList) continue;
    if (!aList || !bList) return false;
    if (aList.length !== bList.length) return false;
    for (let i = 0; i < aList.length; i++) {
      const x = aList[i];
      const y = bList[i];
      if (!x || !y) return !x && !y;
      if (stableJson(x) !== stableJson(y)) return false;
    }
  }
  return true;
}

/** Count the total number of shell-hook entries across all events. */
export function countShellHooks(
  hooks: Partial<Record<HookEvent, ConfiguredHook[]>> | undefined,
): number {
  if (!hooks) return 0;
  let n = 0;
  for (const list of Object.values(hooks)) {
    if (list) n += list.length;
  }
  return n;
}
