/**
 * Unit tests for packages/webui/src/lib/fallback-ref.ts — the WebUI side of
 * the ref checks that mirror `refInvalidReason` / `refStaleModelListWarning`
 * in `packages/cli/src/slash-commands/fallback-ref-validation.ts`.
 *
 * Cross-surface contract:
 *  - A ref parses to `{ providerId, model }` via `splitProviderModel`.
 *  - `refInactiveReason` returns a reason only when the runtime cannot use
 *    the ref at all (no model). A model missing from the saved list, or a
 *    bare model, is still tried, so `refAdvisory` notes it instead.
 *  - `classifyRef` wraps the same logic and returns a `RefActiveState`.
 *  - `buildKnownModelSet` flattens `ModelCandidate[]` into the keyed set
 *    the inactive check consumes.
 *
 * Edge cases (empty set, provider-less refs, leading-slash refs) are
 * pinned here so any future refactor cannot silently regress parity.
 */
import { describe, expect, it } from 'vitest';
import {
  buildKnownModelSet,
  classifyRef,
  refAdvisory,
  refInactiveReason,
  splitProviderModel,
} from '../../src/lib/fallback-ref';

describe('splitProviderModel', () => {
  it('splits a standard `provider/model` ref', () => {
    expect(splitProviderModel('anthropic/claude-opus-4')).toEqual({
      providerId: 'anthropic',
      model: 'claude-opus-4',
    });
  });

  it('returns empty provider for a leading-slash ref', () => {
    expect(splitProviderModel('/gpt-4o-mini')).toEqual({
      providerId: '',
      model: 'gpt-4o-mini',
    });
  });

  it('returns empty provider for a bare model name', () => {
    expect(splitProviderModel('claude-sonnet-4')).toEqual({
      providerId: '',
      model: 'claude-sonnet-4',
    });
  });

  it('returns empty model for an empty or whitespace-only ref', () => {
    expect(splitProviderModel('')).toEqual({ providerId: '', model: '' });
    expect(splitProviderModel('   ')).toEqual({ providerId: '', model: '' });
  });

  it('trims leading/trailing whitespace at the outer level and trims both sides', () => {
    // `splitProviderModel` trims the whole ref, then each side of the slash.
    expect(splitProviderModel('  openai /  gpt-4o  ')).toEqual({
      providerId: 'openai',
      model: 'gpt-4o',
    });
  });

  it('trims the provider segment like canonical parseModelRef', () => {
    // A stray space between the provider name and the slash is dropped, as
    // `parseModelRef` in `@wrongstack/core` does, so the ref matches the known
    // `(provider, model)` pair instead of reading as an unknown provider.
    const { providerId, model } = splitProviderModel('openai /gpt-4o');
    expect(providerId).toBe('openai');
    expect(model).toBe('gpt-4o');
    expect(refAdvisory('openai /gpt-4o', new Set(['openai/gpt-4o']))).toBeUndefined();
  });
});

describe('refInactiveReason', () => {
  const knownModels = new Set(['openai/gpt-4o', 'openai/gpt-4o-mini', 'anthropic/claude-opus-4']);

  it('returns undefined for any ref that names a model — the runtime tries it', () => {
    expect(refInactiveReason('anthropic/claude-opus-4', knownModels)).toBeUndefined();
    expect(refInactiveReason('anthropic/claude-99-not-real', knownModels)).toBeUndefined();
    expect(refInactiveReason('ghost/some-model', knownModels)).toBeUndefined();
    expect(refInactiveReason('claude-opus-4', knownModels)).toBeUndefined();
    expect(refInactiveReason('anthropic/claude-99', undefined)).toBeUndefined();
  });

  it('reports an empty-model ref as inactive (no model in reference)', () => {
    expect(refInactiveReason('', knownModels)).toBe('"" has no model');
    expect(refInactiveReason('   ', knownModels)).toBe('"   " has no model');
  });
});

describe('refAdvisory', () => {
  const knownModels = new Set(['openai/gpt-4o', 'openai/gpt-4o-mini', 'anthropic/claude-opus-4']);

  it('says nothing for a ref whose (provider, model) is in the known set', () => {
    expect(refAdvisory('anthropic/claude-opus-4', knownModels)).toBeUndefined();
  });

  it('notes a model missing from the saved list, as the CLI does', () => {
    expect(refAdvisory('anthropic/claude-99-not-real', knownModels)).toBe(
      'not in anthropic saved model list — will still be tried',
    );
    expect(refAdvisory('ghost/some-model', knownModels)).toBe(
      'not in ghost saved model list — will still be tried',
    );
  });

  it('notes a bare / leading-slash ref resolves through the active provider', () => {
    expect(refAdvisory('/gpt-4o-mini', knownModels)).toBe(
      'no provider in reference — uses the active provider',
    );
    expect(refAdvisory('claude-opus-4', knownModels)).toBe(
      'no provider in reference — uses the active provider',
    );
  });

  it('says nothing while the known set is unknown or empty', () => {
    expect(refAdvisory('anthropic/claude-99', undefined)).toBeUndefined();
    expect(refAdvisory('anthropic/claude-99', new Set())).toBeUndefined();
  });
});

describe('classifyRef', () => {
  const knownModels = new Set(['openai/gpt-4o']);

  it('returns active when the ref is in the known set', () => {
    expect(classifyRef('openai/gpt-4o', knownModels)).toEqual({ active: true });
  });

  it('keeps an unlisted model active with an advisory', () => {
    expect(classifyRef('openai/gpt-99', knownModels)).toEqual({
      active: true,
      advisory: 'not in openai saved model list — will still be tried',
    });
  });

  it('returns inactive only for a ref with no model', () => {
    expect(classifyRef('', knownModels)).toEqual({ active: false, reason: '"" has no model' });
  });

  it('returns active while the known set is still loading', () => {
    expect(classifyRef('openai/gpt-99', undefined)).toEqual({ active: true });
  });
});

describe('buildKnownModelSet', () => {
  it('flattens an array of ModelCandidate-shaped objects into provider/model keys', () => {
    const set = buildKnownModelSet([
      { provider: 'openai', model: 'gpt-4o', label: 'GPT-4o' },
      { provider: 'anthropic', model: 'claude-opus-4', label: 'Opus' },
      { provider: 'openai', model: 'gpt-4o-mini', label: 'mini' },
    ]);
    expect(set.size).toBe(3);
    expect(set.has('openai/gpt-4o')).toBe(true);
    expect(set.has('anthropic/claude-opus-4')).toBe(true);
    expect(set.has('openai/gpt-4o-mini')).toBe(true);
  });

  it('skips entries with empty provider or model', () => {
    const set = buildKnownModelSet([
      { provider: '', model: 'orphan', label: 'orphan' },
      { provider: 'openai', model: '', label: 'empty model' },
      { provider: 'openai', model: 'gpt-4o', label: 'kept' },
    ]);
    expect(set.has('openai/gpt-4o')).toBe(true);
    expect(set.has('/orphan')).toBe(false);
    expect(set.has('openai/')).toBe(false);
  });

  it('returns an empty set when given no candidates', () => {
    expect(buildKnownModelSet([]).size).toBe(0);
  });
});
