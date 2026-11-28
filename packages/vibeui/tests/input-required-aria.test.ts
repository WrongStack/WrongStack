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

function controllerFor(required: boolean, kind = 'single_select') {
  return {
    state: {
      id: 'session-1',
      confirm: null,
      inputs: [
        {
          id: 'request-1',
          title: 'Choose a path',
          questions: [
            {
              id: 'path',
              prompt: 'Which path?',
              kind,
              required,
              allowCustom: true,
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

async function requiredStates(required: boolean, kind = 'single_select') {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(createElement(PendingInteractions, { controller: controllerFor(required, kind) }));
  });
  const inputs = document.querySelectorAll<HTMLInputElement>('fieldset.input-question input');
  const textarea = document.querySelector<HTMLTextAreaElement>('fieldset.input-question textarea');
  expect(inputs.length, 'both choices render').toBe(2);
  expect(textarea, 'written answer renders').not.toBeNull();
  return [
    ...[...inputs].map((input) => input.getAttribute('aria-required')),
    textarea!.getAttribute('aria-required'),
  ];
}

describe('input dialog required state (WCAG 4.1.2)', () => {
  it('exposes required state on choices and written answer', async () => {
    expect(await requiredStates(true)).toEqual(['true', 'true', 'true']);
  });

  it('marks optional controls as not required', async () => {
    expect(await requiredStates(false)).toEqual(['false', 'false', 'false']);
  });

  it('does not make every multi-select option individually required', async () => {
    expect(await requiredStates(true, 'multi_select')).toEqual(['false', 'false', 'false']);
  });
});
