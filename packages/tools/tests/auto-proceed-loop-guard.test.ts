import { describe, expect, it } from 'vitest';
import {
  createAutoProceedLoopGuard,
  createContinuationAttemptTracker,
  generateAdvancementPrompt,
  GROUNDED_NO_PROGRESS_STEER,
  matchTodoIdFromPrompt,
  MAX_ADVANCEMENT_ATTEMPTS,
  normalizeForRepetition,
} from '../src/auto-proceed-loop-guard.js';

describe('normalizeForRepetition', () => {
  it('collapses whitespace runs to a single space', () => {
    expect(normalizeForRepetition('foo   bar\n\tbaz')).toBe('foo bar baz');
  });

  it('trims leading and trailing whitespace', () => {
    expect(normalizeForRepetition('  hello  ')).toBe('hello');
  });

  it('is case-insensitive', () => {
    expect(normalizeForRepetition('Run Tests')).toBe(normalizeForRepetition('run tests'));
  });

  it('preserves meaningful content (different words stay different)', () => {
    expect(normalizeForRepetition('Run tests')).not.toBe(normalizeForRepetition('Run tests now'));
    expect(normalizeForRepetition('Commit the change')).not.toBe(
      normalizeForRepetition('Commit the changes'),
    );
  });
});

describe('createAutoProceedLoopGuard — defaults', () => {
  it('returns no halt on the first feed', () => {
    const guard = createAutoProceedLoopGuard();
    const signal = guard.record('Run the smoke test');
    expect(signal.shouldHalt).toBe(false);
    expect(signal.runLength).toBe(1);
    expect(signal.normalized).toBe('run the smoke test');
  });

  it('returns no halt when feeds are different', () => {
    const guard = createAutoProceedLoopGuard();
    expect(guard.record('Run tests').shouldHalt).toBe(false);
    expect(guard.record('Commit').shouldHalt).toBe(false);
    expect(guard.record('Push').shouldHalt).toBe(false);
  });

  it('halts on the second identical feed (repeatThreshold default = 2)', () => {
    const guard = createAutoProceedLoopGuard();
    expect(guard.record('Run tests').shouldHalt).toBe(false);
    // Second identical feed -> runLength = 2 -> shouldHalt = true
    expect(guard.record('Run tests').shouldHalt).toBe(true);
  });

  it('continues to report halt on subsequent identical feeds', () => {
    const guard = createAutoProceedLoopGuard();
    guard.record('Run tests');
    expect(guard.record('Run tests').shouldHalt).toBe(true);
    expect(guard.record('Run tests').shouldHalt).toBe(true);
  });

  it('treats whitespace- and case-only differences as identical', () => {
    const guard = createAutoProceedLoopGuard();
    guard.record('Run the smoke test');
    // Identical after normalization.
    expect(guard.record('  RUN the smoke test  ').shouldHalt).toBe(true);
  });

  it('does not collapse legitimately different prompts', () => {
    const guard = createAutoProceedLoopGuard();
    guard.record('Run the smoke test');
    // Single word added — different prompt, must not be collapsed.
    expect(guard.record('Run the smoke test now').shouldHalt).toBe(false);
  });

  it('does not halt when a different prompt breaks the identical run', () => {
    const guard = createAutoProceedLoopGuard();
    guard.record('Run tests');
    guard.record('Run tests'); // runLength = 2, halted (not fed)
    expect(guard.record('Commit').shouldHalt).toBe(false);
    // New run starts; the previous "Run tests" pair is broken.
    expect(guard.record('Commit').runLength).toBe(2);
  });
});

describe('createAutoProceedLoopGuard — reset()', () => {
  it('clears the history', () => {
    const guard = createAutoProceedLoopGuard();
    guard.record('Run tests');
    guard.record('Run tests');
    expect(guard.size()).toBe(2);
    guard.reset();
    expect(guard.size()).toBe(0);
    expect(guard.history()).toEqual([]);
  });

  it('allows a fresh run after reset', () => {
    const guard = createAutoProceedLoopGuard();
    guard.record('Run tests');
    guard.record('Run tests'); // would halt
    guard.reset();
    expect(guard.record('Run tests').shouldHalt).toBe(false);
  });
});

