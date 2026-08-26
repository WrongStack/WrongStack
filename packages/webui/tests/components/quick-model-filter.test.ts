import { describe, expect, it } from 'vitest';
import {
  buildModelCandidates,
  type CatalogModelLite,
  isModelInFavorites,
  type SavedProviderLite,
} from '../../src/components/QuickModelSwitcher.filter';

/**
 * Pure-logic tests for the Cmd+M quick-model-switcher filter.
 *
 * The actual user-reported bug ("filter doesn't work") lived in the
 * useEffect dependency list — putting the fresh-object `ws` from
 * useWebSocket() into the dep array made the effect re-run on every
 * render and call `setQuery('')` mid-keystroke. The fix (destructure
 * stable callbacks) lives in the component itself; what we test here is
 * the filter + sort logic the user actually sees in the dropdown.
 */

const saved: SavedProviderLite[] = [{ id: 'anthropic' }, { id: 'openai' }, { id: 'google' }];

const models: Record<string, CatalogModelLite[]> = {
  anthropic: [
    { id: 'claude-opus-4-7', name: 'Claude Opus 4.7', contextWindow: 200000 },
    {
      id: 'anthropic-test-model',
      name: 'Anthropic Test Model',
      description: 'Claude-compatible planner test model',
      contextWindow: 200000,
    },
  ],
  openai: [
    { id: 'gpt-5', name: 'GPT-5', contextWindow: 128000 },
    { id: 'o3', name: 'o3', contextWindow: 200000 },
  ],
  google: [{ id: 'gemini-2-5-pro', name: 'Gemini 2.5 Pro', contextWindow: 1000000 }],
};

describe('buildModelCandidates — flattening', () => {
  it('returns one candidate per (saved provider, catalog model) pair', () => {
    const out = buildModelCandidates(saved, models, '', undefined, undefined);
    expect(out).toHaveLength(5);
  });

  it('skips saved providers with no cached models', () => {
    const sparse = buildModelCandidates(
      [...saved, { id: 'mystery' }],
      models,
      '',
      undefined,
      undefined,
    );
    expect(sparse).toHaveLength(5); // 'mystery' has no models entry
  });

  it('returns empty list when no saved providers', () => {
    expect(buildModelCandidates([], models, '', undefined, undefined)).toEqual([]);
  });

  it('returns empty list when saved providers have no models', () => {
    const out = buildModelCandidates(saved, {}, '', undefined, undefined);
    expect(out).toEqual([]);
  });

  it('falls back to model id when name is missing', () => {
    const noNames: Record<string, CatalogModelLite[]> = {
      openai: [{ id: 'gpt-5' }],
    };
    const out = buildModelCandidates([{ id: 'openai' }], noNames, '', undefined, undefined);
    expect(out[0]?.modelName).toBe('gpt-5');
  });
});

describe('buildModelCandidates — filter (the user-reported bug surface)', () => {
  it('returns full list when query is empty', () => {
    const out = buildModelCandidates(saved, models, '', undefined, undefined);
    expect(out).toHaveLength(5);
  });

  it('returns full list when query is whitespace only', () => {
    const out = buildModelCandidates(saved, models, '   ', undefined, undefined);
    expect(out).toHaveLength(5);
  });

  it('filters case-insensitively on provider id', () => {
    const out = buildModelCandidates(saved, models, 'OPEN', undefined, undefined);
    // openai (2 models) matches; ANTHRopic (2 models) matches via substring.
    // google does not contain 'open'.
    expect(out).toHaveLength(2);
    expect(out.every((c) => c.provider === 'openai')).toBe(true);
  });

  it('filters case-insensitively on model id', () => {
    const out = buildModelCandidates(saved, models, 'gemini', undefined, undefined);
    expect(out).toHaveLength(1);
    expect(out[0]?.model).toBe('gemini-2-5-pro');
  });

  it('filters case-insensitively on model description', () => {
    const out = buildModelCandidates(saved, models, 'planner', undefined, undefined);
    expect(out).toHaveLength(1);
    expect(out[0]?.modelName).toBe('Anthropic Test Model');
  });

  it('trims surrounding whitespace from the query', () => {
    const out = buildModelCandidates(saved, models, '  gpt  ', undefined, undefined);
    expect(out).toHaveLength(1);
    expect(out[0]?.model).toBe('gpt-5');
  });

  it('matches substring anywhere in the field', () => {
    // '2-5' should match 'gemini-2-5-pro' and 'claude-opus-4-7' (false — the latter has no '2-5')
    const out = buildModelCandidates(saved, models, '2-5', undefined, undefined);
    expect(out).toHaveLength(1);
    expect(out[0]?.provider).toBe('google');
  });

  it('returns empty list when nothing matches', () => {
    const out = buildModelCandidates(saved, models, 'nonexistent-model-xyz', undefined, undefined);
    expect(out).toEqual([]);
  });
});

