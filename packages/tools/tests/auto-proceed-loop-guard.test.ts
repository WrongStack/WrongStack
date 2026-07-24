import { describe, expect, it } from 'vitest';
import {
  createAutoProceedLoopGuard,
  GROUNDED_NO_PROGRESS_STEER,
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