describe('createAutoProceedLoopGuard — history() and size()', () => {
  it('exposes the recent normalized feeds newest-last', () => {
    const guard = createAutoProceedLoopGuard();
    guard.record('Run tests');
    guard.record('Commit');
    guard.record('Push');
    expect(guard.history()).toEqual(['run tests', 'commit', 'push']);
    expect(guard.size()).toBe(3);
  });

  it('trims the buffer to windowSize (default 3)', () => {
    const guard = createAutoProceedLoopGuard();
    guard.record('A');
    guard.record('B');
    guard.record('C');
    guard.record('D');
    expect(guard.size()).toBe(3);
    expect(guard.history()).toEqual(['b', 'c', 'd']);
  });

  it('history() returns a defensive copy — mutating it does not affect state', () => {
    const guard = createAutoProceedLoopGuard();
    guard.record('A');
    guard.record('B');
    const snapshot = guard.history();
    // Mutate the returned array in place.
    snapshot.push('MUTATED');
    snapshot[0] = 'OVERWRITTEN';
    // Subsequent calls must return the unmodified buffer.
    expect(guard.history()).toEqual(['a', 'b']);
    expect(guard.size()).toBe(2);
  });
});

describe('createAutoProceedLoopGuard — configuration', () => {
  it('honours a custom repeatThreshold', () => {
    const guard = createAutoProceedLoopGuard({ repeatThreshold: 3 });
    expect(guard.record('x').shouldHalt).toBe(false);
    expect(guard.record('x').shouldHalt).toBe(false);
    // Third identical feed crosses threshold=3.
    expect(guard.record('x').shouldHalt).toBe(true);
  });

  it('enforces repeatThreshold >= 2', () => {
    const guard = createAutoProceedLoopGuard({ repeatThreshold: 0 });
    expect(guard.record('x').shouldHalt).toBe(false);
    expect(guard.record('x').shouldHalt).toBe(true);
  });

  it('honours a custom windowSize larger than repeatThreshold', () => {
    const guard = createAutoProceedLoopGuard({ repeatThreshold: 2, windowSize: 5 });
    guard.record('A');
    guard.record('B');
    guard.record('A');
    guard.record('B');
    // Buffer state at this point: ['a','b','a','b'] — length 4 ≤ windowSize 5,
    // no trim. Last feed 'B' has run length 1.
    expect(guard.history()).toEqual(['a', 'b', 'a', 'b']);
    expect(guard.record('B').runLength).toBe(2);
    expect(guard.record('B').shouldHalt).toBe(true);
  });

  it('enforces windowSize >= repeatThreshold', () => {
    // Pass windowSize smaller than threshold — guard should clamp to threshold.
    const guard = createAutoProceedLoopGuard({ repeatThreshold: 4, windowSize: 1 });
    expect(guard.record('x').shouldHalt).toBe(false);
    expect(guard.record('x').shouldHalt).toBe(false);
    expect(guard.record('x').shouldHalt).toBe(false);
    expect(guard.record('x').shouldHalt).toBe(true);
  });

  it('falls back to defaults for non-finite options (NaN, Infinity)', () => {
    // Non-finite values must NOT silently disable the guard.
    // `repeatThreshold: NaN` previously made `shouldHalt` permanently false.
    // `windowSize: NaN` / `Infinity` previously left the buffer unbounded.
    const guardNaN = createAutoProceedLoopGuard({
      repeatThreshold: Number.NaN,
      windowSize: Number.NaN,
    });
    // Default threshold = 2, default window = 3.
    expect(guardNaN.record('x').shouldHalt).toBe(false);
    expect(guardNaN.record('x').shouldHalt).toBe(true);

    const guardInf = createAutoProceedLoopGuard({
      repeatThreshold: Number.POSITIVE_INFINITY,
      windowSize: Number.POSITIVE_INFINITY,
    });
    expect(guardInf.record('y').shouldHalt).toBe(false);
    expect(guardInf.record('y').shouldHalt).toBe(true);
    for (let i = 0; i < 100; i++) guardInf.record(`unique-${i}`);
    expect(guardInf.size()).toBe(3);
    expect(guardInf.history()).toEqual(['unique-97', 'unique-98', 'unique-99']);

    const guardNeg = createAutoProceedLoopGuard({
      repeatThreshold: Number.NEGATIVE_INFINITY,
      windowSize: Number.NEGATIVE_INFINITY,
    });
    expect(guardNeg.record('z').shouldHalt).toBe(false);
    expect(guardNeg.record('z').shouldHalt).toBe(true);
  });
});

