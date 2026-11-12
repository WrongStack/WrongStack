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

  it('matches the longest listed phrase (five words) despite the word-count guard', () => {
    for (const s of [
      'bir tur daha at bakalım',
      'bir tur daha at bakalim',
      'Bir tur daha at bakalım!',
      'bir tur daha at bakalım lütfen',
    ]) {
      expect(detectContinueIntent(s), s).toBe(true);
    }
    // The guard still rejects longer, substantive messages.
    expect(detectContinueIntent('bir tur daha at bakalım testlerle')).toBe(false);
    expect(detectContinueIntent('keep going and then stop now')).toBe(false);
  });

  it('strips a trailing politeness token', () => {
    expect(detectContinueIntent('continue please')).toBe(true);
    expect(detectContinueIntent('go on pls')).toBe(true);
    expect(detectContinueIntent('proceed thanks')).toBe(true);
  });

  it('strips a LEADING politeness token, not just a trailing one', () => {
    // Same tokens as the trailing case above, opposite word order. Politeness
    // is noise wherever it sits: the phrase set already accepts leading
    // acknowledgements ('yes continue', 'ok continue', 'and continue'), so a
    // leading 'please'/'pls'/'thanks' must not change the classification.
    expect(detectContinueIntent('please continue')).toBe(true);
    expect(detectContinueIntent('pls go on')).toBe(true);
    expect(detectContinueIntent('thanks proceed')).toBe(true);
    expect(detectContinueIntent('please keep going')).toBe(true);
    // Turkish politeness token, with and without the folded diacritic.
    expect(detectContinueIntent('lutfen devam et')).toBe(true);
    expect(detectContinueIntent('lütfen devam et')).toBe(true);
    // Politeness on both ends collapses to the bare phrase.
    expect(detectContinueIntent('please continue thanks')).toBe(true);
  });

  it('keeps substantive prompts ordinary when a leading token is stripped', () => {
    // Stripping politeness must not turn a real instruction into a nudge:
    // exact matching still has to reject anything carrying extra substance.
    for (const s of [
      'please continue with the auth refactor',
      'thanks can you continue the story about dragons',
      'pls keep going until the build passes then stop',
      'please next.js config',
    ]) {
      expect(detectContinueIntent(s), s).toBe(false);
    }
    // Bare politeness is still not a continue, in either position.
    expect(detectContinueIntent('please')).toBe(false);
    expect(detectContinueIntent('thanks')).toBe(false);
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
