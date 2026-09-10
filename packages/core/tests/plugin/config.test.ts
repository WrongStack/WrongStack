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

describe('resolvePluginConfig prototype-key filtering', () => {
  /**
   * `resolvePluginConfig` used `Object.assign(options, value)`, the only merge
   * helper in the repo without a prototype-key filter. `Object.assign` copies
   * with [[Set]], so an OWN `__proto__` key — which `JSON.parse` produces, as
   * the first assertion below shows — invokes the Object.prototype setter and
   * replaces the target's prototype instead of adding a property.
   *
   * The audit recorded this as "reachable only from trusted layers". It is not:
   * `config` is the merged config and in-project `.wrongstack/config.json`
   * feeds into it, which this repo's trust boundary treats as untrusted.
   */
  it('JSON.parse really does produce an own __proto__ key', () => {
    // The premise the rest of this block rests on. If a future runtime stops
    // doing this, these tests would pass vacuously.
    const parsed = JSON.parse('{"a":1,"__proto__":{"isAdmin":true}}') as Record<string, unknown>;
    expect(Object.hasOwn(parsed, '__proto__')).toBe(true);
    expect(Object.keys(parsed)).toContain('__proto__');
  });

  it('does not let a config-supplied __proto__ reach the resolved options', () => {
    const hostile = JSON.parse('{"real":1,"__proto__":{"isAdmin":true}}') as Record<
      string,
      unknown
    >;
    const resolved = resolvePluginConfig({
      name: 'demo',
      config: { plugins: { demo: hostile } as never },
    });

    expect(Object.getPrototypeOf(resolved.options)).toBe(Object.prototype);
    expect((resolved.options as { isAdmin?: unknown }).isAdmin).toBeUndefined();
    // The legitimate key still merges — the filter must not be a blanket drop.
    expect(resolved.options['real']).toBe(1);
  });

  it('drops constructor and prototype keys too', () => {
    const hostile = JSON.parse(
      '{"keep":1,"constructor":{"x":1},"prototype":{"y":2}}',
    ) as Record<string, unknown>;
    const resolved = resolvePluginConfig({
      name: 'demo',
      config: { plugins: { demo: hostile } as never },
    });

    expect(Object.hasOwn(resolved.options, 'constructor')).toBe(false);
    expect(Object.hasOwn(resolved.options, 'prototype')).toBe(false);
    expect(resolved.options['keep']).toBe(1);
  });
});
