import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { ModelPicker, type ProviderOption } from '../src/components/model-picker.js';

const providers: ProviderOption[] = [
  { id: 'anthropic', family: 'claude', models: ['claude-3-5-sonnet', 'claude-3-opus'] },
  { id: 'openai', family: 'gpt', models: ['gpt-4o', 'gpt-4o-mini'] },
];

describe('ModelPicker - step provider', () => {
  it('renders step 1 title', () => {
    const view = render(
      React.createElement(ModelPicker, {
        step: 'provider',
        providerOptions: providers,
        modelOptions: [],
        filteredOptions: [],
        selected: 0,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('Step 1/2');
    expect(frame).toContain('Pick provider');
    view.unmount();
  });

  it('renders all provider options', () => {
    const view = render(
      React.createElement(ModelPicker, {
        step: 'provider',
        providerOptions: providers,
        modelOptions: [],
        filteredOptions: [],
        selected: 0,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('anthropic');
    expect(frame).toContain('openai');
    expect(frame).toContain('[claude]');
    expect(frame).toContain('[gpt]');
    expect(frame).toContain('2 models');
    view.unmount();
  });

  it('shows empty provider message when none available', () => {
    const view = render(
      React.createElement(ModelPicker, {
        step: 'provider',
        providerOptions: [],
        modelOptions: [],
        filteredOptions: [],
        selected: 0,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('no providers with keys');
    view.unmount();
  });

  it('renders hint when provided', () => {
    const view = render(
      React.createElement(ModelPicker, {
        step: 'provider',
        providerOptions: providers,
        modelOptions: [],
        filteredOptions: [],
        selected: 0,
        hint: 'No API key configured',
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('No API key configured');
    view.unmount();
  });

  it('renders custom title label', () => {
    const view = render(
      React.createElement(ModelPicker, {
        step: 'provider',
        providerOptions: providers,
        modelOptions: [],
        filteredOptions: [],
        selected: 0,
        titleLabel: 'Add council voter',
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('Add council voter');
    view.unmount();
  });

  it('highlights selected provider', () => {
    const view = render(
      React.createElement(ModelPicker, {
        step: 'provider',
        providerOptions: providers,
        modelOptions: [],
        filteredOptions: [],
        selected: 0,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('›');
    view.unmount();
  });
});

describe('ModelPicker - step model', () => {
  const models = ['claude-3-5-sonnet', 'claude-3-opus', 'claude-3-haiku'];

  it('renders capability, context, and pricing details on wide terminals', () => {
    const detailed: ProviderOption[] = [
      {
        id: 'anthropic',
        family: 'claude',
        models: ['claude-3-5-sonnet'],
        modelDetails: {
          'claude-3-5-sonnet': {
            tools: true,
            vision: true,
            reasoning: true,
            maxContext: 200_000,
            maxOutput: 8_192,
            inputCost: 3,
            outputCost: 15,
            cacheReadCost: 0.3,
            knowledge: '2025-01',
          },
        },
      },
    ];
    const view = render(
      React.createElement(ModelPicker, {
        step: 'model',
        providerOptions: detailed,
        modelOptions: detailed[0]?.models ?? [],
        filteredOptions: detailed[0]?.models ?? [],
        selected: 0,
        pickedProviderId: 'anthropic',
        columns: 110,
        maxRows: 16,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('context/output: 200K / 8K');
    expect(frame).toContain('tools, vision, reasoning');
    expect(frame).toContain('$3 / $15 / $0.3');
    expect(frame).toContain('knowledge: 2025-01');
    view.unmount();
  });

  it('renders step 2 title with provider ID', () => {
    const view = render(
      React.createElement(ModelPicker, {
        step: 'model',
        providerOptions: providers,
        modelOptions: models,
        filteredOptions: models,
        selected: 0,
        pickedProviderId: 'anthropic',
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('Step 2/2');
    expect(frame).toContain('Pick model');
    expect(frame).toContain('anthropic');
    view.unmount();
  });

  it('renders all model options', () => {
    const view = render(
      React.createElement(ModelPicker, {
        step: 'model',
        providerOptions: providers,
        modelOptions: models,
        filteredOptions: models,
        selected: 0,
        pickedProviderId: 'anthropic',
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('claude-3-5-sonnet');
    expect(frame).toContain('claude-3-opus');
    expect(frame).toContain('claude-3-haiku');
    view.unmount();
  });

  it('shows empty message when no models for provider', () => {
    const view = render(
      React.createElement(ModelPicker, {
        step: 'model',
        providerOptions: providers,
        modelOptions: [],
        filteredOptions: [],
        selected: 0,
        pickedProviderId: 'anthropic',
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('no models known');
    view.unmount();
  });

  it('shows search query hint when filtering', () => {
    const view = render(
      React.createElement(ModelPicker, {
        step: 'model',
        providerOptions: providers,
        modelOptions: models,
        filteredOptions: ['claude-3-haiku'],
        selected: 0,
        pickedProviderId: 'anthropic',
        searchQuery: 'haiku',
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('haiku');
    expect(frame).toContain('1 match');
    view.unmount();
  });

  it('shows no match message when search has no results', () => {
    const view = render(
      React.createElement(ModelPicker, {
        step: 'model',
        providerOptions: providers,
        modelOptions: models,
        filteredOptions: [],
        selected: 0,
        pickedProviderId: 'anthropic',
        searchQuery: 'zzzzz',
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('no models match');
    view.unmount();
  });

  it('shows scroll indicators when many models', () => {
    const manyModels = Array.from({ length: 25 }, (_, i) => `model-${i}`);
    const view = render(
      React.createElement(ModelPicker, {
        step: 'model',
        providerOptions: providers,
        modelOptions: manyModels,
        filteredOptions: manyModels,
        selected: 20,
        pickedProviderId: 'anthropic',
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('▲');
    view.unmount();
  });

  it('shows below indicator when more models below', () => {
    const manyModels = Array.from({ length: 25 }, (_, i) => `model-${i}`);
    const view = render(
      React.createElement(ModelPicker, {
        step: 'model',
        providerOptions: providers,
        modelOptions: manyModels,
        filteredOptions: manyModels,
        selected: 5,
        pickedProviderId: 'anthropic',
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('▼');
    view.unmount();
  });

  it('renders hint when provided', () => {
    const view = render(
      React.createElement(ModelPicker, {
        step: 'model',
        providerOptions: providers,
        modelOptions: models,
        filteredOptions: models,
        selected: 0,
        pickedProviderId: 'anthropic',
        hint: 'Model not available',
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('Model not available');
    view.unmount();
  });

  it('shows model count hint when no search and many models', () => {
    const manyModels = Array.from({ length: 15 }, (_, i) => `model-${i}`);
    const view = render(
      React.createElement(ModelPicker, {
        step: 'model',
        providerOptions: providers,
        modelOptions: manyModels,
        filteredOptions: manyModels,
        selected: 0,
        pickedProviderId: 'anthropic',
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('15 models');
    view.unmount();
  });
});

describe('ModelPicker - height stability across providers (split mode)', () => {
  // Regression: navigating between providers with different model counts used
  // to change the detail-panel height because the "available models" preview
  // rendered a variable line count (slice().join('\n') with no padding). The
  // panel now pads to a fixed budget, so every provider's frame must be the
  // same height. Uses wide columns to trigger split-mode rendering.
  const columns = 110;
  const maxRows = 16;

  function frameLineCount(frame: string): number {
    const trimmed = frame.replace(/\s+$/, '');
    return trimmed === '' ? 0 : trimmed.split('\n').length;
  }

  it('renders the same frame height for providers with 1 vs many models', () => {
    const mixed: ProviderOption[] = [
      {
        id: 'minimal-provider',
        family: 'mini',
        models: ['solo-model'],
      },
      {
        id: 'maximal-provider',
        family: 'maxi',
        models: Array.from({ length: 40 }, (_, i) => `huge-model-${i}`),
      },
    ];

    const viewMinimal = render(
      React.createElement(ModelPicker, {
        step: 'provider',
        providerOptions: mixed,
        modelOptions: [],
        filteredOptions: [],
        selected: 0,
        columns,
        maxRows,
      }),
    );
    const minimalFrame = viewMinimal.lastFrame() ?? '';
    viewMinimal.unmount();

    const viewMaximal = render(
      React.createElement(ModelPicker, {
        step: 'provider',
        providerOptions: mixed,
        modelOptions: [],
        filteredOptions: [],
        selected: 1,
        columns,
        maxRows,
      }),
    );
    const maximalFrame = viewMaximal.lastFrame() ?? '';
    viewMaximal.unmount();

    expect(frameLineCount(minimalFrame)).toBe(frameLineCount(maximalFrame));
  });

  it('renders the same frame height for an empty-models provider', () => {
    const mixed: ProviderOption[] = [
      {
        id: 'empty-provider',
        family: 'empty',
        models: [],
      },
      {
        id: 'full-provider',
        family: 'full',
        models: Array.from({ length: 20 }, (_, i) => `m-${i}`),
      },
    ];

    const viewEmpty = render(
      React.createElement(ModelPicker, {
        step: 'provider',
        providerOptions: mixed,
        modelOptions: [],
        filteredOptions: [],
        selected: 0,
        columns,
        maxRows,
      }),
    );
    const emptyFrame = viewEmpty.lastFrame() ?? '';
    viewEmpty.unmount();

    const viewFull = render(
      React.createElement(ModelPicker, {
        step: 'provider',
        providerOptions: mixed,
        modelOptions: [],
        filteredOptions: [],
        selected: 1,
        columns,
        maxRows,
      }),
    );
    const fullFrame = viewFull.lastFrame() ?? '';
    viewFull.unmount();

    expect(frameLineCount(emptyFrame)).toBe(frameLineCount(fullFrame));
  });
});
