// ---------------------------------------------------------------------------
// P2.1 — Unified plugin enablement view.
//
// NOT WIRED TO THE PANEL, and deliberately so. `PluginToggleList` renders
// `localPrefs.pluginsEnabled`, which the server seeds (context-meta.ts) with
// the EFFECTIVE state it computes via core's `resolvePluginEnablement` — the
// one precedence every surface shares: features.plugins → config.plugins →
// extensions.<name>.enabled → catalog defaultState. Resolving again in the
// browser would mean a second, drifting copy, which is exactly the bug that
// let a plugin run while every report called it disabled.
//
// RENAMED away from core's `resolvePluginEnablement`: sharing that name across
// two packages with different signatures and different semantics is a trap —
// the next contributor autocompletes it inside a panel and silently gets the
// weaker one, reproducing the exact drift this header warns about.
//
// What survives here is the P2 gate's contract evidence for the local-override
// join, kept because the browser can hold an override the server has not seen
// yet. Two rules if this is ever wired into the UI: it must not import
// `@wrongstack/core/plugin` (Node-only — see the browser-safe subpath rule),
// and its precedence must be re-derived from core rather than restated. As
// written it consults `config.plugins` alone and would report an
// extensions-enabled plugin as absent.
//
// Write-side is `localPrefs.set`, which the server projects onto BOTH
// `extensions.<name>.enabled` and any matching `config.plugins` entry
// (pref-helpers.ts) so the toggle lands on whichever layer wins.
// ---------------------------------------------------------------------------

import type { PluginConfig } from '@wrongstack/core/types';

type PluginEntry = string | PluginConfig;

interface ResolvedPluginState {
  /** Plugin name as it appears in `Config.plugins`. */
  readonly name: string;
  /** True iff the canonical config says this plugin is enabled. */
  readonly configuredEnabled: boolean;
  /**
   * `undefined` if the user has not overridden the plugin locally
   * (and the toggle UI should show the canonical value).
   * `true`/`false` if the user pinned an explicit local state.
   */
  readonly localOverride: boolean | undefined;
  /**
   * The resolved enablement used by the UI: local override wins when
   * the user pinned one, otherwise the canonical config decides.
   */
  readonly resolved: boolean;
}

/** True iff the plugin entry is disabled in the canonical config. */
function isPluginEntryDisabled(entry: PluginEntry): boolean {
  return typeof entry === 'object' && entry.enabled === false;
}

/** Strip the `PluginConfig` wrapper to the canonical plugin name. */
function pluginNameOf(entry: PluginEntry): string {
  return typeof entry === 'string' ? entry : entry.name;
}

/**
 * Resolve the effective enablement of every plugin in the canonical list.
 *
 * `configuredPlugins` defaults to `[]` so a missing server payload
 * degrades to "all enabled" rather than throwing — a SafeBy default that
 * matches the WebUI's prior `localPrefs.pluginsEnabled?.[name] ?? true`
 * behaviour. The local override map may be missing, in which case only
 * the canonical config is consulted.
 */
export function resolvePluginToggleStates(
  configuredPlugins: readonly PluginEntry[] | undefined,
  localOverrides: Readonly<Record<string, boolean>> | undefined,
): ResolvedPluginState[] {
  if (!configuredPlugins || configuredPlugins.length === 0) return [];
  const out: ResolvedPluginState[] = [];
  for (const entry of configuredPlugins) {
    const name = pluginNameOf(entry);
    const configuredEnabled = !isPluginEntryDisabled(entry);
    const localOverride = localOverrides?.[name];
    const resolved = localOverride ?? configuredEnabled;
    out.push({ name, configuredEnabled, localOverride, resolved });
  }
  return out;
}

/**
 * Convenience accessor for callers that only need one plugin's resolved
 * state. Returns `undefined` if the plugin is not configured at all
 * (the toggle UI should treat that as "managed out — not in this list").
 */
export function resolveOnePlugin(
  configuredPlugins: readonly PluginEntry[] | undefined,
  localOverrides: Readonly<Record<string, boolean>> | undefined,
  name: string,
): ResolvedPluginState | undefined {
  const all = resolvePluginToggleStates(configuredPlugins, localOverrides);
  return all.find((p) => p.name === name);
}
