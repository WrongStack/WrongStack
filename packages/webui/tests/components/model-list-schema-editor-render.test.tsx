import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { toastSuccess } = vi.hoisted(() => ({ toastSuccess: vi.fn() }));

vi.mock('@/i18n', () => ({
  useAppTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('../../src/components/Toaster', () => ({
  toast: { success: toastSuccess },
}));

vi.mock('../../src/components/SettingsPanel/ModelCatalogPicker', () => ({
  ModelCatalogPicker: ({
    onClose,
    onSelect,
  }: {
    onClose: () => void;
    onSelect: (modelId: string, model: Record<string, unknown>) => void;
  }) => (
    <div data-testid="catalog-picker">
      <button type="button" onClick={() => onSelect('catalog-model', { name: 'Catalog model' })}>
        choose catalog model
      </button>
      <button type="button" onClick={onClose}>
        close catalog
      </button>
    </div>
  ),
}));

import { ModelListEditor } from '../../src/components/SettingsPanel/ModelListEditor';
import { ModelSchemaEditor } from '../../src/components/SettingsPanel/ModelSchemaEditor';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function ws() {
  return {
    removeCustomModel: vi.fn(),
    setCustomModel: vi.fn(),
  };
}

describe('ModelListEditor rendered actions', () => {
  it('filters model rows and emits pick, remove, and catalog-selection actions', () => {
    const client = ws();
    const onPickModel = vi.fn();
    const models = Array.from({ length: 9 }, (_, index) => `model-${index}`);
    render(
      <ModelListEditor
        providerId="openai"
        models={models}
        customModels={{
          'model-0': {
            name: 'Primary model',
            maxOutput: 16_384,
            capabilities: { tools: true, reasoning: true, vision: true },
            modelsDev: {
              limit: { context: 128_000 },
              cost: { input: 2, output: 8 },
              modalities: { input: ['text', 'image'], output: ['text'] },
            },
          },
        }}
        ws={client as never}
        onPickModel={onPickModel}
      />,
    );

    expect(screen.getByText('Primary model')).toBeTruthy();
    expect(screen.getByTitle('input: image')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'model-8' } });
    expect(screen.queryByText('model-0')).toBeNull();
    expect(screen.getByText('model-8')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('settings:providerModels.useModel'));
    expect(onPickModel).toHaveBeenCalledWith('openai', 'model-8');
    fireEvent.click(screen.getByLabelText('settings:providerModels.removeModel'));
    expect(client.removeCustomModel).toHaveBeenCalledWith('openai', 'model-8');

    fireEvent.click(screen.getByText('settings:providerModels.addFromCatalog'));
    fireEvent.click(screen.getByText('choose catalog model'));
    expect(client.setCustomModel).toHaveBeenCalledWith('openai', 'catalog-model', {
      modelsDev: { name: 'Catalog model' },
    });
    expect(toastSuccess).toHaveBeenCalled();
  });

  it('opens an inline schema editor and saves an edited model', () => {
    const client = ws();
    render(
      <ModelListEditor
        providerId="openai"
        models={['model-a']}
        customModels={{ 'model-a': { modelsDev: { name: 'Model A' } } }}
        ws={client as never}
      />,
    );

    fireEvent.click(screen.getByLabelText('settings:providerModels.editModel'));
    fireEvent.change(screen.getByLabelText('settings:providerModels.fieldName'), {
      target: { value: 'Renamed model' },
    });
    fireEvent.click(screen.getByText('common:save'));

    expect(client.setCustomModel).toHaveBeenCalledWith('openai', 'model-a', {
      modelsDev: expect.objectContaining({ name: 'Renamed model' }),
    });
  });
});

describe('ModelSchemaEditor rendered form and raw JSON paths', () => {
  it('persists edited form fields and modality/capability selections', () => {
    const onSave = vi.fn();
    render(
      <ModelSchemaEditor
        providerId="openai"
        modelId="model-a"
        initialModelsDev={{ name: 'Model A', limit: { context: 8_192 } }}
        onSave={onSave}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText('settings:providerModels.fieldOutput'), {
      target: { value: '4096' },
    });
    fireEvent.click(screen.getAllByText('image')[0]!);
    fireEvent.click(screen.getAllByRole('checkbox')[0]!);
    fireEvent.click(screen.getByText('common:save'));

    expect(onSave).toHaveBeenCalledWith(
      'model-a',
      expect.objectContaining({
        limit: { context: 8_192, output: 4096 },
        modalities: { input: ['image'] },
        tool_call: true,
      }),
    );
  });

  it('reports invalid raw JSON and saves a validated raw model', () => {
    const onSave = vi.fn();
    render(
      <ModelSchemaEditor
        providerId="openai"
        modelId=""
        initialModelsDev={{}}
        onSave={onSave}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText('settings:providerModels.tabRawJson'));
    const raw = screen.getByRole('textbox');
    fireEvent.change(raw, { target: { value: '{' } });
    fireEvent.click(screen.getByText('common:save'));
    expect(screen.getByText(/JSON/)).toBeTruthy();

    fireEvent.change(raw, { target: { value: '{"id":"raw-model","name":"Raw model"}' } });
    fireEvent.click(screen.getByText('common:save'));
    expect(onSave).toHaveBeenCalledWith('raw-model', { name: 'Raw model' });
  });
});
