import { describe, expect, it } from 'vitest';
import {
  buildPayload,
  type FormState,
} from '../../src/components/SettingsPanel/ModelSchemaEditor.js';

function form(overrides: Partial<FormState> = {}): FormState {
  return {
    id: 'custom/model',
    name: 'Custom Model',
    description: '',
    family: '',
    limitContext: '262144',
    limitOutput: '',
    limitInput: '',
    costInput: '2',
    costOutput: '',
    inputModalities: ['text'],
    outputModalities: ['text'],
    toolCall: false,
    reasoning: true,
    temperature: false,
    attachment: false,
    structuredOutput: false,
    openWeights: false,
    releaseDate: '',
    lastUpdated: '',
    knowledge: '',
    ...overrides,
  };
}

describe('ModelSchemaEditor buildPayload', () => {
  it('preserves passthrough and nested modelsDev fields while applying form edits', () => {
    const initial = {
      name: 'Old Name',
      status: 'preview',
      reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
      limit: { context: 131072, output: 4096, custom_limit: 7 },
      cost: { input: 1, output: 3, cache_read: 0.1, tiers: [{ threshold: 1 }] },
      modalities: { input: ['text'], output: ['text'], transport: 'stream' },
      tool_call: true,
      reasoning: true,
      temperature: true,
      attachment: true,
      structured_output: true,
      open_weights: true,
    };

    const payload = buildPayload(form(), initial);

    expect(payload).toMatchObject({
      name: 'Custom Model',
      status: 'preview',
      reasoning_options: initial.reasoning_options,
      limit: { context: 262144, output: 4096, custom_limit: 7 },
      cost: { input: 2, output: 3, cache_read: 0.1, tiers: [{ threshold: 1 }] },
      modalities: { input: ['text'], output: ['text'], transport: 'stream' },
      tool_call: false,
      reasoning: true,
      temperature: false,
      attachment: false,
      structured_output: false,
      open_weights: false,
    });
  });

  it('retains unchanged explicit false capability values', () => {
    const initial = {
      name: 'Custom Model',
      tool_call: false,
      reasoning: false,
      attachment: false,
    };

    expect(
      buildPayload(
        form({
          reasoning: false,
          limitContext: '',
          costInput: '',
          inputModalities: [],
          outputModalities: [],
        }),
        initial,
      ),
    ).toMatchObject({ tool_call: false, reasoning: false, attachment: false });
  });
});
