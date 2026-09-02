// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PendingModelSwitch } from '../src/hooks/use-model-catalog.js';
import { ModelSwitcher } from '../src/model-switcher.js';
import type { ModelDescriptor } from '../src/types.js';

const roots: Root[] = [];

function makeModels(): [string, ModelDescriptor[]][] {
  return [
    [
      'openai',
      [
        { id: 'gpt-4o', name: 'GPT-4o', contextWindow: 128_000 },
        { id: 'gpt-4o-mini', name: 'GPT-4o mini', contextWindow: 128_000 },
        { id: 'vision-model', name: 'Vision', contextWindow: 64_000 },
      ],
    ],
  ];
}

const pending: PendingModelSwitch = {
  provider: 'openai',
  model: 'gpt-4o-mini',
  modelName: 'GPT-4o mini',
  currentWindow: 128_000,
  nextWindow: 64_000,
};

beforeEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
});

function trigger(container: HTMLElement): HTMLButtonElement {
  const el = container.querySelector('.model-select-trigger');
  if (!el) throw new Error('.model-select-trigger not found');
  return el as HTMLButtonElement;
}

function render(props: Partial<Parameters<typeof ModelSwitcher>[0]> = {}): HTMLElement {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() =>
    root.render(
      <ModelSwitcher
        selectedModel={props.selectedModel ?? 'openai\tgpt-4o'}
        groupedModels={props.groupedModels ?? makeModels()}
        providerLabels={props.providerLabels ?? { openai: 'OpenAI' }}
        disabled={props.disabled ?? false}
        pendingModelSwitch={props.pendingModelSwitch ?? null}
        onSelectModel={props.onSelectModel ?? vi.fn()}
        onConfirmSwitch={props.onConfirmSwitch ?? vi.fn()}
        onCancelSwitch={props.onCancelSwitch ?? vi.fn()}
      />,
    ),
  );
  return container;
}

function openPicker(container: HTMLElement): HTMLElement {
  act(() => trigger(container).dispatchEvent(new MouseEvent('click', { bubbles: true })));
  const picker = container.querySelector('.model-picker');
  if (!picker) throw new Error('.model-picker not found after opening');
  return picker as HTMLElement;
}

describe('ModelSwitcher — trigger', () => {
  it('renders the selected model name on the trigger button', () => {
    const container = render();
    expect(trigger(container).textContent).toContain('GPT-4o');
    expect(trigger(container).getAttribute('aria-haspopup')).toBe('dialog');
  });

  it('disables the trigger when disabled=true', () => {
    const container = render({ disabled: true });
    expect(trigger(container).disabled).toBe(true);
  });

  it('shows Loading models… when groupedModels is empty', () => {
    const container = render({ groupedModels: [] });
    expect(trigger(container).textContent).toContain('Loading models…');
  });
});

describe('ModelSwitcher — picker', () => {
  it('renders one option per model with provider label and context window', () => {
    const container = render();
    const picker = openPicker(container);
    const options = picker.querySelectorAll('.model-picker-item');
    expect(options).toHaveLength(3);
    expect(options[0]?.textContent).toContain('GPT-4o');
    expect(options[0]?.textContent).toContain('128K');
    expect(options[0]?.textContent).toContain('OpenAI');
  });

  it('marks the selected model with aria-selected', () => {
    const container = render();
    const picker = openPicker(container);
    const options = picker.querySelectorAll('.model-picker-item');
    expect(options[0]?.getAttribute('aria-selected')).toBe('true');
    expect(options[1]?.getAttribute('aria-selected')).toBe('false');
  });

  it('shows a vision indicator for vision-capable models', () => {
    const container = render();
    const picker = openPicker(container);
    const vision = picker.querySelector('.model-picker-vision');
    expect(vision?.getAttribute('aria-label')).toBe('Vision capable');
  });

  it('filters options by the search query', () => {
    const container = render();
    const picker = openPicker(container);
    const input = picker.querySelector<HTMLInputElement>('.model-picker-search input');
    if (!input) throw new Error('search input not found');
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    act(() => {
      setValue?.call(input, 'mini');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const options = picker.querySelectorAll('.model-picker-item');
    expect(options).toHaveLength(1);
    expect(options[0]?.textContent).toContain('GPT-4o mini');
  });

  it('selects a model on click and reports provider + model id', () => {
    const onSelectModel = vi.fn();
    const container = render({ onSelectModel });
    const picker = openPicker(container);
    const second = picker.querySelectorAll('.model-picker-item')[1];
    act(() => second?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onSelectModel).toHaveBeenCalledWith('openai', 'gpt-4o-mini');
    expect(container.querySelector('.model-picker')).toBeNull();
    expect(localStorage.getItem('wrongstack.simpleui.models.recent')).toContain('gpt-4o-mini');
  });

  it('selects the highlighted model on Enter and closes on Escape', () => {
    const onSelectModel = vi.fn();
    const container = render({ onSelectModel });
    const picker = openPicker(container);
    const input = picker.querySelector<HTMLInputElement>('.model-picker-search input');
    if (!input) throw new Error('search input not found');
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onSelectModel).toHaveBeenCalledWith('openai', 'gpt-4o-mini');

    const reopened = openPicker(container);
    const reopenedInput = reopened.querySelector<HTMLInputElement>('.model-picker-search input');
    act(() => {
      reopenedInput?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(container.querySelector('.model-picker')).toBeNull();
  });

  it('caps the unfiltered list and hints about the total', () => {
    const many: ModelDescriptor[] = Array.from({ length: 120 }, (_, i) => ({
      id: `model-${i}`,
      name: `Model ${i}`,
      contextWindow: 100_000,
    }));
    const container = render({ groupedModels: [['openai', many]] });
    const picker = openPicker(container);
    expect(picker.querySelectorAll('.model-picker-item').length).toBeLessThanOrEqual(80);
    const more = picker.querySelector('.model-picker-more');
    expect(more?.textContent).toContain('120');
  });
});

describe('ModelSwitcher — warning dialog', () => {
  it('does not render a warning when pendingModelSwitch is null', () => {
    const container = render({ pendingModelSwitch: null });
    expect(container.querySelector('.model-switch-warning')).toBeNull();
  });

  it('renders the warning with model name and context sizes when pending', () => {
    const container = render({ pendingModelSwitch: pending });
    const warning = container.querySelector('.model-switch-warning');
    expect(warning).not.toBeNull();
    expect(warning?.textContent).toContain('GPT-4o mini');
    expect(warning?.textContent).toContain('64K');
    expect(warning?.textContent).toContain('128K');
  });

  it('calls onConfirmSwitch when the confirm button is clicked', () => {
    const onConfirmSwitch = vi.fn();
    const container = render({ pendingModelSwitch: pending, onConfirmSwitch });
    const btn = container.querySelector<HTMLButtonElement>('.model-switch-confirm');
    act(() => btn?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onConfirmSwitch).toHaveBeenCalledTimes(1);
  });

  it('calls onCancelSwitch when the cancel button is clicked', () => {
    const onCancelSwitch = vi.fn();
    const container = render({ pendingModelSwitch: pending, onCancelSwitch });
    const btn = container.querySelector<HTMLButtonElement>('.model-switch-cancel');
    act(() => btn?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onCancelSwitch).toHaveBeenCalledTimes(1);
  });
});
