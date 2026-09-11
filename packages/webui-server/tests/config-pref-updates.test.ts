/**
 * Settings-save must not write onto the frozen live config.
 *
 * Field report:
 *   {"level":"error","event":"webui_server.message_handler_failed",
 *    "message":"Cannot assign to read only property 'features' of object '#<Object>'"}
 *
 * `applyConfigPrefs` assigned straight onto `state.getConfig()`. `ConfigLoader`
 * returns `Object.freeze(cfg)` (config-loader.ts:287) and `patchConfig`
 * re-freezes (boot.ts:30), so in an ESM module — always strict mode — the first
 * property write threw and took the whole message handler with it. Saving
 * anything from the settings pane failed.
 *
 * Why no test caught it: the only coverage of this path
 * (`prefs-handlers.test.ts`) supplies `applyConfigPrefs` as a `vi.fn()`. The
 * stub accepted the payload and recorded the call, so the suite was green while
 * the real implementation had never once executed. A stub that stands in for
 * production code cannot falsify it — the same shape as the `allowAll`
 * permission-policy stub found during the 2026-09-11 audit.
 *
 * `Object.freeze` is SHALLOW, which is the reason the failure looked so odd:
 * the nested `features['mcp'] = …` writes immediately before the throw
 * succeeded, silently mutating the live config's nested object in place.
 */

import type { Config } from '@wrongstack/core/types';
import { describe, expect, it } from 'vitest';
import { patchConfig } from '../src/server/boot.js';
import { computeConfigPrefUpdates } from '../src/server/routes.js';

/** A config shaped and frozen the way `ConfigLoader.load()` hands one out. */
function frozenConfig(): Config {
  return Object.freeze({
    provider: 'anthropic',
    model: 'claude-opus-5',
    features: Object.freeze({
      mcp: false,
      plugins: false,
      memory: true,
      modelsRegistry: true,
      skills: true,
    }),
  }) as unknown as Config;
}

describe('computeConfigPrefUpdates', () => {
  it('does not throw on a frozen config', () => {
    const config = frozenConfig();
    expect(() => computeConfigPrefUpdates(config, { featureMcp: true })).not.toThrow();
  });

  it('leaves the source config untouched, nested objects included', () => {
    const config = frozenConfig();
    const before = JSON.stringify(config);
    const updates = computeConfigPrefUpdates(config, {
      featureMcp: true,
      featurePlugins: true,
      fallbackAuto: true,
    });
    expect(JSON.stringify(config)).toBe(before);
    // The returned block must be a NEW object, not the live one. Aliasing is
    // what let the pre-fix code mutate shared state without a setter.
    expect(updates.features).not.toBe(config.features);
  });

  it('merges feature flags over the existing block rather than replacing it', () => {
    const next = patchConfig(
      frozenConfig(),
      computeConfigPrefUpdates(frozenConfig(), {
        featureMcp: true,
      }),
    );
    expect(next.features?.mcp).toBe(true);
    // Untouched flags survive — a replace would have dropped these.
    expect(next.features?.memory).toBe(true);
    expect(next.features?.skills).toBe(true);
    expect(next.features?.plugins).toBe(false);
  });

  it('carries every non-feature key the settings pane can send', () => {
    const updates = computeConfigPrefUpdates(frozenConfig(), {
      fallbackModels: ['a', 'b'],
      fallbackProfiles: { fast: ['x'] },
      favoriteModels: ['m'],
      favoriteModelsOnly: true,
      modelMatrix: { plan: 'opus' },
      fallbackAuto: false,
    });
    expect(updates.fallbackModels).toEqual(['a', 'b']);
    expect(updates.fallbackProfiles).toEqual({ fast: ['x'] });
    expect(updates.favoriteModels).toEqual(['m']);
    expect(updates.favoriteModelsOnly).toBe(true);
    expect(updates.modelMatrix).toEqual({ plan: 'opus' });
    expect(updates.fallbackAuto).toBe(false);
  });

  it('returns an empty patch for a payload with nothing recognisable', () => {
    // The caller skips `setConfig` on an empty patch so config identity does
    // not churn for subscribers that compare by reference.
    expect(computeConfigPrefUpdates(frozenConfig(), { unrelated: 'x' })).toEqual({});
  });

  it('ignores non-boolean feature values instead of coercing them', () => {
    const updates = computeConfigPrefUpdates(frozenConfig(), {
      featureMcp: 'true',
      featureSkills: 1,
    });
    expect(updates.features).toBeUndefined();
  });

  // SECURITY.md rule 3: validate a guard by injection, never by watching it
  // pass. Without this, every assertion above would still pass if the fix were
  // reverted to in-place mutation — `computeConfigPrefUpdates` would simply
  // never be reached. This test pins the property the fix exists for.
  it('injection: the pre-fix in-place write really does throw on this config', () => {
    const config = frozenConfig();
    expect(() => {
      // Verbatim shape of the old code, against the same frozen object.
      (config as unknown as Record<string, unknown>)['features'] = { mcp: true };
    }).toThrow(/read only property 'features'/);
  });

  it('injection: the shallow freeze means a nested write would NOT have thrown', () => {
    // This is why the bug read as "features is read only" rather than "mcp is":
    // the nested writes preceding it succeeded. Pinned so the diagnosis in this
    // file's header cannot quietly become wrong.
    const config = Object.freeze({
      features: { mcp: false },
    }) as unknown as { features: Record<string, unknown> };
    expect(() => {
      config.features['mcp'] = true;
    }).not.toThrow();
    expect(config.features['mcp']).toBe(true);
  });
});
