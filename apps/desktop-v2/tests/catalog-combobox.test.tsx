/**
 * @vitest-environment jsdom
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement, useState, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { surfaceI18n } from '../src/surface-i18n';
import { CatalogCombobox, type CatalogComboboxProps } from '../src/CatalogCombobox';
import type { ComboboxOption } from '../src/model-reference-options';

const options: ComboboxOption[] = [
  {
    value: 'openai/gpt-x',
    label: 'GPT X',
    display: 'OpenAI · GPT X',
    group: 'OpenAI',
    hint: 'gpt-x · 200K context',
  },
  { value: 'openai/o1', label: 'o1', display: 'OpenAI · o1', group: 'OpenAI' },
  { value: 'zai/glm', label: 'GLM', display: 'Z.AI · GLM', group: 'Z.AI', hint: '128K context' },
];

/** The picker as a settings page holds it: the draft owns the value and every edit rewrites it. */
function Controlled({
  initial,
  onChange,
  ...rest
}: Omit<CatalogComboboxProps, 'value' | 'onChange' | 'name'> & {
  initial: string;
  onChange: (value: string) => void;
}) {
  const [value, setValue] = useState(initial);
  return createElement(CatalogCombobox, {
    ...rest,
    name: 'Model',
    value,
    onChange: (next: string) => {
      setValue(next);
      onChange(next);
    },
  });
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function mount(element: ReactElement) {
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(element);
  });
  return host;
}

beforeAll(async () => {
  await surfaceI18n.changeLanguage('en');
});
afterAll(async () => {
  await surfaceI18n.changeLanguage('en');
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
  }
  host?.remove();
  root = null;
  host = null;
});

const box = () => host!.querySelector<HTMLInputElement>('input[role="combobox"]')!;
const key = (name: string) =>
  act(async () => {
    const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true });
    box().dispatchEvent(event);
    return event.defaultPrevented;
  });
const type = (text: string) =>
  act(async () => {
    const input = box();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
const focus = () =>
  act(async () => {
    box().focus();
  });
const click = (element: Element) =>
  act(async () => {
    element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
const optionTexts = () =>
  [...host!.querySelectorAll('[role="option"]')].map(
    (option) =>
      `${option.querySelector('strong')?.textContent}|${option.getAttribute('aria-selected')}`,
  );
const button = (label: string) =>
  [...host!.querySelectorAll('button')].find((item) => item.getAttribute('aria-label') === label)!;

describe('the catalog combobox', () => {
  it('shows a known value by name with its facts under it', async () => {
    await mount(createElement(Controlled, { initial: 'openai/gpt-x', onChange: vi.fn(), options }));
    expect(box().value).toBe('OpenAI · GPT X');
    expect(host!.querySelector('.catalog-combobox-caption')?.textContent).toBe(
      'gpt-x · 200K context',
    );
  });

  it('shows a value outside the catalog as typed, saying it is a custom reference', async () => {
    await mount(
      createElement(Controlled, {
        initial: 'vendor/custom',
        onChange: vi.fn(),
        options,
        customText: 'custom reference',
      }),
    );
    expect(box().value).toBe('vendor/custom');
    expect(host!.querySelector('.catalog-combobox-caption')?.textContent).toBe('custom reference');
  });

  it('opens on focus with every choice grouped by provider, then narrows as the user types', async () => {
    const onChange = vi.fn();
    await mount(createElement(Controlled, { initial: '', onChange, options }));
    expect(host!.querySelector('[role="listbox"]')).toBeNull();
    await focus();
    expect(box().getAttribute('aria-expanded')).toBe('true');
    expect(host!.querySelectorAll('.catalog-combobox-group')).toHaveLength(2);
    expect(optionTexts()).toEqual(['GPT X|false', 'o1|false', 'GLM|false']);
    await type('glm');
    expect(optionTexts()).toEqual(['GLM|true']);
    expect(box().getAttribute('aria-activedescendant')).toBe(
      host!.querySelector('[role="option"]')!.id,
    );
    expect(onChange).toHaveBeenLastCalledWith('glm');
  });

  it('picks with the keyboard without submitting the form around it', async () => {
    const onSubmit = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
    const onChange = vi.fn();
    await mount(
      createElement(
        'form',
        { onSubmit },
        createElement(Controlled, { initial: '', onChange, options }),
      ),
    );
    await focus();
    expect(await key('ArrowDown')).toBe(true);
    expect(optionTexts()).toEqual(['GPT X|true', 'o1|false', 'GLM|false']);
    await key('ArrowDown');
    await key('ArrowUp');
    expect(await key('Enter')).toBe(true);
    expect(onChange).toHaveBeenLastCalledWith('openai/gpt-x');
    expect(box().getAttribute('aria-expanded')).toBe('false');
    expect(box().value).toBe('OpenAI · GPT X');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('closes with Escape or a click outside and keeps the value it had', async () => {
    const onChange = vi.fn();
    await mount(createElement(Controlled, { initial: 'zai/glm', onChange, options }));
    await focus();
    // Focusing shows the stored reference itself, ready to edit.
    expect(box().value).toBe('zai/glm');
    expect(await key('Escape')).toBe(true);
    expect(box().getAttribute('aria-expanded')).toBe('false');
    expect(box().value).toBe('Z.AI · GLM');
    await click(button('Show options'));
    expect(box().getAttribute('aria-expanded')).toBe('true');
    // Browsing keeps the current reference in the box and lists everything.
    expect(box().value).toBe('zai/glm');
    expect(optionTexts()).toEqual(['GPT X|false', 'o1|false', 'GLM|true']);
    await act(async () => {
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    });
    expect(box().getAttribute('aria-expanded')).toBe('false');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('picks a clicked option and clears through the clear button', async () => {
    const onChange = vi.fn();
    await mount(
      createElement(Controlled, {
        initial: 'openai/gpt-x',
        onChange,
        options,
        clearLabel: 'Clear',
      }),
    );
    await click(button('Show options'));
    await click(host!.querySelectorAll('[role="option"]')[2]!);
    expect(onChange).toHaveBeenLastCalledWith('zai/glm');
    expect(box().getAttribute('aria-expanded')).toBe('false');
    expect(box().value).toBe('Z.AI · GLM');
    await click(button('Clear'));
    expect(onChange).toHaveBeenLastCalledWith('');
    expect(box().value).toBe('');
    expect(host!.querySelector('button[aria-label="Clear"]')).toBeNull();
  });

  it('says when the catalog is empty, has no match, or is still loading', async () => {
    await mount(createElement(Controlled, { initial: '', onChange: vi.fn(), options: [] }));
    await focus();
    expect(host!.querySelector('.catalog-combobox-popup')?.textContent).toContain(
      'Nothing saved to choose from',
    );
    await type('anything');
    expect(host!.querySelector('.catalog-combobox-popup')?.textContent).toContain(
      'Nothing saved to choose from',
    );
    await mount(createElement(Controlled, { initial: '', onChange: vi.fn(), options }));
    await focus();
    await type('nope');
    expect(host!.querySelector('.catalog-combobox-popup')?.textContent).toContain(
      'Nothing saved matches “nope”',
    );
    await mount(
      createElement(Controlled, { initial: '', onChange: vi.fn(), options, loading: true }),
    );
    await focus();
    expect(host!.querySelector('[role="status"]')?.textContent).toContain('Reading saved');
  });
});