describe('createAutoProceedLoopGuard — the user-reported scenario', () => {
  // Reproduces the symptom the user described: receiving the same prompt
  // 2–3 times in a row enters a loop. Default settings catch the first
  // identical re-feed; once the guard halts, the caller is expected to stop
  // feeding and surface a prompt.
  it('catches a repeated prompt on the first identical re-feed', () => {
    const guard = createAutoProceedLoopGuard();
    expect(guard.record('Investigate the failing tests').shouldHalt).toBe(false);
    // Second identical feed -> runLength = 2 -> shouldHalt = true.
    expect(guard.record('Investigate the failing tests').shouldHalt).toBe(true);
    // The caller is required to NOT feed this third time. If it does anyway,
    // the guard stays halted and the buffer holds all three recorded entries
    // (push happens before trim, so length 3 ≤ default windowSize 3).
    expect(guard.record('Investigate the failing tests').shouldHalt).toBe(true);
    expect(guard.history()).toEqual([
      'investigate the failing tests',
      'investigate the failing tests',
      'investigate the failing tests',
    ]);
  });
});

describe('createAutoProceedLoopGuard — grounded (todo-sourced) prompts', () => {
  // Grounded prompts are synthesized from the durable todo board, so an
  // identical re-feed means "the whole previous turn moved nothing on the
  // board" — usually a model that worked but forgot to update it. The guard
  // steers once (caller appends GROUNDED_NO_PROGRESS_STEER) and only halts
  // when the board stays frozen after the steer.
  it('feed → steer → halt on a frozen board', () => {
    const guard = createAutoProceedLoopGuard();
    const first = guard.recordGrounded('Continue with the plan: todo X');
    expect(first.action).toBe('feed');
    expect(first.shouldHalt).toBe(false);

    const second = guard.recordGrounded('Continue with the plan: todo X');
    expect(second.action).toBe('steer');
    expect(second.shouldHalt).toBe(false);

    const third = guard.recordGrounded('Continue with the plan: todo X');
    expect(third.action).toBe('halt');
    expect(third.shouldHalt).toBe(true);
  });

  it('board progress (a different prompt) clears the steer state', () => {
    const guard = createAutoProceedLoopGuard();
    guard.recordGrounded('Continue: todo X');
    expect(guard.recordGrounded('Continue: todo X').action).toBe('steer');
    // The steer worked — the board moved, so the next continuation differs.
    expect(guard.recordGrounded('Continue: todo Y').action).toBe('feed');
    // A later stall on Y gets its own steer before any halt.
    expect(guard.recordGrounded('Continue: todo Y').action).toBe('steer');
    expect(guard.recordGrounded('Continue: todo Y').action).toBe('halt');
  });

  it('reset() clears the steer state along with the history', () => {
    const guard = createAutoProceedLoopGuard();
    guard.recordGrounded('Continue: todo X');
    expect(guard.recordGrounded('Continue: todo X').action).toBe('steer');
    guard.reset();
    expect(guard.recordGrounded('Continue: todo X').action).toBe('feed');
    expect(guard.recordGrounded('Continue: todo X').action).toBe('steer');
  });

  it('exports a non-empty steer text that mentions the todo board', () => {
    expect(GROUNDED_NO_PROGRESS_STEER.length).toBeGreaterThan(0);
    expect(GROUNDED_NO_PROGRESS_STEER).toContain('todo board');
  });
});

