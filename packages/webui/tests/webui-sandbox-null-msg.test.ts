import { describe, expect, it } from 'vitest';
import { initialSandboxEventState, reduceSandboxEvent } from '../src/lib/sandbox-status';

describe('reduceSandboxEvent null message guard (F2306)', () => {
  it('returns existing state without throwing when msg is null', () => {
    const init = initialSandboxEventState();
    expect(reduceSandboxEvent(init, null as never)).toBe(init);
  });
});
