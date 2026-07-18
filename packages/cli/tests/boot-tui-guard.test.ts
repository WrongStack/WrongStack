import { describe, expect, it } from 'vitest';
import { shouldRejectNonInteractiveTui } from '../src/boot.js';

describe('explicit TUI terminal guard', () => {
  it.each([
    ['piped stdin', true, false, true, true],
    ['redirected stdout', true, true, false, true],
    ['both streams redirected', true, false, false, true],
    ['interactive streams', true, true, true, false],
    ['non-TUI invocation', false, false, false, false],
  ] as const)('%s', (_label, tui, stdinIsTty, stdoutIsTty, expected) => {
    expect(shouldRejectNonInteractiveTui({ tui }, stdinIsTty, stdoutIsTty)).toBe(expected);
  });
});
