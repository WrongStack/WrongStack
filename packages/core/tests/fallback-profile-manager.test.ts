import { describe, expect, it } from 'vitest';
import { FallbackProfileManager } from '../src/core/fallback-profile-manager.js';
import type { Config } from '../src/types/config.js';

function makeConfig(overrides?: Partial<Config>): Config {
  return {
    provider: 'openai',
    model: 'gpt-4o',
    providers: {
      openai: {
        apiKey: 'sk-test',
        models: ['gpt-4o', 'gpt-4o-mini'],
      },
      anthropic: {
        apiKey: 'sk-ant-test',
        models: ['claude-opus-4-8', 'claude-sonnet-4-8'],
      },
      unkeyed: {
        models: ['some-model'],
      },
    },
    fallbackProfiles: {
      'primary-failover': ['anthropic/claude-opus-4-8', 'openai/gpt-4o-mini'],
      'cross-provider': ['anthropic/claude-sonnet-4-8', '/gpt-4o-mini'],
      'empty-chain': [],
      'self-ref': ['openai/gpt-4o', 'anthropic/claude-opus-4-8'],
    },
    ...overrides,
  } as unknown as Config;
}

describe('FallbackProfileManager', () => {
  it('resolves a named profile to resolved entries', () => {
    const mgr = new FallbackProfileManager(makeConfig());
    const chain = mgr.resolve('primary-failover');

    expect(chain).toHaveLength(2);
    expect(chain[0]?.providerId).toBe('anthropic');
    expect(chain[0]?.model).toBe('claude-opus-4-8');
    expect(chain[0]?.providerSwitched).toBe(true);
    expect(chain[1]?.providerId).toBe('openai');
    expect(chain[1]?.model).toBe('gpt-4o-mini');
  });

  it('keeps profile entries whose provider carries no credentials in config', () => {
    // Config-level "usability" is not a reliable signal (a key can reach the
    // provider without appearing in `config.providers`), and applying it only
    // on the profile path silently rerouted profile-pinned roles. Entries are
    // kept; an entry that truly cannot be built is dropped by the chain runner
    // when `buildProvider` throws.
    const mgr = new FallbackProfileManager(
      makeConfig({
        fallbackProfiles: {
          'no-key-test': ['unkeyed/some-model', 'anthropic/claude-opus-4-8'],
        },
      }),
    );
    expect(mgr.resolve('no-key-test').map((e) => `${e.providerId}/${e.model}`)).toEqual([
      'unkeyed/some-model',
      'anthropic/claude-opus-4-8',
    ]);
  });

  it('filters out self-reference exclude', () => {
    const mgr = new FallbackProfileManager(makeConfig());
    const chain = mgr.resolve('self-ref', {
      exclude: { providerId: 'openai', model: 'gpt-4o' },
    });
    // openai/gpt-4o is excluded → only anthropic remains
    expect(chain).toHaveLength(1);
    expect(chain[0]?.providerId).toBe('anthropic');
  });

  it('deduplicates entries in a profile', () => {
    const mgr = new FallbackProfileManager(
      makeConfig({
        fallbackProfiles: {
          dupes: ['anthropic/claude-opus-4-8', 'anthropic/claude-opus-4-8'],
        },
      }),
    );
    const chain = mgr.resolve('dupes');
    expect(chain).toHaveLength(1);
  });

  it('returns empty chain for unknown profile', () => {
    const mgr = new FallbackProfileManager(makeConfig());
    expect(mgr.resolve('does-not-exist')).toHaveLength(0);
  });

  it('returns empty chain for empty profile', () => {
    const mgr = new FallbackProfileManager(makeConfig());
    expect(mgr.resolve('empty-chain')).toHaveLength(0);
  });

  it('lists known profile names', () => {
    const mgr = new FallbackProfileManager(makeConfig());
    const names = mgr.listProfiles();
    expect(names).toContain('primary-failover');
    expect(names).toContain('cross-provider');
    expect(names).not.toContain('does-not-exist');
  });

  it('reload preserves service identity and atomically replaces the active snapshot', () => {
    const oldCfg = makeConfig({ fallbackProfiles: { old: ['anthropic/claude-opus-4-8'] } });
    const newCfg = makeConfig({ fallbackProfiles: { new: ['openai/gpt-4o-mini'] } });
    const mgr = new FallbackProfileManager(oldCfg);
    expect(mgr.hasProfile('old')).toBe(true);
    expect(mgr.hasProfile('new')).toBe(false);

    expect(mgr.reload(newCfg)).toBeUndefined();
    expect(mgr.hasProfile('old')).toBe(false);
    expect(mgr.hasProfile('new')).toBe(true);
  });

  it('checks provider availability', () => {
    const mgr = new FallbackProfileManager(makeConfig());
    const openai = mgr.checkProvider('openai');
    expect(openai).toMatchObject({
      hasKey: true,
      hasEndpoint: false,
      hasModels: true,
      usable: true,
    });

    const unknown = mgr.checkProvider('does-not-exist');
    expect(unknown).toMatchObject({
      hasKey: false,
      hasEndpoint: false,
      hasModels: false,
      usable: false,
    });

    const unkeyed = mgr.checkProvider('unkeyed');
    expect(unkeyed).toMatchObject({
      hasKey: false,
      hasEndpoint: false,
      hasModels: true,
      usable: false,
    });
  });

  describe('resolveEffective', () => {
    it('uses explicit fallbackModels first', () => {
      const mgr = new FallbackProfileManager(makeConfig());
      const chain = mgr.resolveEffective({
        fallbackModels: ['anthropic/claude-opus-4-8'],
        fallbackProfile: 'primary-failover',
      });
      expect(chain).toHaveLength(1);
      expect(chain[0]?.providerId).toBe('anthropic');
    });

    it('falls back to named profile when no explicit models', () => {
      const mgr = new FallbackProfileManager(makeConfig());
      const chain = mgr.resolveEffective({
        fallbackProfile: 'primary-failover',
      });
      expect(chain).toHaveLength(2);
    });

    it('returns smart default when nothing explicit set', () => {
      const mgr = new FallbackProfileManager(makeConfig());
      const chain = mgr.resolveEffective({});
      // openai/gpt-4o-mini (same provider) + anthropic entries (cross-provider)
      // leader openai has gpt-4o-mini as alternative
      // anthropic has claude-opus-4-8 and claude-sonnet-4-8
      expect(chain.length).toBeGreaterThanOrEqual(1);
      // First should be same-provider
      expect(chain[0]?.providerId).toBe('openai');
    });

    it('returns empty when fallbackAuto is false and nothing explicit', () => {
      const mgr = new FallbackProfileManager(makeConfig());
      const chain = mgr.resolveEffective({ fallbackAuto: false });
      expect(chain).toHaveLength(0);
    });

    it('prepends a fully-qualified continuity bridge even when auto fallback is off', () => {
      const mgr = new FallbackProfileManager(
        makeConfig({ fallbackBridge: 'anthropic/claude-sonnet-4-8' }),
      );
      const chain = mgr.resolveEffective({
        fallbackModels: ['openai/gpt-4o-mini'],
        fallbackAuto: false,
      });
      expect(chain.map((entry) => `${entry.providerId}/${entry.model}`)).toEqual([
        'anthropic/claude-sonnet-4-8',
        'openai/gpt-4o-mini',
      ]);
    });

    it('rejects a bare-model bridge instead of silently keeping it on the active provider', () => {
      const mgr = new FallbackProfileManager(makeConfig({ fallbackBridge: 'gpt-4o-mini' }));
      expect(mgr.resolveBridge()).toEqual([]);
    });

    it('keeps a cross-provider escape hatch in the four-entry smart chain', () => {
      const mgr = new FallbackProfileManager(
        makeConfig({
          providers: {
            openai: {
              type: 'openai',
              apiKey: 'sk-test',
              models: ['gpt-4o', 'same-1', 'same-2', 'same-3', 'same-4', 'same-5'],
            },
            anthropic: { type: 'anthropic', apiKey: 'sk-ant-test', models: ['cross-1'] },
          },
        }),
      );
      const refs = mgr
        .resolveEffective({ fallbackAuto: true })
        .map((entry) => `${entry.providerId}/${entry.model}`);
      expect(refs).toHaveLength(4);
      expect(refs).toContain('anthropic/cross-1');
    });

    it('exposes a bounded last-resort inventory separately from the smart chain', () => {
      const mgr = new FallbackProfileManager(
        makeConfig({
          providers: {
            openai: {
              type: 'openai',
              apiKey: 'sk-test',
              models: ['gpt-4o', 'same-1', 'same-2', 'same-3', 'same-4', 'same-5'],
            },
            anthropic: {
              type: 'anthropic',
              apiKey: 'sk-ant-test',
              models: ['cross-1', 'cross-2'],
            },
          },
        }),
      );
      expect(mgr.resolveEffective({ fallbackAuto: true })).toHaveLength(4);
      expect(mgr.resolveAllConfigured()).toHaveLength(7);
    });

    it('caps resolveAllConfigured at MAX_LAST_RESORT_CANDIDATES', () => {
      const manyProviders: Record<string, { type: string; apiKey: string; models: string[] }> =
        {};
      for (let i = 0; i < 8; i++) {
        manyProviders[`prov${i}`] = {
          type: 'openai',
          apiKey: `sk-${i}`,
          models: [`m${i}-a`, `m${i}-b`, `m${i}-c`],
        };
      }
      const mgr = new FallbackProfileManager(
        makeConfig({
          provider: 'prov0',
          model: 'm0-a',
          providers: manyProviders,
        }),
      );
      const chain = mgr.resolveAllConfigured();
      // 8 providers × 3 models = 24 candidates, but the chain is capped.
      expect(chain.length).toBeLessThanOrEqual(12);
    });

    describe('favoriteModelsOnly contract on smart default', () => {
      // Contract pinned 2026-07-28. `favoriteModelsOnly` only narrows
      // the smart-default chain — it does not affect explicit
      // assignments (`agent_model_assign` model-only mode, profile
      // lookups, explicit fallbackModels). The asymmetry vs the model-only
      // matrix mode is intentional: a smart default is a *default*, while
      // a model-only matrix entry is an *explicit* user choice that is
      // already at least as strict as the smart default.
      //
      // These tests lock the precise semantics so a future refactor cannot
      // silently tighten or loosen the smart default in either direction.

      it('returns the full chain when favoriteModelsOnly is on but favorites list is empty', () => {
        // `hasFavorites` is false, so the smart default bypasses the
        // favorites-only filter — every provider/model pair the
        // provider declares is included. This is the documented
        // behavior the toggle's docstring calls out as auto-derivation
        // gating.
        const mgr = new FallbackProfileManager(
          makeConfig({ favoriteModels: [], favoriteModelsOnly: true }),
        );
        const chain = mgr.resolveEffective({});
        // The fixture declares openai/gpt-4o + gpt-4o-mini and anthropic's
        // two claude models (per the test fixture). The chain must contain
        // at least the cross-provider entries since the leader is openai.
        const anthropicEntries = chain.filter((e) => e.providerId === 'anthropic');
        expect(anthropicEntries.length).toBeGreaterThanOrEqual(2);
      });

      it('restricts the chain to favorites when favoriteModelsOnly is on AND favorites exist', () => {
        // `hasFavorites` is true, so the smart default drops every
        // provider/model pair that is not in the favorites list.
        const mgr = new FallbackProfileManager(
          makeConfig({
            favoriteModels: ['openai/gpt-4o-mini'],
            favoriteModelsOnly: true,
          }),
        );
        const chain = mgr.resolveEffective({});
        const refs = chain.map((e) => `${e.providerId}/${e.model}`);
        // Every entry must be a favorite — openai/gpt-4o-mini is the
        // only favorite, and the leader model (openai/gpt-4o) is excluded
        // by the default `exclude: { providerId: leaderProvider, model: leaderModel }`.
        expect(refs).toEqual(['openai/gpt-4o-mini']);
      });

      it('returns the full chain when favoriteModelsOnly is off, regardless of favorites', () => {
        // The toggle is OFF, so the smart default never narrows the
        // chain — even when favorites exist, non-favorites appear.
        const mgr = new FallbackProfileManager(
          makeConfig({
            favoriteModels: ['openai/gpt-4o-mini'],
            favoriteModelsOnly: false,
          }),
        );
        const chain = mgr.resolveEffective({});
        const anthropicEntries = chain.filter((e) => e.providerId === 'anthropic');
        expect(anthropicEntries.length).toBeGreaterThanOrEqual(2);
      });
    });
  });

  describe('edge cases', () => {
    it('handles empty config with no providers', () => {
      const mgr = new FallbackProfileManager({} as Config);
      expect(mgr.resolve('anything')).toHaveLength(0);
      expect(mgr.listProfiles()).toHaveLength(0);
      expect(mgr.checkProvider('x').hasKey).toBe(false);
    });

    it('handles provider with env var key', () => {
      process.env['FALLBACK_TEST_KEY'] = 'sk-test';
      try {
        const cfg = makeConfig({});
        cfg.providers = {
          openai: { type: 'openai', apiKey: 'sk-test', models: ['gpt-4o'] },
          envProvider: { envVars: ['FALLBACK_TEST_KEY'], models: ['test-model'] } as any,
        };
        const mgr = new FallbackProfileManager(cfg);
        const avail = mgr.checkProvider('envProvider');
        expect(avail.hasKey).toBe(true);
      } finally {
        delete process.env['FALLBACK_TEST_KEY'];
      }
    });

    it('accepts a keyless self-hosted provider with a configured endpoint', () => {
      const cfg = makeConfig({
        providers: {
          local: {
            type: 'openai-compatible',
            baseUrl: 'http://127.0.0.1:11434/v1',
            models: ['local-model'],
          },
        },
        fallbackProfiles: {
          local: ['local/local-model'],
        },
      });
      const mgr = new FallbackProfileManager(cfg);
      expect(mgr.checkProvider('local')).toMatchObject({
        hasKey: false,
        hasEndpoint: true,
        usable: true,
      });
      expect(mgr.resolve('local')).toHaveLength(1);
    });

    it('inherits top-level credentials for the configured primary provider', () => {
      const cfg = makeConfig({
        apiKey: 'top-level-key',
        providers: {
          openai: { type: 'openai', models: ['gpt-4o', 'gpt-4o-mini'] },
        },
      });
      const mgr = new FallbackProfileManager(cfg);
      // The subject: a top-level `apiKey` counts as a credential for the
      // configured primary provider even when its `providers` entry has none.
      expect(mgr.checkProvider('openai').usable).toBe(true);
      expect(mgr.checkProvider('anthropic').usable).toBe(false);
      // Chain resolution no longer filters on that verdict (see `resolve`),
      // so the unconfigured provider's entry is still offered and is dropped
      // later by `buildProvider` if it really cannot be constructed.
      expect(mgr.resolve('primary-failover')).toEqual([
        { providerId: 'anthropic', model: 'claude-opus-4-8', providerSwitched: true },
        { providerId: 'openai', model: 'gpt-4o-mini', providerSwitched: false },
      ]);
    });

    it('keeps profile entries missing from the provider model list, matching resolveRefs', () => {
      // `providers[id].models` is an unrefreshed snapshot — re-auth and manual
      // edits rewrite it. Filtering profiles on it silently deleted entries
      // that were valid when the profile was written, while the SAME ref
      // survived in `fallbackModels` (resolveRefs never applied the filter).
      // Both paths now keep the entry; a model the provider dropped answers
      // 404 and the chain runner moves to the next candidate.
      const cfg = makeConfig({
        providers: {
          limited: { type: 'openai', apiKey: 'sk-test', models: ['allowed-model'] },
        },
        fallbackProfiles: {
          restricted: ['limited/allowed-model', 'limited/stale-model'],
        },
      });
      const mgr = new FallbackProfileManager(cfg);
      expect(mgr.resolve('restricted').map((e) => e.model)).toEqual([
        'allowed-model',
        'stale-model',
      ]);
      // Parity: the explicit-refs path produces the identical chain.
      expect(
        mgr.resolveRefs(['limited/allowed-model', 'limited/stale-model']).map((e) => e.model),
      ).toEqual(['allowed-model', 'stale-model']);
    });

    it('keeps entries on a provider with no key in config on BOTH paths', () => {
      // `checkProvider().usable` only sees credentials the CONFIG carries, so
      // it is a false negative whenever the key reaches the provider by any
      // other route. Profiles used to apply it and the explicit path did not.
      // Neither applies it now; a genuinely unbuildable provider is dropped by
      // the chain runner when `buildProvider` throws.
      const cfg = makeConfig({
        providers: {
          keyed: { type: 'openai', apiKey: 'sk-test' },
          unkeyed: { type: 'openai' },
        },
        fallbackProfiles: { mixed: ['unkeyed/m1', 'keyed/m2'] },
      });
      const mgr = new FallbackProfileManager(cfg);
      const expected = ['unkeyed/m1', 'keyed/m2'];
      expect(mgr.resolve('mixed').map((e) => `${e.providerId}/${e.model}`)).toEqual(expected);
      expect(
        mgr.resolveRefs(['unkeyed/m1', 'keyed/m2']).map((e) => `${e.providerId}/${e.model}`),
      ).toEqual(expected);
    });
  });

  describe('resolveAllConfigured cap', () => {
    it('uses config.fallbackMaxLastResortCandidates when set', () => {
      const cfg = makeConfig({
        providers: {
          p1: { type: 'openai', apiKey: 'sk-1', models: ['m1', 'm2', 'm3'] },
          p2: { type: 'openai', apiKey: 'sk-2', models: ['m1', 'm2', 'm3'] },
        },
        fallbackMaxLastResortCandidates: 2,
      });
      const mgr = new FallbackProfileManager(cfg);
      // 6 models total, cap at 2 → exactly 2 after slicing
      const chain = mgr.resolveAllConfigured({ providerId: 'p1', model: 'm1' });
      expect(chain).toHaveLength(2);
    });

    it('falls back to default constant when config value is unset', () => {
      const cfg = makeConfig({
        providers: {
          p1: { type: 'openai', apiKey: 'sk-1', models: Array.from({ length: 20 }, (_, i) => `m${i}`) },
        },
        // fallbackMaxLastResortCandidates not set — should default to 12
      });
      const mgr = new FallbackProfileManager(cfg);
      const chain = mgr.resolveAllConfigured({ providerId: 'p1', model: 'm0' });
      // 20 models minus the excluded primary = 19 candidates, but the default
      // cap of 12 slices to exactly 12 — a sub-12 count couldn't discriminate.
      expect(chain).toHaveLength(12);
    });

    it('respects a large config cap', () => {
      const cfg = makeConfig({
        providers: {
          p1: { type: 'openai', apiKey: 'sk-1', models: Array.from({ length: 20 }, (_, i) => `m${i}`) },
        },
        fallbackMaxLastResortCandidates: 50,
      });
      const mgr = new FallbackProfileManager(cfg);
      const chain = mgr.resolveAllConfigured({ providerId: 'p1', model: 'm0' });
      // 20 models minus excluded primary = 19, cap at 50 → all 19 included
      expect(chain).toHaveLength(19);
    });

    it('disables the last-resort append when cap is 0', () => {
      const cfg = makeConfig({
        providers: {
          p1: { type: 'openai', apiKey: 'sk-1', models: ['m0', 'm1', 'm2'] },
        },
        fallbackMaxLastResortCandidates: 0,
      });
      const mgr = new FallbackProfileManager(cfg);
      const chain = mgr.resolveAllConfigured({ providerId: 'p1', model: 'm0' });
      expect(chain).toHaveLength(0);
    });
  });

  describe('resolveCandidates cap through full chain', () => {
    it('cap=2 appends exactly 2 new entries past the smart default', () => {
      // 9 providers, each with one model. Smart default picks 4 (p2-p5).
      // resolveAllConfigured should append p6 and p7 (cap=2), skipping p8-p9.
      const cfg = makeConfig({
        provider: 'primary',
        model: 'model-a',
        providers: {
          primary: { type: 'openai', apiKey: 'k1', models: ['model-a'] },
          p2: { type: 'openai', apiKey: 'k2', models: ['model-b'] },
          p3: { type: 'openai', apiKey: 'k3', models: ['model-c'] },
          p4: { type: 'openai', apiKey: 'k4', models: ['model-d'] },
          p5: { type: 'openai', apiKey: 'k5', models: ['model-e'] },
          p6: { type: 'openai', apiKey: 'k6', models: ['model-f'] },
          p7: { type: 'openai', apiKey: 'k7', models: ['model-g'] },
          p8: { type: 'openai', apiKey: 'k8', models: ['model-h'] },
          p9: { type: 'openai', apiKey: 'k9', models: ['model-i'] },
        },
        fallbackMaxLastResortCandidates: 2,
      });
      const mgr = new FallbackProfileManager(cfg);
      const chain = mgr.resolveCandidates(
        { providerId: 'primary', model: 'model-a' },
        { primary: { providerId: 'primary', model: 'model-a' } },
      );
      // Smart default prefix (4 cross-provider entries, alphabetically ordered)
      expect(chain.slice(0, 4).map((e) => e.providerId)).toEqual(['p2', 'p3', 'p4', 'p5']);
      // 4 smart default + 2 last-resort = 6
      expect(chain).toHaveLength(6);
      expect(chain[4]?.providerId).toBe('p6');
      expect(chain[5]?.providerId).toBe('p7');
    });
  });
});
