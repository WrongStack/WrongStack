import { describe, expect, it } from 'vitest';
import { resolveOnePlugin, resolvePluginToggleStates } from '../../src/lib/plugin-enablement.js';

describe('resolvePluginToggleStates', () => {
  it('returns an empty list when no plugins are configured and no overrides exist', () => {
    expect(resolvePluginToggleStates(undefined, undefined)).toEqual([]);
    expect(resolvePluginToggleStates([], undefined)).toEqual([]);
  });

  it('marks string entries as enabled and object entries with enabled:false as disabled', () => {
    const out = resolvePluginToggleStates(
      ['wstack-chimera', { name: 'telegram', enabled: false }, 'cost-tracker'],
      undefined,
    );
    expect(out).toEqual([
      {
        name: 'wstack-chimera',
        configuredEnabled: true,
        localOverride: undefined,
        resolved: true,
      },
      {
        name: 'telegram',
        configuredEnabled: false,
        localOverride: undefined,
        resolved: false,
      },
      {
        name: 'cost-tracker',
        configuredEnabled: true,
        localOverride: undefined,
        resolved: true,
      },
    ]);
  });

  it('treats a missing `enabled` key on a plugin object as enabled (default)', () => {
    const out = resolvePluginToggleStates(
      [{ name: 'injection-shield' /* enabled omitted */ }],
      undefined,
    );
    expect(out).toEqual([
      {
        name: 'injection-shield',
        configuredEnabled: true,
        localOverride: undefined,
        resolved: true,
      },
    ]);
  });

  it('uses the local override when present, ignoring the canonical state', () => {
    const out = resolvePluginToggleStates(['wstack-chimera'], { 'wstack-chimera': false });
    expect(out[0]).toEqual({
      name: 'wstack-chimera',
      configuredEnabled: true,
      localOverride: false,
      resolved: false,
    });
  });

  it('lets a local override re-enable a plugin that the canonical config disabled', () => {
    const out = resolvePluginToggleStates([{ name: 'telegram', enabled: false }], {
      telegram: true,
    });
    expect(out[0]).toEqual({
      name: 'telegram',
      configuredEnabled: false,
      localOverride: true,
      resolved: true,
    });
  });

  it('preserves the canonical entry order (the WebUI list ordering depends on it)', () => {
    const out = resolvePluginToggleStates(
      ['first', { name: 'second', enabled: false }, 'third'],
      undefined,
    );
    expect(out.map((p) => p.name)).toEqual(['first', 'second', 'third']);
  });
});

describe('resolveOnePlugin', () => {
  it('returns the resolved state when the plugin is configured', () => {
    expect(
      resolveOnePlugin(
        ['cost-tracker', { name: 'telegram', enabled: false }],
        undefined,
        'telegram',
      ),
    ).toEqual({
      name: 'telegram',
      configuredEnabled: false,
      localOverride: undefined,
      resolved: false,
    });
  });

  it('returns undefined when the plugin is not in the canonical config', () => {
    expect(resolveOnePlugin(['wstack-chimera'], undefined, 'telegram')).toBeUndefined();
  });

  it('honours a local override for a single lookup', () => {
    expect(
      resolveOnePlugin([{ name: 'telegram', enabled: false }], { telegram: true }, 'telegram'),
    ).toEqual({
      name: 'telegram',
      configuredEnabled: false,
      localOverride: true,
      resolved: true,
    });
  });
});
