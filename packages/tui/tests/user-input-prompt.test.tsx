import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { UserInputPrompt } from '../src/components/user-input-prompt.js';
import { renderRealTty, settle } from './helpers/real-tty.js';

describe('TUI structured user input prompt', () => {
  it('renders tabs and recommendations and submits choices plus text', async () => {
    const resolve = vi.fn();
    const view = render(
      <UserInputPrompt
        pending={{
          resolve,
          request: {
            id: 'r1',
            title: 'Architecture decisions',
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
                questions: [{ id: 'name', prompt: 'Tenant name?', kind: 'text', required: true }],
              },
            ],
          },
        }}
      />,
    );

    expect(view.lastFrame()).toContain('1● Data 1/1');
    expect(view.lastFrame()).toContain('2○ Brand 0/1');
    expect(view.lastFrame()).toContain('PostgreSQL ★ recommended');
    view.stdin.write('\t');
    await new Promise((resolveTick) => setTimeout(resolveTick, 0));
    expect(view.lastFrame()).toContain('Tenant name?');
    view.stdin.write('\r');
    await new Promise((resolveTick) => setTimeout(resolveTick, 0));
    view.stdin.write('Acme');
    await new Promise((resolveTick) => setTimeout(resolveTick, 0));
    view.stdin.write('\r');
    await new Promise((resolveTick) => setTimeout(resolveTick, 0));
    view.stdin.write('s');
    await new Promise((resolveTick) => setTimeout(resolveTick, 0));
    expect(resolve).toHaveBeenCalledOnce();
    expect(resolve.mock.calls[0]?.[0].answers).toEqual([
      expect.objectContaining({
        questionId: 'db',
        selectedOptionIds: ['pg'],
        usedRecommendation: true,
      }),
      expect.objectContaining({ questionId: 'name', text: 'Acme' }),
    ]);
  });

  it('supports multi-select plus an optional manual answer on the same question', async () => {
    const resolve = vi.fn();
    const view = render(
      <UserInputPrompt
        pending={{
          resolve,
          request: {
            id: 'r2',
            title: 'Feature choices',
            tabs: [
              {
                id: 'product',
                label: 'Product',
                questions: [
                  {
                    id: 'features',
                    prompt: 'Features?',
                    kind: 'multi_select',
                    required: true,
                    options: [
                      { id: 'audit', label: 'Audit log' },
                      { id: 'sso', label: 'SSO' },
                    ],
                    recommendedOptionIds: ['audit'],
                    allowCustomResponse: true,
                  },
                ],
              },
            ],
          },
        }}
      />,
    );

    view.stdin.write('\u001b[B');
    await new Promise((resolveTick) => setTimeout(resolveTick, 0));
    view.stdin.write(' ');
    await new Promise((resolveTick) => setTimeout(resolveTick, 0));
    view.stdin.write('e');
    await new Promise((resolveTick) => setTimeout(resolveTick, 0));
    view.stdin.write('SCIM later');
    await new Promise((resolveTick) => setTimeout(resolveTick, 0));
    view.stdin.write('\r');
    await new Promise((resolveTick) => setTimeout(resolveTick, 0));
    view.stdin.write('s');
    await new Promise((resolveTick) => setTimeout(resolveTick, 0));
    expect(resolve.mock.calls[0]?.[0].answers[0]).toEqual(
      expect.objectContaining({
        selectedOptionIds: ['audit', 'sso'],
        text: 'SCIM later',
        usedRecommendation: false,
      }),
    );
  });

  it('keeps navigation and submit controls visible in a short terminal', async () => {
    const view = renderRealTty(
      <UserInputPrompt
        pending={{
          resolve: vi.fn(),
          request: {
            id: 'r3',
            title: 'A deliberately long decision form title',
            tabs: [
              {
                id: 'main',
                label: 'Architecture',
                questions: Array.from({ length: 8 }, (_, questionIndex) => ({
                  id: `q${questionIndex}`,
                  prompt: `Question ${questionIndex + 1} with a long explanatory title?`,
                  kind: 'multi_select' as const,
                  required: true,
                  allowCustomResponse: true,
                  options: Array.from({ length: 8 }, (_, optionIndex) => ({
                    id: `o${optionIndex}`,
                    label: `Option ${optionIndex + 1}`,
                  })),
                })),
              },
            ],
          },
        }}
      />,
      { columns: 48, rows: 14 },
    );

    await settle();
    expect(view.lines().length).toBeLessThanOrEqual(14);
    expect(view.lastFrame()).toContain('Tab category');
    expect(view.lastFrame()).toContain('s submit');
    expect(view.lastFrame()).toContain('required answer(s) missing');
    view.unmount();
  });
});