describe('buildModelCandidates — current-model flag + sort', () => {
  it('flags the active model with isCurrent=true', () => {
    const out = buildModelCandidates(saved, models, '', 'openai', 'gpt-5');
    const current = out.find((c) => c.isCurrent);
    expect(current).toBeDefined();
    expect(current?.provider).toBe('openai');
    expect(current?.model).toBe('gpt-5');
  });

  it('places the active model at the top', () => {
    const out = buildModelCandidates(saved, models, '', 'google', 'gemini-2-5-pro');
    expect(out[0]?.isCurrent).toBe(true);
    expect(out[0]?.model).toBe('gemini-2-5-pro');
  });

  it('sorts non-current candidates by provider then model', () => {
    const out = buildModelCandidates(saved, models, '', undefined, undefined);
    // Drop the current row (none in this case) and verify order
    const sorted = [...out].sort((a, b) => {
      if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
      return a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model);
    });
    expect(out.map((c) => `${c.provider}/${c.model}`)).toEqual(
      sorted.map((c) => `${c.provider}/${c.model}`),
    );
    // And the first few should be alphabetical by provider.
    expect(out[0]?.provider).toBe('anthropic');
    expect(out[2]?.provider).toBe('google');
    expect(out[3]?.provider).toBe('openai');
  });

  it('combines filter + active-flag sort', () => {
    // Active is anthropic/claude-opus-4-7; filter to 'claude' should
    // bring both claude models back, with the active one first.
    const out = buildModelCandidates(saved, models, 'claude', 'anthropic', 'claude-opus-4-7');
    expect(out).toHaveLength(2);
    expect(out[0]?.isCurrent).toBe(true);
    expect(out[0]?.model).toBe('claude-opus-4-7');
    expect(out[1]?.isCurrent).toBe(false);
    expect(out[1]?.model).toBe('anthropic-test-model');
  });
});

describe('buildModelCandidates — provider filter', () => {
  it('returns all candidates when providerFilter is null', () => {
    const out = buildModelCandidates(saved, models, '', undefined, undefined, null);
    expect(out).toHaveLength(5);
  });

  it('returns all candidates when providerFilter is undefined', () => {
    const out = buildModelCandidates(saved, models, '', undefined, undefined);
    expect(out).toHaveLength(5);
  });

  it('filters to only the selected provider', () => {
    const out = buildModelCandidates(saved, models, '', undefined, undefined, 'openai');
    expect(out).toHaveLength(2);
    expect(out.every((c) => c.provider === 'openai')).toBe(true);
  });

  it('returns empty when the selected provider has no loaded models', () => {
    const out = buildModelCandidates(
      [...saved, { id: 'mystery' }],
      models,
      '',
      undefined,
      undefined,
      'mystery',
    );
    expect(out).toEqual([]);
  });

  it('returns empty when providerFilter does not match any saved provider', () => {
    const out = buildModelCandidates(saved, models, '', undefined, undefined, 'azure');
    expect(out).toEqual([]);
  });

  it('combines with search filter (AND semantics)', () => {
    // openai has gpt-5 and o3; filter to openai + search 'gpt'
    const out = buildModelCandidates(saved, models, 'gpt', undefined, undefined, 'openai');
    expect(out).toHaveLength(1);
    expect(out[0]?.model).toBe('gpt-5');
  });

  it('combines provider filter + active-flag sort', () => {
    const out = buildModelCandidates(saved, models, '', 'openai', 'o3', 'openai');
    expect(out).toHaveLength(2);
    expect(out[0]?.isCurrent).toBe(true);
    expect(out[0]?.model).toBe('o3');
    expect(out[1]?.model).toBe('gpt-5');
  });

  it('search on provider id still works with a different provider filter set', () => {
    // When providerFilter is 'openai', searching 'anthropic' matches nothing
    const out = buildModelCandidates(saved, models, 'anthropic', undefined, undefined, 'openai');
    expect(out).toEqual([]);
  });
});

