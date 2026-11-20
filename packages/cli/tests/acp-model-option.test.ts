import { describe, expect, it, vi } from 'vitest';
import {
  acpModelValue,
  buildAcpEffortOption,
  buildAcpModelOption,
  parseAcpModelValue,
  selectedAcpEffort,
  selectedAcpModel,
} from '../src/acp-model-option.js';

type Providers = Awaited<
  ReturnType<NonNullable<Parameters<typeof buildAcpModelOption>[0]['loadProviders']>>
>;

function build(config: Record<string, unknown>, providers: Providers) {
  return buildAcpModelOption({
    config: config as never,
    modelsRegistry: {} as never,
    loadProviders: vi.fn(async () => providers),
  });
}

describe('ACP model option', () => {
  it('offers the /model providers grouped, running provider first, as a model-category select', async () => {
    const option = await build({ provider: 'openai', model: 'gpt-x' }, [
      { id: 'anthropic', family: 'anthropic', models: ['claude-a'] },
      {
        id: 'openai',
        family: 'openai',
        models: ['gpt-x', 'gpt-y'],
        modelDetails: { 'gpt-y': { name: 'GPT Y' } },
      },
    ] as Providers);
    expect(option).toMatchObject({
      id: 'model',
      category: 'model',
      type: 'select',
      currentValue: 'openai/gpt-x',
    });
    expect(option?.options).toEqual([
      {
        group: 'openai',
        name: 'openai',
        options: [
          { value: 'openai/gpt-x', name: 'gpt-x' },
          { value: 'openai/gpt-y', name: 'GPT Y (gpt-y)' },
        ],
      },
      {
        group: 'anthropic',
        name: 'anthropic',
        options: [{ value: 'anthropic/claude-a', name: 'claude-a' }],
      },
    ]);
  });

  it('leaves out switched-off providers and models, but never the running model', async () => {
    const option = await build(
      {
        provider: 'openai',
        model: 'gpt-x',
        disabledProviders: ['Anthropic'],
        disabledModels: ['openai/gpt-y', 'gpt-x'],
      },
      [
        { id: 'anthropic', family: 'anthropic', models: ['claude-a'] },
        { id: 'openai', family: 'openai', models: ['gpt-x', 'gpt-y', 'gpt-z'] },
      ] as Providers,
    );
    const values = (
      (option?.options ?? []) as Array<{ options: Array<{ value: string }> }>
    ).flatMap((g) => g.options.map((o) => o.value));
    expect(values).toEqual(['openai/gpt-x', 'openai/gpt-z']);
  });

  it('still offers the running model when the catalog does not list it', async () => {
    const option = await build({ provider: 'custom', model: 'local-1' }, [
      { id: 'openai', family: 'openai', models: ['gpt-x'] },
    ] as Providers);
    expect(option?.options[0]).toEqual({
      group: 'custom',
      name: 'custom',
      options: [{ value: 'custom/local-1', name: 'local-1' }],
    });
  });

  it('is absent without a configured provider', async () => {
    expect(await build({}, [])).toBeUndefined();
  });

  it('round-trips model ids that contain slashes', () => {
    const value = acpModelValue('openrouter', 'anthropic/claude-x');
    expect(parseAcpModelValue(value)).toEqual({
      providerId: 'openrouter',
      modelId: 'anthropic/claude-x',
    });
    expect(parseAcpModelValue('no-provider')).toBeNull();
  });

  it('reads the selection only from the model-category option', () => {
    const base = { name: 'x', type: 'select', options: [] };
    expect(
      selectedAcpModel([
        { ...base, id: 'size', currentValue: 'a/b' },
        { ...base, id: 'model', category: 'model', currentValue: 'openai/gpt-y' },
      ]),
    ).toEqual({ providerId: 'openai', modelId: 'gpt-y' });
    expect(selectedAcpModel([{ ...base, id: 'model', currentValue: 'openai/gpt-y' }])).toBeNull();
  });

  it('builds a thought_level option for reasoning models and omits it for non-reasoning models', async () => {
    const modelsRegistry = {
      getModel: vi.fn(async (_provider: string, modelId: string) => {
        if (modelId === 'o3') {
          return {
            capabilities: {
              reasoning: true,
              reasoningConfig: { effortSupported: true, effortLevels: ['low', 'medium', 'high'] },
            },
          };
        }
        if (modelId === 'gpt-4o') {
          return { capabilities: { reasoning: false } };
        }
        return undefined;
      }),
    } as never;

    const reasoningOpt = await buildAcpEffortOption({
      config: {
        provider: 'openai',
        model: 'o3',
        modelRuntime: { reasoning: { effort: 'high' } },
      } as never,
      modelsRegistry,
    });
    expect(reasoningOpt).toEqual({
      id: 'thought_level',
      name: 'Reasoning Effort',
      description: 'Reasoning effort level for the selected model.',
      category: 'thought_level',
      type: 'select',
      currentValue: 'high',
      options: [
        { value: 'default', name: 'Default' },
        { value: 'low', name: 'Low' },
        { value: 'medium', name: 'Medium' },
        { value: 'high', name: 'High' },
      ],
    });

    const nonReasoning = await buildAcpEffortOption({
      config: { provider: 'openai', model: 'gpt-4o' } as never,
      modelsRegistry,
    });
    expect(nonReasoning).toBeUndefined();
  });

  it('reads thought_level selection and maps default to undefined', () => {
    const base = { name: 'Effort', type: 'select', category: 'thought_level', options: [] };
    expect(selectedAcpEffort([{ ...base, id: 'thought_level', currentValue: 'high' }])).toBe(
      'high',
    );
    expect(
      selectedAcpEffort([{ ...base, id: 'thought_level', currentValue: 'default' }]),
    ).toBeUndefined();
    expect(selectedAcpEffort([])).toBeUndefined();
  });
});
