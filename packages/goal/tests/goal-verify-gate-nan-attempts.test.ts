import { describe, expect, it } from 'vitest';
import { runPhaseVerifyGate } from '../src/phase-orchestrator-gates.js';

describe('runPhaseVerifyGate maxVerifyAttempts sanitization', () => {
  it('still runs the initial verification pass when maxVerifyAttempts is NaN or negative', async () => {
    let calls = 0;
    const int = {
      ctx: {
        verifyPhase: async () => {
          calls++;
          return { ok: true };
        },
      },
      phaseWorktrees: new Map(),
      emit: () => {},
    } as never;
    const phase = { id: 'p1', name: 'Phase 1', metadata: {} } as never;

    const res = await runPhaseVerifyGate(int, phase, Number.NaN, () => false);
    expect(calls).toBe(1);
    expect(res.ok).toBe(true);
  });
});