describe('isModelInFavorites — matching logic', () => {
  it('returns false when favoriteModels is undefined, null, or empty', () => {
    expect(isModelInFavorites('openai', 'gpt-5', undefined)).toBe(false);
    expect(isModelInFavorites('openai', 'gpt-5', null)).toBe(false);
    expect(isModelInFavorites('openai', 'gpt-5', [])).toBe(false);
  });

  it('matches qualified "provider/model" exactly', () => {
    expect(isModelInFavorites('openai', 'gpt-5', ['openai/gpt-5'])).toBe(true);
    expect(isModelInFavorites('anthropic', 'gpt-5', ['openai/gpt-5'])).toBe(false);
  });

  it('matches bare "model" against any provider', () => {
    expect(isModelInFavorites('openai', 'gpt-5', ['gpt-5'])).toBe(true);
    expect(isModelInFavorites('azure', 'gpt-5', ['gpt-5'])).toBe(true);
    expect(isModelInFavorites('openai', 'o3', ['gpt-5'])).toBe(false);
  });

  it('matches case-insensitively and handles whitespace', () => {
    expect(isModelInFavorites('OpenAI', 'GPT-5', [' openai/gpt-5 '])).toBe(true);
    expect(isModelInFavorites('openai', 'gpt-5', [' OPENAI / GPT-5 '])).toBe(true);
    expect(isModelInFavorites('google', 'gemini-2-5-pro', ['google gemini-2-5-pro'])).toBe(true);
  });
});

describe('buildModelCandidates — favoritesOnly filter & isFavorite flag', () => {
  const favorites = ['openai/gpt-5', 'claude-opus-4-7'];

  it('sets isFavorite=true on matching candidates and isFavorite=false on others', () => {
    const out = buildModelCandidates(
      saved,
      models,
      '',
      undefined,
      undefined,
      null,
      false,
      favorites,
    );
    expect(out).toHaveLength(5);
    const gpt5 = out.find((c) => c.provider === 'openai' && c.model === 'gpt-5');
    const opus = out.find((c) => c.provider === 'anthropic' && c.model === 'claude-opus-4-7');
    const gemini = out.find((c) => c.provider === 'google' && c.model === 'gemini-2-5-pro');

    expect(gpt5?.isFavorite).toBe(true);
    expect(opus?.isFavorite).toBe(true);
    expect(gemini?.isFavorite).toBe(false);
  });

  it('filters candidates to only favorites when favoritesOnly is true', () => {
    const out = buildModelCandidates(
      saved,
      models,
      '',
      undefined,
      undefined,
      null,
      true,
      favorites,
    );
    expect(out).toHaveLength(2);
    expect(out.map((c) => `${c.provider}/${c.model}`)).toEqual([
      'anthropic/claude-opus-4-7',
      'openai/gpt-5',
    ]);
    expect(out.every((c) => c.isFavorite)).toBe(true);
  });

  it('returns empty list when favoritesOnly is true but no favorites configured', () => {
    const out = buildModelCandidates(saved, models, '', undefined, undefined, null, true, []);
    expect(out).toEqual([]);
  });

  it('combines favoritesOnly + providerFilter + search query (AND semantics)', () => {
    const out = buildModelCandidates(
      saved,
      models,
      'gpt',
      undefined,
      undefined,
      'openai',
      true,
      favorites,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.provider).toBe('openai');
    expect(out[0]?.model).toBe('gpt-5');
    expect(out[0]?.isFavorite).toBe(true);
  });

  it('combines favoritesOnly + active model sorting', () => {
    const out = buildModelCandidates(saved, models, '', 'openai', 'gpt-5', null, true, favorites);
    expect(out).toHaveLength(2);
    expect(out[0]?.isCurrent).toBe(true);
    expect(out[0]?.model).toBe('gpt-5');
    expect(out[1]?.model).toBe('claude-opus-4-7');
  });
});
