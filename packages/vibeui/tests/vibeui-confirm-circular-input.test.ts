import { describe, expect, it } from 'vitest';
import { interactionReducers } from '../src/lib/reducers/interactions';

describe('interactionReducers["tool.confirm_needed"] circular input guard (F2277)', () => {
  it('falls back to empty string instead of throwing on circular input', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const state = { confirm: null, confirmQueue: [], inputs: [] } as never;
    const next = interactionReducers['tool.confirm_needed']!(
      state,
      { id: 'c1', toolName: 'bash', input: circular, deadlineAt: 1000 },
      { type: 'tool.confirm_needed' } as never,
    );
    expect(next.confirm?.id).toBe('c1');
    expect(next.confirm?.input).toBe('');
  });
});
