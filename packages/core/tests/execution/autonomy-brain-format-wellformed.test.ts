import type { BrainDecision, BrainDecisionRequest } from '@wrongstack/contracts/types/brain';
import { describe, expect, it } from 'vitest';
import { formatDecisionSummary } from '../../src/execution/autonomy-brain.js';

const ROCKET = '\u{1F680}';

function request(question: string): BrainDecisionRequest {
  return {
    id: 'b1',
    source: 'supervisor',
    question,
    risk: 'low',
    fallback: 'deny',
  } as unknown as BrainDecisionRequest;
}

/**
 * F2648: the chat-history one-liner caps the brain question at 77 and the
 * decision text at 57 UTF-16 units with a plain `.slice`. Both carry
 * model-authored text.
 */
describe('brain decision summary keeps valid UTF-16 (F2648)', () => {
  it('drops the orphaned half in the question', () => {
    const out = formatDecisionSummary(
      { type: 'deny', reason: 'unsafe' } as BrainDecision,
      request(`${'q'.repeat(76)}${ROCKET}tail`),
    );

    expect(out.isWellFormed()).toBe(true);
    expect(out).toContain('q'.repeat(76));
  });

  it('drops the orphaned half in the decision text', () => {
    const out = formatDecisionSummary(
      { type: 'answer', text: `${'t'.repeat(56)}${ROCKET}tail` } as BrainDecision,
      request('plain?'),
    );

    expect(out.isWellFormed()).toBe(true);
  });

  it('keeps a short exchange unchanged (control)', () => {
    const out = formatDecisionSummary(
      { type: 'deny', reason: 'unsafe' } as BrainDecision,
      request('plain?'),
    );

    expect(out.isWellFormed()).toBe(true);
    expect(out).toContain('plain?');
  });
});
