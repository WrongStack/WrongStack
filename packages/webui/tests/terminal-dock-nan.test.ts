import { describe, expect, it } from 'vitest';
import { clampTerminalHeight, MIN_TERMINAL_HEIGHT } from '../src/lib/terminal-dock';

describe('clampTerminalHeight non-finite guard', () => {
  it('falls back to MIN_TERMINAL_HEIGHT when height is NaN', () => {
    expect(clampTerminalHeight(Number.NaN)).toBe(MIN_TERMINAL_HEIGHT);
  });
});
