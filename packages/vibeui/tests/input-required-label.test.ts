// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { PendingInteractions } from '../src/components/dialogs';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.innerHTML = '';
});

function controllerFor(required: boolean) {
  return {
    state: {
      confirm: null,
      inputs: [
        {
          id: 'request-1',
          title: 'Choose a path',
          questions: [
            {
              id: 'path',
              prompt: required ? 'Which path?' : 'Where next?',
              kind: 'single_select',
              required,
              allowCustom: false,
              options: [
                { id: 'left', label: 'Left' },
                { id: 'right', label: 'Right' },
              ],
            },
          ],
        },
      ],
    },
    connection: 'open',
    send: () => true,
    notice: () => {},
    decideConfirmation: () => {},
  } as never;
}

async function renderLegend(required: boolean) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(createElement(PendingInteractions, { controller: controllerFor(required) }));
  });
  const legend = document.querySelector<HTMLLegendElement>('fieldset.input-question legend');
  expect(legend, 'question legend renders').not.toBeNull();
  const choices = document.querySelectorAll<HTMLInputElement>('fieldset.input-question input');
  expect(choices.length, 'both choices render').toBe(2);
  expect(
    [...choices].every((choice) => choice.type === 'radio'),
    'choices are native radio buttons',
  ).toBe(true);
  return legend!.textContent ?? '';
}

describe('input dialog required instruction (WCAG 3.3.2)', () => {
  it('exposes the visible asterisk as a spoken required instruction', async () => {
    const label = await renderLegend(true);
    expect(label).toContain('*');
    expect(label).toMatch(/\brequired\b/i);
  });

  it('does not claim an optional question is required', async () => {
    expect(await renderLegend(false)).toBe('Where next?');
  });
});
