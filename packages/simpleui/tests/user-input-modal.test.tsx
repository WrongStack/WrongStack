// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UserInputModal } from '../src/user-input-modal.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const roots: Root[] = [];

afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  roots.length = 0;
  document.body.innerHTML = '';
});

describe('SimpleUI structured user input', () => {
  it('preselects the recommendation, edits another tab, and submits one result', () => {
    const send = vi.fn();
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    act(() =>
      root.render(
        <UserInputModal
          send={send}
          queuedCount={1}
          pending={{
            sessionId: 's1',
            request: {
              id: 'r1',
              title: 'Decisions',
              tabs: [
                {
                  id: 'data',
                  label: 'Data',
                  questions: [
                    {
                      id: 'db',
                      prompt: 'Database?',
                      kind: 'single_select',
                      required: true,
                      options: [
                        { id: 'pg', label: 'PostgreSQL' },
                        { id: 'sqlite', label: 'SQLite' },
                      ],
                      recommendedOptionIds: ['pg'],
                      recommendationReason: 'Best concurrency.',
                    },
                  ],
                },
                {
                  id: 'brand',
                  label: 'Brand',
                  questions: [
                    {
                      id: 'name',
                      prompt: 'Tenant name?',
                      kind: 'text',
                      required: true,
                      recommendedText: 'Example Inc.',
                    },
                  ],
                },
              ],
            },
          }}
        />,
      ),
    );

    expect(
      (host.querySelector('input[value="pg"]') as HTMLInputElement | null)?.checked ??
        (host.querySelector('input[type="radio"]') as HTMLInputElement).checked,
    ).toBe(true);
    const brand = [...host.querySelectorAll('button')].find(
      (button) => button.textContent?.startsWith('Brand'),
    )!;
    act(() => brand.click());
    const textarea = host.querySelector('textarea')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
        textarea,
        'Acme',
      );
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const submit = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === 'Submit answers',
    )!;
    act(() => submit.click());
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0]).toBe('user.input_submit');
    expect(send.mock.calls[0]?.[1].response.answers).toEqual([
      expect.objectContaining({
        questionId: 'db',
        selectedOptionIds: ['pg'],
        usedRecommendation: true,
      }),
      expect.objectContaining({ questionId: 'name', text: 'Acme', usedRecommendation: false }),
    ]);
  });
});
