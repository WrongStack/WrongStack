/**
 * Unit tests for packages/webui/src/lib/fallback-ref.ts — the WebUI side of
 * the inactive-warning helper that mirrors `refInactiveReason` in
 * `packages/cli/src/slash-commands/fallback.ts`.
 *
 * Cross-surface contract:
 *  - A ref parses to `{ providerId, model }` via `splitProviderModel`.
 *  - `refInactiveReason` returns `undefined` when the ref is active and a
 *    short reason string otherwise. The wording matches the slash command
 *    so the WebUI and CLI render consistent messages.
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

  it('trims leading/trailing whitespace at the outer level and trims the model side', () => {
    // `splitProviderModel` calls `ref.trim()` first, so leading and trailing
    // whitespace around the entire ref is dropped. The model side is then
    // `.trim()`-ed. The provider segment is whatever `trimmed.slice(0, slash)`
    // returns — a single interior space between the provider and the slash
    // is preserved (matches canonical `parseModelRef` behavior).
    expect(splitProviderModel('  openai /  gpt-4o  ')).toEqual({
      providerId: 'openai ',
      model: 'gpt-4o',
    });
  });

  it('preserves interior whitespace in the provider segment (matches canonical parseModelRef)', () => {
    // `splitProviderModel` does NOT trim the provider segment, so a stray
    // interior space between the provider name and the slash is preserved
    // (e.g. `'openai /gpt-4o'` → providerId `'openai '`). This matches
    // canonical `parseModelRef` in `@wrongstack/core/agent`, and the slash
    // command and the LLM tools share the same behavior. The unknown-provider
    // path in `refInactiveReason` is what surfaces such refs as inactive,
    // since they will not match any `(provider, model)` in the known set.
    const { providerId, model } = splitProviderModel('openai /gpt-4o');
    expect(providerId).toBe('openai ');
    expect(model).toBe('gpt-4o');
    expect(refInactiveReason(providerId + '/' + model, new Set(['openai/gpt-4o']))).toBe(
      '"gpt-4o" not in openai  model list',
    );
  });
});

describe('refInactiveReason', () => {
  const knownModels = new Set(['openai/gpt-4o', 'openai/gpt-4o-mini', 'anthropic/claude-opus-4']);

  it('returns undefined for a ref whose (provider, model) is in the known set', () => {
    expect(refInactiveReason('anthropic/claude-opus-4', knownModels)).toBeUndefined();
  });

  it('returns a "not in model list" reason for an unknown model on a known provider', () => {
    expect(refInactiveReason('anthropic/claude-99-not-real', knownModels)).toBe(
      '"claude-99-not-real" not in anthropic model list',
    );
  });

  it('returns a "not in model list" reason for an unknown provider', () => {
    expect(refInactiveReason('ghost/some-model', knownModels)).toBe(
      '"some-model" not in ghost model list',
    );
  });

  it('returns undefined when knownModels is undefined (still loading)', () => {
    expect(refInactiveReason('anthropic/claude-opus-4', undefined)).toBeUndefined();
    expect(refInactiveReason('anthropic/claude-99', undefined)).toBeUndefined();
  });

  it('returns undefined when knownModels is empty (no allow-list configured)', () => {
    expect(refInactiveReason('anthropic/claude-opus-4', new Set())).toBeUndefined();
  });

  it('reports an empty-model ref as inactive (no model in reference)', () => {
    expect(refInactiveReason('', knownModels)).toBe('"" has no model');
    expect(refInactiveReason('   ', knownModels)).toBe('"   " has no model');
  });

  it('reports a leading-slash / bare-model ref as inactive (no provider)', () => {
    expect(refInactiveReason('/gpt-4o-mini', knownModels)).toBe('no provider in reference');
    expect(refInactiveReason('claude-opus-4', knownModels)).toBe('no provider in reference');
  });
});

describe('classifyRef', () => {
  const knownModels = new Set(['openai/gpt-4o']);

  it('returns active when the ref is in the known set', () => {
    expect(classifyRef('openai/gpt-4o', knownModels)).toEqual({ active: true });
  });

  it('returns inactive with a reason when the ref is unknown', () => {
    expect(classifyRef('openai/gpt-99', knownModels)).toEqual({
      active: false,
      reason: '"gpt-99" not in openai model list',
    });
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