describe('createContinuationAttemptTracker', () => {
  it('returns 0 for a never-recorded todo', () => {
    const tracker = createContinuationAttemptTracker();
    expect(tracker.getAttempts('a')).toBe(0);
  });

  it('recordAttempt increments and returns the new count (>= 1)', () => {
    const tracker = createContinuationAttemptTracker();
    expect(tracker.recordAttempt('a')).toBe(1);
    expect(tracker.recordAttempt('a')).toBe(2);
    expect(tracker.recordAttempt('a')).toBe(3);
  });

  it('getAttempts reflects recordAttempt results', () => {
    const tracker = createContinuationAttemptTracker();
    tracker.recordAttempt('a');
    tracker.recordAttempt('a');
    expect(tracker.getAttempts('a')).toBe(2);
  });

  it('tracks multiple todos independently', () => {
    const tracker = createContinuationAttemptTracker();
    tracker.recordAttempt('a');
    tracker.recordAttempt('b');
    tracker.recordAttempt('b');
    expect(tracker.getAttempts('a')).toBe(1);
    expect(tracker.getAttempts('b')).toBe(2);
  });

  it('markSkipped / isSkipped work as expected', () => {
    const tracker = createContinuationAttemptTracker();
    expect(tracker.isSkipped('a')).toBe(false);
    tracker.markSkipped('a');
    expect(tracker.isSkipped('a')).toBe(true);
    // idempotent
    tracker.markSkipped('a');
    expect(tracker.isSkipped('a')).toBe(true);
  });

  it('isSkipped is false for a never-marked todo', () => {
    const tracker = createContinuationAttemptTracker();
    expect(tracker.isSkipped('unknown')).toBe(false);
  });

  it('reset() clears both attempts and skipped state', () => {
    const tracker = createContinuationAttemptTracker();
    tracker.recordAttempt('a');
    tracker.recordAttempt('b');
    tracker.markSkipped('c');
    tracker.reset();
    expect(tracker.getAttempts('a')).toBe(0);
    expect(tracker.getAttempts('b')).toBe(0);
    expect(tracker.isSkipped('c')).toBe(false);
  });

  it('snapshot() includes attempts for recorded todos', () => {
    const tracker = createContinuationAttemptTracker();
    tracker.recordAttempt('a');
    tracker.recordAttempt('a');
    tracker.recordAttempt('b');
    const snap = tracker.snapshot();
    expect(snap['a']).toEqual({ attempts: 2, skipped: false });
    expect(snap['b']).toEqual({ attempts: 1, skipped: false });
  });

  it('snapshot() includes todos that were markSkipped without a prior recordAttempt', () => {
    const tracker = createContinuationAttemptTracker();
    tracker.markSkipped('skipped-only');
    const snap = tracker.snapshot();
    expect(snap['skipped-only']).toEqual({ attempts: 0, skipped: true });
  });

  it('snapshot() reflects skipped status on recorded todos', () => {
    const tracker = createContinuationAttemptTracker();
    tracker.recordAttempt('a');
    tracker.markSkipped('a');
    const snap = tracker.snapshot();
    expect(snap['a']).toEqual({ attempts: 1, skipped: true });
  });

  it('snapshot() returns a detached object — mutating it does not affect state', () => {
    const tracker = createContinuationAttemptTracker();
    tracker.recordAttempt('a');
    const snap = tracker.snapshot();
    snap['a'].attempts = 999;
    snap['injected'] = { attempts: 5, skipped: true };
    // The tracker is unaffected.
    expect(tracker.getAttempts('a')).toBe(1);
    expect(tracker.snapshot()['injected']).toBeUndefined();
  });
});

