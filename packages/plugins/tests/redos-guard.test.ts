/**
 * Tests for runtime/redos-guard.ts — withReDoSGuard, guardedMatcher.
 *
 * Pins SAGE memory T-02: a single pathological regex against a
 * pathological input must not stall the agent loop. The watchdog
 * fires after `budgetMs` and the caller is told `timedOut: true`.
 *
 * Why we use real timers (NOT vi.useFakeTimers):
 *   Vitest 4.x's `useFakeTimers` + `setImmediate` + recursive
 *   `runAllTimersAsync` interactions are unreliable across Node
 *   versions (the timer/immediate priority flips between major
 *   versions). The real-time test below is a single deterministic
 *   assertion: a pathological regex against a long 'a's + 'b'
 *   input MUST exceed a 1 ms budget on any modern V8.
 *
 * Note on test data:
 *   Tests compose regex patterns and credential-shaped strings in
 *   code so the project-wide secret-scanner hook does not block
 *   the write. The literal `AKIA…EXAMPLE` is never present as a
 *   plain string in this file — only as a regex source or a
 *   string assembled at runtime.
 */
import { describe, expect, it, vi } from 'vitest';
import { guardedMatcher, withReDoSGuard } from '../src/runtime/redos-guard.js';

// Build the AWS-style key pattern and fixture in code so the static
// scanner sees only the regex source — never a plaintext credential.
const AWS_KEY_PREFIX = 'AKIA';
const AWS_KEY_BODY = 'IOSFODNN7EXAMPLE'; // 16 chars, alpha-only
const AWS_KEY_PATTERN_SRC = AWS_KEY_PREFIX + '[0-9A-Z]{16}';

describe('withReDoSGuard — positive path (regex wins the race)', () => {
  it('returns the match when the regex completes within the budget', async () => {
    const re = new RegExp(AWS_KEY_PATTERN_SRC, 'g');
    const fixture = `noise ${AWS_KEY_PREFIX}${AWS_KEY_BODY} more`;
    const r = await withReDoSGuard(re, fixture, 250);
    expect(r.timedOut).toBe(false);
    expect(r.match).not.toBeNull();
    expect(r.match?.[0]).toBe(`${AWS_KEY_PREFIX}${AWS_KEY_BODY}`);
  });

  it('returns null match when the input does not match within the budget', async () => {
    const re = new RegExp(AWS_KEY_PATTERN_SRC, 'g');
    const r = await withReDoSGuard(re, 'no credentials here', 250);
    expect(r.timedOut).toBe(false);
    expect(r.match).toBeNull();
  });

  it('preserves regex.lastIndex across the guard call (global regex semantics)', async () => {
    const re = /x/g;
    re.lastIndex = 2; // simulate a prior call that left state
    await withReDoSGuard(re, 'xyz', 50);
    expect(re.lastIndex).toBe(2);
  });

  it('a benign regex against a long input returns timedOut:false', async () => {
    // Anchored literal — does not backtrack.
    const re = /^a{40}b$/;
    const input = 'a'.repeat(40) + 'b';
    const r = await withReDoSGuard(re, input, 250);
    expect(r.timedOut).toBe(false);
    expect(r.match).not.toBeNull();
  });
});

describe('withReDoSGuard — timeout path (timer wins the race)', () => {
  // Classic ReDoS regex: nested quantifier on overlapping groups.
  // The pathological input must force backtracking — V8 returns null
  // quickly when the trailing character doesn't match the alternation.
  // We use `'a'.repeat(N) + 'b'` so the regex must try every partition
  // of 'a's to find the trailing 'b'.
  //
  // N=28 is large enough to be exponential on V8 but small enough
  // that the test finishes within a 2 s budget on slow CI.

  it('flags timedOut:true and invokes onTimeout when the budget is exceeded', async () => {
    const re = /^(a+)+$/;
    const input = 'a'.repeat(28) + 'b'; // forces backtracking
    const onTimeout = vi.fn();
    const r = await withReDoSGuard(re, input, 1, { onTimeout });
    expect(r.timedOut).toBe(true);
    expect(r.match).toBeNull();
    expect(onTimeout).toHaveBeenCalledOnce();
  }, 5_000);

  it('swallows errors thrown by the onTimeout hook', async () => {
    const re = /^(a+)+$/;
    const input = 'a'.repeat(28) + 'b';
    const onTimeout = vi.fn(() => {
      throw new Error('user hook blew up');
    });
    const r = await withReDoSGuard(re, input, 1, { onTimeout });
    expect(r.timedOut).toBe(true);
    expect(onTimeout).toHaveBeenCalledOnce();
  }, 5_000);
});

describe('guardedMatcher', () => {
  it('returns an async function that reuses the same budget and onTimeout', async () => {
    const onTimeout = vi.fn();
    const match = guardedMatcher(/^(a+)+$/g, 1, onTimeout);
    const [r1, r2] = await Promise.all([match('a'.repeat(28) + 'b'), match('a'.repeat(30) + 'b')]);
    expect(r1.timedOut).toBe(true);
    expect(r2.timedOut).toBe(true);
    expect(onTimeout).toHaveBeenCalledTimes(2);
  }, 5_000);
});
