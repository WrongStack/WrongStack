import { describe, expect, it } from 'vitest';
import {
  diffPluginConfig,
  redactPluginConfig,
  resolvePluginConfig,
  resolvePluginEnablement,
  validatePluginConfigMetadata,
} from '../../src/plugin/config.js';

describe('canonical plugin configuration', () => {
  it('uses one deterministic precedence order across legacy, entries, aliases, and extensions', () => {
    const result = resolvePluginConfig({
      name: 'telegram',
      aliases: ['@wrongstack/telegram'],
      defaults: { source: 'default', retained: true },
      config: {
        plugins: [{ name: '@wrongstack/telegram', options: { source: 'entry', entryOnly: true } }],
        extensions: {
          '@wrongstack/telegram': { source: 'alias-extension', aliasOnly: true },
          telegram: { source: 'canonical-extension', canonicalOnly: true },
        },
      },
      explicitOptions: { source: 'explicit' },
    });

    expect(result).toEqual({
      configured: true,
      sources: ['plugin-entry', 'extension', 'explicit-options'],
      options: {
        source: 'explicit',
        retained: true,
        entryOnly: true,
        aliasOnly: true,
        canonicalOnly: true,
      },
    });
  });

  it('keeps the legacy object-map input as a migration source', () => {
    const result = resolvePluginConfig({
      name: 'telegram',
      config: { plugins: { telegram: { botToken: 'legacy' } } as never },
    });
    expect(result.options).toEqual({ botToken: 'legacy' });
    expect(result.sources).toEqual(['legacy-plugin-map']);
  });

  it('classifies changes and redacts secret values', () => {
    const fields = {
      token: { lifecycle: 'restart', secret: true },
      interval: { lifecycle: 'hot' },
    } as const;
    expect(
      diffPluginConfig(
        { token: 'old', interval: 1, undeclared: false },
        { token: 'new', interval: 2, undeclared: true },
        fields,
      ),
    ).toEqual([
      {
        key: 'token',
        lifecycle: 'restart',
        secret: true,
        previous: '[REDACTED]',
        next: '[REDACTED]',
      },
      { key: 'interval', lifecycle: 'hot', secret: false, previous: 1, next: 2 },
      { key: 'undeclared', lifecycle: 'immutable', secret: false, previous: false, next: true },
    ]);
    expect(redactPluginConfig({ token: 'secret', interval: 2 }, fields)).toEqual({
      token: '[REDACTED]',
      interval: 2,
    });
  });

  it('reports schema/default fields missing opted-in lifecycle metadata', () => {
    expect(
      validatePluginConfigMetadata({
        configSchema: { properties: { token: { type: 'string' }, interval: { type: 'number' } } },
        defaultConfig: { interval: 2, extra: true },
        configFields: { token: { lifecycle: 'restart', secret: true } },
      }),
    ).toEqual([
      'missing configFields metadata for "interval"',
      'missing configFields metadata for "extra"',
    ]);
  });
});

// ── Enablement precedence ──────────────────────────────────────────────
//
// One resolver backs the loader (cli/wiring/plugins.ts), `wstack plugin
// report`, and the plugin_manager tool. The regression these tests pin:
// `extensions.<name>.enabled` was read ONLY by the loader, and only in its
// `=== true` direction — so a plugin switched on there ran while every
// report called it disabled, and `false` there turned nothing off.
describe('plugin enablement precedence', () => {
  const entry = { name: 'duplicate-code-detector', defaultState: 'inactive' as const };

  it('falls back to defaultState when nothing configures the plugin', () => {
    expect(resolvePluginEnablement({ ...entry, config: {} })).toEqual({
      enabled: false,
      source: 'default',
    });
    expect(
      resolvePluginEnablement({ name: 'wstack-prompts', defaultState: 'active', config: {} }),
    ).toEqual({ enabled: true, source: 'default' });
  });

  it('treats extensions.<name>.enabled as an explicit switch in BOTH directions', () => {
    expect(
      resolvePluginEnablement({
        ...entry,
        config: { extensions: { 'duplicate-code-detector': { enabled: true } } },
      }),
    ).toEqual({ enabled: true, source: 'extension' });

    // The half that used to be ignored: a default-active plugin switched
    // off through `extensions` kept running.
    expect(
      resolvePluginEnablement({
        name: 'type-gate',
        defaultState: 'active',
        config: { extensions: { 'type-gate': { enabled: false } } },
      }),
    ).toEqual({ enabled: false, source: 'extension' });
  });

  it('ignores a non-boolean extensions.enabled and keeps falling through', () => {
    expect(
      resolvePluginEnablement({
        ...entry,
        config: { extensions: { 'duplicate-code-detector': { enabled: 'yes', other: 1 } } },
      }),
    ).toEqual({ enabled: false, source: 'default' });
  });

  it('lets a plugins[] entry outrank extensions in both directions', () => {
    expect(
      resolvePluginEnablement({
        ...entry,
        config: {
          plugins: [{ name: 'duplicate-code-detector', enabled: false }],
          extensions: { 'duplicate-code-detector': { enabled: true } },
        },
      }),
    ).toEqual({ enabled: false, source: 'plugin-entry' });

    expect(
      resolvePluginEnablement({
        ...entry,
        config: {
          plugins: ['duplicate-code-detector'],
          extensions: { 'duplicate-code-detector': { enabled: false } },
        },
      }),
    ).toEqual({ enabled: true, source: 'plugin-entry' });
  });

  it('resolves an alias-spelled extensions namespace', () => {
    expect(
      resolvePluginEnablement({
        name: 'telegram',
        aliases: ['@wrongstack/telegram'],
        defaultState: 'inactive',
        config: { extensions: { '@wrongstack/telegram': { enabled: true } } },
      }),
    ).toEqual({ enabled: true, source: 'extension' });
  });

  it('honours a caller-supplied matcher for normalized plugin specs', () => {
    expect(
      resolvePluginEnablement({
        name: 'type-gate',
        defaultState: 'active',
        config: { plugins: [{ name: '@wrongstack/plugins/type-gate', enabled: false }] },
        matches: (spec) => spec.split('/').pop() === 'type-gate',
      }),
    ).toEqual({ enabled: false, source: 'plugin-entry' });
  });

  it('lets features.plugins=false outrank every per-plugin switch', () => {
    expect(
      resolvePluginEnablement({
        ...entry,
        config: {
          features: { plugins: false },
          plugins: ['duplicate-code-detector'],
          extensions: { 'duplicate-code-detector': { enabled: true } },
        },
      }),
    ).toEqual({ enabled: false, source: 'feature-flag' });
  });
});