describe('generateAdvancementPrompt', () => {
  const stalledTodo = { id: 'stalled-1', content: 'Fix the login bug' };

  it('returns a no-more-items prompt when nextTodo is null', () => {
    const result = generateAdvancementPrompt(stalledTodo, null, 1, []);
    expect(result).toContain('No more open items remain');
  });

  it('includes the stalled attempt count in the preamble', () => {
    const result = generateAdvancementPrompt(stalledTodo, null, 3, []);
    expect(result).toContain('3 attempt');
  });

  it('does not crash when attemptCount is 0 (defense-in-depth)', () => {
    expect(() => generateAdvancementPrompt(stalledTodo, null, 0, [])).not.toThrow();
    const result = generateAdvancementPrompt(stalledTodo, null, 0, []);
    // idx is clamped to 0, so preamble is the first one with attempts="0".
    expect(result).toContain('0 attempt');
  });

  it('rotates the preamble across attempt counts', () => {
    const r1 = generateAdvancementPrompt(stalledTodo, null, 1, []);
    const r2 = generateAdvancementPrompt(stalledTodo, null, 2, []);
    // Different preambles -> different output.
    expect(r1).not.toBe(r2);
  });

  it('clamps attemptCount beyond the preamble pool length', () => {
    // Pool has 8 entries. attemptCount = 99 should not throw or produce garbage.
    expect(() => generateAdvancementPrompt(stalledTodo, null, 99, [])).not.toThrow();
    const result = generateAdvancementPrompt(stalledTodo, null, 99, []);
    // The last preamble uses "continuation(s)" phrasing — match that.
    expect(result).toContain('99 continuation');
  });

  it('includes the next todo content in the output', () => {
    const nextTodo = { id: 'next-1', content: 'Write unit tests', status: 'pending' };
    const result = generateAdvancementPrompt(stalledTodo, nextTodo, 1, [nextTodo]);
    expect(result).toContain('Write unit tests');
    expect(result).toContain('Proceed with:');
  });

  it('prefers activeForm for in_progress nextTodo', () => {
    const nextTodo = {
      id: 'next-1',
      content: 'Write unit tests',
      status: 'in_progress',
      activeForm: 'Writing unit tests',
    };
    const result = generateAdvancementPrompt(stalledTodo, nextTodo, 1, [nextTodo]);
    expect(result).toContain('Writing unit tests');
  });

  it('renders the todo board with status marks', () => {
    const todos = [
      { id: '1', content: 'Done task', status: 'completed' },
      { id: '2', content: 'In progress task', status: 'in_progress' },
      { id: '3', content: 'Pending task', status: 'pending' },
    ];
    const result = generateAdvancementPrompt(stalledTodo, todos[2]!, 1, todos);
    expect(result).toContain('Todo board (1/3 done)');
    expect(result).toContain('[x] Done task');
    expect(result).toContain('[~] In progress task');
    expect(result).toContain('[ ] Pending task');
  });

  it('omits the Todo board line when todos is empty', () => {
    const nextTodo = { id: 'next-1', content: 'Do something', status: 'pending' };
    const result = generateAdvancementPrompt(stalledTodo, nextTodo, 1, []);
    expect(result).not.toContain('Todo board');
  });

  it('correctly substitutes stalledTodo.content even when it contains dollar-sign patterns', () => {
    // Dollar-ampersand and dollar-backtick in a string replacement would expand
    // to the matched text / preceding text, corrupting the prompt. The
    // replacer-function fix ensures literal insertion.
    const special = String.fromCharCode(0x24, 0x26); // "$&"
    const backtick = String.fromCharCode(0x24, 0x60); // dollar + backtick
    const specialTodo = { id: 's1', content: 'Fix ' + special + ' and ' + backtick + ' in template' };
    const result = generateAdvancementPrompt(specialTodo, null, 2, []);
    // The label should appear literally, not expanded.
    expect(result).toContain(special);
    expect(result).toContain(backtick);
    // It should NOT contain an expanded version where the pattern becomes {label}.
    expect(result).not.toContain('{label}');
  });

  it('truncates stalledTodo content to 72 characters in the label', () => {
    const long = 'x'.repeat(100);
    const longTodo = { id: 's1', content: long };
    const result = generateAdvancementPrompt(longTodo, null, 2, []);
    // Label should be truncated to 72 chars.
    expect(result).toContain('x'.repeat(72));
    expect(result).not.toContain('x'.repeat(73));
  });
});

