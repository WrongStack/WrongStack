import type { Config } from '@wrongstack/contracts/types/config';
import { describe, expect, it } from 'vitest';
import { resolveConfiguredRefinerRef } from '../../src/execution/enhance-recovery.js';
import {
  resolveRefinerTargetSpec,
  resolveRefinerTargetSpecs,
} from '../../src/execution/refiner-target.js';

function cfg(over: Partial<Config> = {}): Config {
  return {
    provider: 'openai',
    model: 'gpt-5',
    providers: {},
    ...over,
  } as Config;
}

describe('resolveRefinerTargetSpec', () => {
  it('prefers the named refiner fallback profile over explicit provider/model', () => {
    const spec = resolveRefinerTargetSpec(
      cfg({
        autonomy: {
          refinerProvider: 'openai',
          refinerModel: 'gpt-4o-mini',
          refinerFallbackProfile: 'cheap',
        },
        fallbackProfiles: { cheap: ['anthropic/claude-haiku-4-5'] },
      }),
    );
    expect(spec).toEqual({
      providerId: 'anthropic',
      model: 'claude-haiku-4-5',
      source: 'fallback_profile',
    });
  });

  it('uses the first profile entry with a parseable model and skips the rest', () => {
    const spec = resolveRefinerTargetSpec(
      cfg({
        autonomy: { refinerFallbackProfile: 'chain' },
        fallbackProfiles: { chain: ['', 'broken/', 'deepseek/deepseek-chat'] },
      }),
    );
    expect(spec).toMatchObject({ providerId: 'deepseek', model: 'deepseek-chat' });
  });

  it('resolves a bare profile entry with an undefined providerId (caller defaults the provider)', () => {
    const spec = resolveRefinerTargetSpec(
      cfg({
        autonomy: { refinerFallbackProfile: 'p' },
        fallbackProfiles: { p: ['claude-haiku'] },
      }),
    );
    expect(spec).toEqual({
      providerId: undefined,
      model: 'claude-haiku',
      source: 'fallback_profile',
    });
  });

  it('parses the space form of a profile entry (provider + model)', () => {
    const spec = resolveRefinerTargetSpec(
      cfg({
        autonomy: { refinerFallbackProfile: 'p' },
        fallbackProfiles: { p: ['openai gpt-4o'] },
      }),
    );
    expect(spec).toEqual({ providerId: 'openai', model: 'gpt-4o', source: 'fallback_profile' });
  });

  it('falls through to the explicit refiner when the named profile is missing or empty', () => {
    const cases: Array<Config['fallbackProfiles'] | undefined> = [
      undefined,
      { ghost: ['anthropic/claude-haiku-4-5'] },
      { cheap: [] },
    ];
    for (const fallbackProfiles of cases) {
      const spec = resolveRefinerTargetSpec(
        cfg({
          autonomy: {
            refinerProvider: 'deepseek',
            refinerModel: 'deepseek-chat',
            refinerFallbackProfile: 'cheap',
          },
          ...(fallbackProfiles ? { fallbackProfiles } : {}),
        }),
      );
      expect(spec).toMatchObject({
        providerId: 'deepseek',
        model: 'deepseek-chat',
        source: 'explicit',
      });
    }
  });

  it('resolves the explicit provider/model pair', () => {
    expect(
      resolveRefinerTargetSpec(
        cfg({ autonomy: { refinerProvider: 'deepseek', refinerModel: 'deepseek-chat' } }),
      ),
    ).toEqual({ providerId: 'deepseek', model: 'deepseek-chat', source: 'explicit' });
  });

  it('leaves providerId undefined when only refinerModel is configured', () => {
    expect(resolveRefinerTargetSpec(cfg({ autonomy: { refinerModel: 'gpt-4o-mini' } }))).toEqual({
      providerId: undefined,
      model: 'gpt-4o-mini',
      source: 'explicit',
    });
  });

  it('leaves model undefined when only refinerProvider is configured (caller defaults the model)', () => {
    expect(resolveRefinerTargetSpec(cfg({ autonomy: { refinerProvider: 'deepseek' } }))).toEqual({
      providerId: 'deepseek',
      model: undefined,
      source: 'explicit',
    });
  });

  it('trims surrounding whitespace on the explicit keys', () => {
    expect(
      resolveRefinerTargetSpec(
        cfg({
          autonomy: { refinerProvider: ' deepseek ', refinerModel: ' deepseek-chat ' },
        }),
      ),
    ).toMatchObject({ providerId: 'deepseek', model: 'deepseek-chat' });
  });

  it('returns undefined when nothing is configured', () => {
    expect(resolveRefinerTargetSpec(cfg())).toBeUndefined();
  });

  it('applies NO favoriteModels gate — a configured refiner resolves even when unfavourited', () => {
    // Regression for the goal-refiner divergence: the old mission-side
    // resolver silently ignored a refinerModel that was neither in
    // favoriteModels nor the active model.
    const spec = resolveRefinerTargetSpec(
      cfg({
        autonomy: { refinerModel: 'unknown-model-v42' },
        favoriteModels: ['gpt-4o-mini'],
      }),
    );
    expect(spec).toMatchObject({ model: 'unknown-model-v42', source: 'explicit' });
  });
});

