import { describe, expect, it } from 'vitest';
import { emptyEngineState, reduceEngine } from '../src/engine-state';
import { parseModelList } from '../src/ProviderConnectionWiring';
import { providerChoices } from '../src/provider-settings-model';

describe('saved connection models and endpoint', () => {
  it('parses a model list from lines or commas without blanks or repeats', () => {
    expect(parseModelList(' gpt-a, gpt-b\n\ngpt-a \n gpt-c ')).toEqual(['gpt-a', 'gpt-b', 'gpt-c']);
    expect(parseModelList(' \n , ')).toEqual([]);
  });

  it('reads the saved allowlist and endpoint, null when every catalog model is offered', () => {
    const state = reduceEngine(emptyEngineState, {
      type: 'providers.saved',
      payload: {
        providers: [
          { id: 'mine', family: 'openai', baseUrl: 'https://x.test/v1', models: ['a', 'b'] },
          { id: 'open', family: 'anthropic' },
        ],
      },
    });
    const saved = providerChoices(state);
    expect(saved.find((item) => item.id === 'mine')).toMatchObject({
      models: ['a', 'b'],
      baseUrl: 'https://x.test/v1',
    });
    expect(saved.find((item) => item.id === 'open')).toMatchObject({ models: null, baseUrl: '' });
  });
});
