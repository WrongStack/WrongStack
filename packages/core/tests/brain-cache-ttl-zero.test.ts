import type { BrainDecisionRequest } from '@wrongstack/contracts/types/brain';
import { describe, expect, it } from 'vitest';
import { BrainDecisionCache } from '../src/brain/brain-cache.js';

describe('BrainDecisionCache (F2177)', () => {
  it('clamps positive sub-millisecond ttlMs to at least 1ms', () => {
    let now = 1000;
    const cache = new BrainDecisionCache({ enabled: true, ttlMs: 0.5, now: () => now });
    const req = {
      id: 'r1',
      sessionId: 's1',
      source: 'test',
      question: 'continue?',
      risk: 'low',
      fallback: 'continue',
      allowHumanEscalation: false,
    } as unknown as BrainDecisionRequest;
    cache.set(req, { type: 'answer', text: 'yes', rationale: 'ok' }, 'llm');

    now = 1000.5;
    expect(cache.peek(req)).toBeDefined();
    now = 1002;
    expect(cache.peek(req)).toBeUndefined();
  });
});