describe('resolveRefinerTargetSpecs (ordered candidates)', () => {
  it('returns every valid profile entry in order, then the explicit pair last', () => {
    const specs = resolveRefinerTargetSpecs(
      cfg({
        autonomy: {
          refinerProvider: 'deepseek',
          refinerModel: 'deepseek-chat',
          refinerFallbackProfile: 'chain',
        },
        fallbackProfiles: { chain: ['openai/gpt-4o', 'broken/', '', 'anthropic/claude-haiku'] },
      }),
    );
    expect(specs).toEqual([
      { providerId: 'openai', model: 'gpt-4o', source: 'fallback_profile' },
      { providerId: 'anthropic', model: 'claude-haiku', source: 'fallback_profile' },
      { providerId: 'deepseek', model: 'deepseek-chat', source: 'explicit' },
    ]);
  });

  it('returns only the explicit candidate when no profile is set, and [] when nothing is configured', () => {
    expect(resolveRefinerTargetSpecs(cfg({ autonomy: { refinerModel: 'gpt-4o-mini' } }))).toEqual([
      { providerId: undefined, model: 'gpt-4o-mini', source: 'explicit' },
    ]);
    expect(resolveRefinerTargetSpecs(cfg())).toEqual([]);
  });

  it('aliases the first candidate to resolveRefinerTargetSpec', () => {
    const cfgWithProfile = cfg({
      autonomy: { refinerFallbackProfile: 'chain' },
      fallbackProfiles: { chain: ['openai/gpt-4o', 'anthropic/claude-haiku'] },
    });
    expect(resolveRefinerTargetSpec(cfgWithProfile)).toEqual(
      resolveRefinerTargetSpecs(cfgWithProfile)[0],
    );
  });
});

describe('resolveConfiguredRefinerRef (enhance consumer of the shared spec)', () => {
  it('renders the shared spec as a provider/model ref, defaulting the provider', () => {
    expect(resolveConfiguredRefinerRef(cfg({ autonomy: { refinerModel: 'gpt-4o-mini' } }))).toBe(
      'openai/gpt-4o-mini',
    );
    expect(
      resolveConfiguredRefinerRef(
        cfg({
          autonomy: { refinerFallbackProfile: 'cheap' },
          fallbackProfiles: { cheap: ['claude-haiku'] },
        }),
      ),
    ).toBe('openai/claude-haiku');
  });

  it('returns undefined for a provider-only explicit ref (enhance needs a model)', () => {
    expect(
      resolveConfiguredRefinerRef(cfg({ autonomy: { refinerProvider: 'deepseek' } })),
    ).toBeUndefined();
  });

  it('returns undefined when neither the spec nor the config names a provider', () => {
    expect(
      resolveConfiguredRefinerRef(
        cfg({ provider: undefined, autonomy: { refinerModel: 'm' } } as unknown as Partial<Config>),
      ),
    ).toBeUndefined();
  });
});
