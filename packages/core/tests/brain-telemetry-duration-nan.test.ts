import type { EventBus } from '@wrongstack/contracts/kernel/events';
import type { BrainDecisionRequest } from '@wrongstack/contracts/types/brain';
import { describe, expect, it } from 'vitest';
import { emitBrainTierTransition } from '../src/brain/brain-telemetry.js';

describe('emitBrainTierTransition (F2162)', () => {
  it('emits finite durationMs=0 when startedAt is non-finite', () => {
    const emitted: Array<{ durationMs: number }> = [];
    const events = {
      emit(_name: string, payload: { durationMs: number }) {
        emitted.push(payload);
      },
    } as unknown as EventBus;
    const req = { id: 'req-1', sessionId: 'sess-1' } as unknown as BrainDecisionRequest;

    emitBrainTierTransition(events, req, 'policy', 'answer', true, Number.NaN);
    emitBrainTierTransition(events, req, 'policy', 'answer', true, Number.POSITIVE_INFINITY);
    emitBrainTierTransition(events, req, 'policy', 'answer', true, Date.now() - 15);

    expect(emitted[0]?.durationMs).toBe(0);
    expect(emitted[1]?.durationMs).toBe(0);
    expect(Number.isFinite(emitted[2]?.durationMs)).toBe(true);
    expect((emitted[2]?.durationMs ?? -1) >= 0).toBe(true);
  });
});
