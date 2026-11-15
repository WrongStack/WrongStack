import { describe, expect, it } from 'vitest';
import { withReDoSGuard } from '../src/runtime/redos-guard.js';

describe('withReDoSGuard', () => {
  it('chunks 32-bit timer budgets above 2_147_483_647ms without immediate timeout', async () => {
    const res = await withReDoSGuard(/a/, 'a', 2_147_483_648);
    expect(res.timedOut).toBe(false);
    expect(res.match?.[0]).toBe('a');
  });
});
