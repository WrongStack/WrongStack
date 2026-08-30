import { describe, expect, it } from 'vitest';
import type { TodoItem } from '../../src/core/context.js';
import { detectContinueIntent, resolveContinuation } from '../../src/core/continue-intent.js';

const todo = (
  content: string,
  status: TodoItem['status'],
  extra: Partial<TodoItem> = {},
): TodoItem => ({ id: content, content, status, ...extra });

describe('detectContinueIntent', () => {
  it('matches bare English continue variants', () => {
    for (const s of [
      'continue',
      'Continue',
      'CONTINUE',
      '  continue  ',
      'continue.',
      'continue!',
      'go on',
      'keep going',
      'carry on',
      'proceed',
      'next',
      'resume',
      'keep working',
      'more',
    ]) {
      expect(detectContinueIntent(s), s).toBe(true);
    }
  });

  it('matches bare Turkish continue variants (with and without diacritics)', () => {
    for (const s of [
      'devam',
      'devam et',
      'Devam Et',
      'devam et lütfen',
      'devam et lutfen',
      'devam edelim',
      'sürdür',
      'surdur',
      'hadi devam',
      'bir tur daha',
      'bir tur daha at',
      'bir tur daha bakalım',
      'bir tur daha atalım',
    ]) {
      expect(detectContinueIntent(s), s).toBe(true);
    }
  });

  it('strips a trailing politeness token', () => {
    expect(detectContinueIntent('continue please')).toBe(true);
    expect(detectContinueIntent('go on pls')).toBe(true);
    expect(detectContinueIntent('proceed thanks')).toBe(true);
  });

  it('strips wrapping quotes', () => {
    expect(detectContinueIntent('"continue"')).toBe(true);
    expect(detectContinueIntent('`devam et`')).toBe(true);
  });

  it('does NOT match messages carrying additional substance', () => {
    for (const s of [
      'continue with the auth refactor',
      'go on to the next file and commit',
      'devam et ama testleri atla',
      'can you continue the story about dragons',
      'keep going until the build passes then stop',
      'next.js config',
      'please', // bare politeness is not a continue
      'more tests for the parser',
      'resume the paused download job in prod',
    ]) {
      expect(detectContinueIntent(s), s).toBe(false);
    }
  });

  it('handles empty / whitespace / oversized input safely', () => {
    expect(detectContinueIntent('')).toBe(false);
    expect(detectContinueIntent('   ')).toBe(false);
    expect(detectContinueIntent('continue '.repeat(20))).toBe(false);
  });
});

describe('resolveContinuation', () => {
  it('ladder step 1: resumes the in-progress todo (preferred over pending)', () => {
    const r = resolveContinuation({
      todos: [
        todo('First task', 'completed'),
        todo('Second task', 'in_progress', { activeForm: 'Doing the second task' }),
        todo('Third task', 'pending'),
      ],
      suggestions: ['a stale suggestion'],
    });
    expect(r.source).toBe('todo');
    expect(r.todoId).toBe('Second task');
    // Uses activeForm for the in-progress item.
    expect(r.text).toContain('Doing the second task');
    expect(r.text).toContain('(1/3 todos complete.)');
    expect(r.label).toContain('todo:');
  });

  it('ladder step 1: embeds the full board snapshot so progress changes the text', () => {
    const board = [
      todo('First task', 'completed'),
      todo('Second task', 'in_progress'),
      todo('Third task', 'pending'),
    ];
    const r = resolveContinuation({ todos: board });
    // Every board row is present with its status marker — the model gets the
    // whole plan, and the auto-proceed repetition guard only sees identical
    // prompts when the board is genuinely frozen.
    expect(r.text).toContain('[x] First task');
    expect(r.text).toContain('[~] Second task');
    expect(r.text).toContain('[ ] Third task');

    // Any board movement changes the continuation text.
    const progressed = resolveContinuation({
      todos: [
        todo('First task', 'completed'),
        todo('Second task', 'completed'),
        todo('Third task', 'in_progress'),
      ],
    });
    expect(progressed.text).not.toBe(r.text);
  });

  it('ladder step 1: caps the embedded board at 20 rows', () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      todo(`Task ${i + 1}`, i === 0 ? 'in_progress' : 'pending'),
    );
    const r = resolveContinuation({ todos: many });
    expect(r.text).toContain('[~] Task 1');
    expect(r.text).toContain('Task 20');
    expect(r.text).not.toContain('[ ] Task 21');
    expect(r.text).toContain('… 5 more');
  });

  it('ladder step 1: falls to the first pending when nothing is in-progress', () => {
    const r = resolveContinuation({
      todos: [todo('Done', 'completed'), todo('Next up', 'pending'), todo('Later', 'pending')],
    });
    expect(r.source).toBe('todo');
    expect(r.text).toContain('Next up');
  });

  it('ladder step 2: uses the top suggestion when no open todos', () => {
    const r = resolveContinuation({
      todos: [todo('all done', 'completed')],
      suggestions: ['Run the type checker', 'Commit the changes'],
    });
    expect(r.source).toBe('suggestion');
    expect(r.text).toContain('Run the type checker');
    expect(r.text).not.toContain('Commit the changes');
  });

  it('ladder step 2: ignores blank suggestion entries', () => {
    const r = resolveContinuation({
      todos: [],
      suggestions: ['', '   ', 'Real suggestion'],
    });
    expect(r.source).toBe('suggestion');
    expect(r.text).toContain('Real suggestion');
  });

  it('ladder step 3: open continuation when nothing is queued — never dead-ends', () => {
    const r = resolveContinuation({ todos: [], suggestions: [] });
    expect(r.source).toBe('open');
    expect(r.text).toContain('decide the single most valuable next step');
    expect(r.text).toContain('do not fabricate busywork');
  });

  it('ladder step 3: open continuation with undefined inputs', () => {
    const r = resolveContinuation({});
    expect(r.source).toBe('open');
    expect(r.text.length).toBeGreaterThan(0);
    expect(r.label.length).toBeGreaterThan(0);
  });

  it('all completed todos count as no open todos → falls through the ladder', () => {
    const r = resolveContinuation({
      todos: [todo('x', 'completed'), todo('y', 'completed')],
      suggestions: [],
    });
    expect(r.source).toBe('open');
  });
});
