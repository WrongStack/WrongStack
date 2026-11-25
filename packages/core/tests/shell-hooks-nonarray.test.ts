import type { ConfiguredHook, HookEvent } from '@wrongstack/contracts/types/hooks';
import { describe, expect, it } from 'vitest';
import { countShellHooks } from '../src/hooks/shell-hooks-equal.js';

describe('countShellHooks malformed non-array guard (F2006)', () => {
  it('skips non-array event entries without throwing', () => {
    expect(
      countShellHooks({
        PreToolUse: [{ command: 'echo 1' }],
      } as unknown as Partial<Record<HookEvent, ConfiguredHook[]>>),
    ).toBe(1);
    expect(
      countShellHooks({
        PreToolUse: { command: 'bad' },
      } as unknown as Partial<Record<HookEvent, ConfiguredHook[]>>),
    ).toBe(0);
  });
});
