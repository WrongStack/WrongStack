// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PendingInteractions } from '../src/components/dialogs';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.innerHTML = '';
});

function controllerFor(allowCustom: boolean, send = vi.fn(() => true)) {
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
              prompt: 'Which path?',
              kind: allowCustom ? 'single_select' : 'text',
              required: true,
              allowCustom,
              options: allowCustom
                ? [
                    { id: 'left', label: 'Left' },
                    { id: 'right', label: 'Right' },
                  ]
                : [],
            },
          ],
        },
      ],
    },
    connection: 'open',
    send,
    notice: () => {},
    decideConfirmation: () => {},
  } as never;
}

async function renderInput(allowCustom: boolean, send = vi.fn(() => true)) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(
      createElement(PendingInteractions, {
        controller: controllerFor(allowCustom, send),
      }),
    );
  });
  const submit = document.querySelector<HTMLButtonElement>('.dialog-actions button[type="submit"]');
  expect(submit, 'submit button renders').not.toBeNull();
  return { host, submit: submit! };
}

describe('input validation error association (WCAG 3.3.1)', () => {
  it('marks unanswered required choices invalid and links them to the alert', async () => {
    const send = vi.fn(() => true);
    const { submit } = await renderInput(true, send);
    await act(async () => submit.click());

    const alert = document.querySelector<HTMLElement>('[role="alert"]');
    expect(alert?.textContent).toContain('Please answer the required questions.');
    const errorId = alert?.getAttribute('id');
    expect(errorId).toBeTruthy();
    expect(send).not.toHaveBeenCalled();

    const choices = document.querySelectorAll<HTMLInputElement>('fieldset.input-question input');
    expect(choices.length).toBe(2);
    for (const choice of choices) {
      expect(choice.getAttribute('aria-invalid')).toBe('true');
      expect(choice.getAttribute('aria-describedby')).toContain(errorId!);
    }

    await act(async () => choices[0]!.click());
    expect(choices[0]!.getAttribute('aria-invalid')).toBe('false');
  });

  it('marks an unanswered required written answer invalid too', async () => {
    const { submit } = await renderInput(true);
    await act(async () => submit.click());

    const textarea = document.querySelector<HTMLTextAreaElement>(
      'fieldset.input-question textarea',
    );
    const alert = document.querySelector<HTMLElement>('[role="alert"]');
    expect(textarea, 'written answer renders').not.toBeNull();
    expect(textarea?.getAttribute('aria-invalid')).toBe('true');
    expect(textarea?.getAttribute('aria-describedby')).toContain(alert?.getAttribute('id') ?? '');

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(textarea!, 'Left');
      textarea!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(textarea?.getAttribute('aria-invalid')).toBe('false');
  });
});
