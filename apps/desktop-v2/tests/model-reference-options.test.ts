import { describe, expect, it } from 'vitest';
import { pickerModel } from '../src/model-picker-details';
import {
  filterOptions,
  modelRef,
  modelRefPatch,
  modelReference,
  modelReferenceOptions,
  parseModelReference,
  providerDisplayName,
  providerOptions,
} from '../src/model-reference-options';

const catalog = [
  {
    provider: 'openai',
    model: pickerModel({
      id: 'gpt-x',
      name: 'GPT X',
      contextWindow: 200_000,
      capabilities: ['tools'],
    }),
  },
  { provider: 'openai', model: pickerModel({ id: 'o1', name: 'o1' }) },
  { provider: 'desktop-local', model: pickerModel({ id: 'vendor/model', name: 'Vendor Model' }) },
];
const names = { openai: 'OpenAI' };

describe('a model reference', () => {
  it('joins and splits at the first slash, so a namespaced model ID stays whole', () => {
    expect(modelReference('openai', 'gpt-x')).toBe('openai/gpt-x');
    expect(modelReference('', 'gpt-x')).toBe('gpt-x');
    expect(parseModelReference('  openrouter/anthropic/claude  ')).toEqual({
      provider: 'openrouter',
      model: 'anthropic/claude',
    });
    expect(parseModelReference('gpt-x')).toEqual({ provider: '', model: 'gpt-x' });
    expect(parseModelReference('')).toEqual({ provider: '', model: '' });
  });

  it('replaces only the reference of a route, tier or review entry', () => {
    const entry = { provider: 'a', model: 'b', fallbackProfile: 'nightly' };
    expect(modelRefPatch(entry, 'c/d')).toEqual({
      provider: 'c',
      model: 'd',
      fallbackProfile: 'nightly',
    });
    expect(modelRefPatch(entry, 'e')).toEqual({ model: 'e', fallbackProfile: 'nightly' });
    expect(modelRefPatch(entry, '')).toEqual({ fallbackProfile: 'nightly' });
    expect(modelRef(entry)).toBe('a/b');
    expect(modelRef({ model: 'bare' })).toBe('bare');
  });
});

describe('catalog choices', () => {
  it('name each saved model as its catalogs do, under its provider, with its known facts', () => {
    const options = modelReferenceOptions(catalog, names);
    expect(options.map((option) => option.value)).toEqual([
      'openai/gpt-x',
      'openai/o1',
      'desktop-local/vendor/model',
    ]);
    expect(options[0]).toMatchObject({
      label: 'GPT X',
      display: 'OpenAI · GPT X',
      group: 'OpenAI',
      hint: 'gpt-x · 200K context · tools',
    });
    // A model named by its ID does not repeat it; a provider without a name shows its ID.
    expect(options[1]?.hint).toBe('');
    expect(options[2]).toMatchObject({ group: 'desktop-local', hint: 'vendor/model' });
  });

  it('commit bare model IDs when one provider is held beside the field', () => {
    const scoped = modelReferenceOptions(catalog, names, undefined, { provider: 'openai' });
    expect(scoped.map((option) => option.value)).toEqual(['gpt-x', 'o1']);
    expect(scoped[0]?.label).toBe('GPT X');
  });

  it('never read a provider name from the prototype', () => {
    expect(providerDisplayName(names, 'toString')).toBe('toString');
    expect(providerDisplayName({ toString: 'Object' }, 'toString')).toBe('Object');
    expect(providerDisplayName(names, 'openai')).toBe('OpenAI');
    expect(
      providerOptions(['minimax-coding-plan', 'openai'], {
        'minimax-coding-plan': 'MiniMax Coding Plan',
      }),
    ).toEqual([
      { value: 'minimax-coding-plan', label: 'MiniMax Coding Plan', hint: 'minimax-coding-plan' },
      { value: 'openai', label: 'openai', hint: '' },
    ]);
  });

  it('narrow by every word of a query, across value, name, provider and facts', () => {
    const options = modelReferenceOptions(catalog, names);
    expect(filterOptions(options, '')).toHaveLength(3);
    expect(filterOptions(options, 'GPT').map((option) => option.value)).toEqual(['openai/gpt-x']);
    expect(filterOptions(options, 'openai o1').map((option) => option.value)).toEqual([
      'openai/o1',
    ]);
    expect(filterOptions(options, 'desktop-local vendor')).toHaveLength(1);
    expect(filterOptions(options, 'nothing-like-this')).toEqual([]);
  });
});
