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
    expect(view.lastFrame()).toContain('[x] Other: SCIM later');
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

  it('lets the user delegate a decision to the model', async () => {
    const resolve = vi.fn();
    const view = render(
      <UserInputPrompt
        pending={{
          resolve,
          request: {
            id: 'delegated',
            title: 'Decision',
            submitLabel: 'Metni Gönder',
            tabs: [
              {
                id: 'main',
                label: 'Main',
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
                  },
                ],
              },
            ],
          },
        }}
      />,
    );

    expect(view.lastFrame()).toContain('SUBMIT');
    expect(view.lastFrame()).not.toContain('Metni Gönder');
    view.stdin.write('d');
    await new Promise((resolveTick) => setTimeout(resolveTick, 0));
    expect(view.lastFrame()).toContain('delegated to the model');
    view.stdin.write('s');
    await new Promise((resolveTick) => setTimeout(resolveTick, 0));
    expect(resolve.mock.calls[0]?.[0].answers[0]).toEqual({
      questionId: 'db',
      selectedOptionIds: [],
      delegated: true,
      usedRecommendation: false,
    });
  });

  it('moves between multiple questions in the same category', async () => {
    const view = render(
      <UserInputPrompt
        pending={{
          resolve: vi.fn(),
          request: {
            id: 'multiple',
            title: 'Multiple questions',
            tabs: [
              {
                id: 'main',
                label: 'Main',
                questions: [
                  { id: 'first', prompt: 'First question?', kind: 'text', required: true },
                  { id: 'second', prompt: 'Second question?', kind: 'text', required: true },
                ],
              },
            ],
          },
        }}
      />,
    );

    expect(view.lastFrame()).toContain('QUESTION 1/2');
    expect(view.lastFrame()).toContain('First question?');
    view.stdin.write('\u001b[C');
    await new Promise((resolveTick) => setTimeout(resolveTick, 0));
    expect(view.lastFrame()).toContain('QUESTION 2/2');
    expect(view.lastFrame()).toContain('Second question?');
  });

  it('submits through the measured mouse target only when the form is valid', async () => {
    const resolve = vi.fn();
    const view = renderRealTty(
      <UserInputPrompt
        pending={{
          resolve,
          request: {
            id: 'mouse-submit',
            title: 'Mouse submit',
            tabs: [
              {
                id: 'main',
                label: 'Main',
                questions: [
                  {
                    id: 'database',
                    prompt: 'Database?',
                    kind: 'single_select',
                    required: true,
                    options: [
                      { id: 'pg', label: 'PostgreSQL' },
                      { id: 'sqlite', label: 'SQLite' },
                    ],
                    recommendedOptionIds: ['pg'],
                  },
                ],
              },
            ],
          },
        }}
      />,
      { columns: 80, rows: 24 },
    );

    await settle();
    const lines = view.lines();
    const row = lines.findIndex((line) => line.includes('SUBMIT'));
    const column = lines[row]!.indexOf('SUBMIT');
    expect(row).toBeGreaterThanOrEqual(0);
    expect(column).toBeGreaterThanOrEqual(0);
    expect(lines[row]).not.toContain('LOCKED');
    view.stdin.write(`\u001b[<0;${column + 1};${row + 1}M`);
    await settle();

    expect(resolve).toHaveBeenCalledOnce();
    expect(resolve.mock.calls[0]?.[0].answers[0]).toEqual(
      expect.objectContaining({ questionId: 'database', selectedOptionIds: ['pg'] }),
    );
    view.unmount();
  });

  it('keeps navigation and submit controls visible in a short terminal', async () => {
    const resolve = vi.fn();
    const view = renderRealTty(
      <UserInputPrompt
        pending={{
          resolve,
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
    expect(view.lastFrame()).toContain('QUESTION 1/8');
    expect(view.lastFrame()).toContain('SUBMIT LOCKED');
    expect(view.lastFrame()).toContain('Tab category');
    expect(view.lastFrame()).toContain('s submit');
    expect(view.lastFrame()).toContain('required answer(s) missing');
    const lockedRow = view.lines().findIndex((line) => line.includes('SUBMIT LOCKED'));
    const lockedColumn = view.lines()[lockedRow]!.indexOf('SUBMIT LOCKED');
    view.stdin.write(`\u001b[<0;${lockedColumn + 1};${lockedRow + 1}M`);
    await settle();
    expect(resolve).not.toHaveBeenCalled();
    view.unmount();
  });

  it('uses the full wide terminal as a question navigator and answer workspace', async () => {
    const view = renderRealTty(
      <UserInputPrompt
        pending={{
          resolve: vi.fn(),
          request: {
            id: 'wide',
            title: 'Production architecture decisions',
            description: 'Resolve the remaining implementation choices.',
            tabs: [
              {
                id: 'architecture',
                label: 'Architecture',
                questions: [
                  {
                    id: 'database',
                    prompt: 'Primary database?',
                    kind: 'single_select',
                    required: true,
                    options: [
                      { id: 'pg', label: 'PostgreSQL' },
                      { id: 'sqlite', label: 'SQLite' },
                    ],
                    recommendedOptionIds: ['pg'],
                  },
                  { id: 'name', prompt: 'Tenant name?', kind: 'text', required: true },
                ],
              },
            ],
          },
        }}
      />,
      { columns: 110, rows: 28 },
    );

    await settle();
    expect(view.lines().length).toBeLessThanOrEqual(28);
    expect(view.lastFrame()).toContain('CLARIFY');
    expect(view.lastFrame()).toContain('[█████░░░░░]');
    expect(
      view.lines().some((line) => line.includes('QUESTIONS') && line.includes('QUESTION 1/2')),
    ).toBe(true);
    expect(view.lastFrame()).toContain('D delegate blanks');
    view.unmount();
  });
});