describe('matchTodoIdFromPrompt', () => {
  it('returns null for an empty todos array', () => {
    expect(matchTodoIdFromPrompt([], 'some prompt')).toBeNull();
  });

  it('returns null for an empty prompt', () => {
    const todos = [{ id: 't1', content: 'Task', status: 'pending' }];
    expect(matchTodoIdFromPrompt(todos, '')).toBeNull();
  });

  it('matches the in-progress todo by content', () => {
    const todos = [
      { id: 't1', content: 'Fix login', status: 'in_progress' },
      { id: 't2', content: 'Write docs', status: 'pending' },
    ];
    const result = matchTodoIdFromPrompt(todos, 'Current todo board:\n  [~] Fix login\n  [ ] Write docs');
    expect(result).not.toBeNull();
    expect(result!.id).toBe('t1');
    expect(result!.content.length).toBeGreaterThan(0);
  });

  it('prefers activeForm for in-progress matching', () => {
    const todos = [
      { id: 't1', content: 'Fix login', status: 'in_progress', activeForm: 'Fixing the login bug' },
    ];
    const result = matchTodoIdFromPrompt(todos, 'Continue with plan: Fixing the login bug');
    expect(result).not.toBeNull();
    expect(result!.id).toBe('t1');
    expect(result!.content).toBe('Fixing the login bug');
  });

  it('falls back to pending todo if no in-progress matches', () => {
    const todos = [
      { id: 't1', content: 'Task A', status: 'completed' },
      { id: 't2', content: 'Task B', status: 'pending' },
      { id: 't3', content: 'Task C', status: 'pending' },
    ];
    const result = matchTodoIdFromPrompt(todos, 'Board:\n  [ ] Task C');
    expect(result).not.toBeNull();
    expect(result!.id).toBe('t3');
  });

  it('last resort returns the first non-completed todo', () => {
    const todos = [
      { id: 't1', content: 'Obscure task ßpecial', status: 'pending' },
    ];
    // Content "obscure task" is not in the prompt, so content-match fails.
    const result = matchTodoIdFromPrompt(todos, 'Nothing matches exactly');
    expect(result).not.toBeNull();
    expect(result!.id).toBe('t1');
  });

  it('returns null when all todos are completed', () => {
    const todos = [
      { id: 't1', content: 'Done', status: 'completed' },
    ];
    expect(matchTodoIdFromPrompt(todos, 'Board: [x] Done')).toBeNull();
  });

  it('skips completed todos during content matching', () => {
    const todos = [
      { id: 't1', content: 'Done task', status: 'completed' },
      { id: 't2', content: 'Pending task', status: 'pending' },
    ];
    const result = matchTodoIdFromPrompt(todos, 'should match Pending task');
    expect(result).not.toBeNull();
    expect(result!.id).toBe('t2');
  });
});

describe('MAX_ADVANCEMENT_ATTEMPTS', () => {
  it('is a positive integer', () => {
    expect(MAX_ADVANCEMENT_ATTEMPTS).toBeGreaterThan(0);
    expect(Number.isInteger(MAX_ADVANCEMENT_ATTEMPTS)).toBe(true);
  });
});
