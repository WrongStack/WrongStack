import { describe, expect, it } from 'vitest';
import { emptyEngineState } from '../src/engine-state';
import {
  buildProviderSave,
  type ProviderDraft,
  providerChoices,
  providerModels,
} from '../src/provider-settings-model';

const draft: ProviderDraft = {
  mode: 'custom',
  id: 'local-engine',
  apiKey: '',
  label: 'desktop',
  baseUrl: 'http://127.0.0.1:9999/v1',
  model: 'local-model',
  supportsTools: false,
};
describe('native provider setup', () => {
  it('marks a provider the engine serves itself, which has nothing saved to remove', () => {
    const state = {
      ...emptyEngineState,
      results: {
        'providers.saved': {
          providers: [
            { id: 'acp', type: 'acp', models: ['claude-code'], hostServed: true, apiKeys: [] },
            { id: 'openai', type: 'openai', models: [], apiKeys: [] },
          ],
        },
      },
    };
    const [acp, openai] = providerChoices(state);
    expect(acp).toMatchObject({ id: 'acp', saved: true, hostServed: true });
    expect(openai?.hostServed).toBeUndefined();
  });
  it('persists explicit image-input capability without assuming support for an unknown endpoint', () => {
    for (const vision of [true, false]) {
      expect(
        buildProviderSave({ ...draft, supportsVision: vision }).payload['customModels'],
      ).toMatchObject({
        'local-model': { capabilities: { vision } },
      });
    }
  });
  it('creates a keyless local provider and only declares user-selected tool support', () => {
    const command = buildProviderSave(draft);
    expect(command.type).toBe('provider.add');
    expect(command.payload).toMatchObject({
      type: 'openai-compatible',
      family: 'openai-compatible',
      baseUrl: draft.baseUrl,
    });
    expect(command.payload).not.toHaveProperty('apiKey');
    expect(command.payload['models']).toEqual(['local-model']);
    expect(command.payload['customModels']).toEqual({
      'local-model': { name: 'local-model', capabilities: { streaming: true, tools: false } },
    });
  });
  it('uses the existing vault-backed key operation for preset providers', () => {
    expect(
      buildProviderSave({ ...draft, mode: 'preset', id: 'openai', apiKey: ' fixture-secret ' }),
    ).toEqual({
      type: 'key.add',
      payload: { providerId: 'openai', label: 'desktop', apiKey: 'fixture-secret' },
    });
  });
  it.each([
    { id: '__proto__' },
    { baseUrl: 'file:///secret' },
    { baseUrl: 'https://user:secret@example.com/v1' },
    { baseUrl: 'https://example.com/v1?api_key=secret' },
    { model: '' },
  ])('rejects unsafe or incomplete custom setup %j', (patch) => {
    expect(() => buildProviderSave({ ...draft, ...patch })).toThrow();
  });
  it('uses masked saved keys and never shows models from the previously selected provider', () => {
    const state = {
      ...emptyEngineState,
      results: {
        'provider.catalog': { providers: [{ id: 'openai', name: 'OpenAI', family: 'openai' }] },
        'providers.saved': {
          providers: [
            { id: 'openai', apiKeys: [{ label: 'desktop', maskedKey: '••••', isActive: true }] },
          ],
        },
        'provider.models': { provider: 'other', models: [{ id: 'wrong-model' }] },
      },
    };
    expect(providerChoices(state)[0]).toMatchObject({
      id: 'openai',
      saved: true,
      keys: [{ label: 'desktop', maskedKey: '••••', active: true }],
    });
    expect(providerModels(state, 'openai')).toEqual([]);
  });
});

it('words a refused connection through the given words', () => {
  const words = {
    id: 'bad id',
    keyAndLabel: 'key and label',
    url: 'bad url',
    credentials: 'credentials',
    model: 'no model',
  };
  expect(() => buildProviderSave({ ...draft, model: ' ' }, words)).toThrow('no model');
  expect(() => buildProviderSave({ ...draft, baseUrl: 'nope' }, words)).toThrow('bad url');
});
