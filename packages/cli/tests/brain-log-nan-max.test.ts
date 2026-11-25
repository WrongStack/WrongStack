import { describe, expect, it } from 'vitest';
import { subscribeBrainDecisionLog } from '../src/boot/brain-decision-log.js';

describe('subscribeBrainDecisionLog maxEntries guard (F2222)', () => {
  it('falls back to the default 20-entry cap when getMaxEntries returns NaN or < 1', () => {
    const events = { on: () => {}, off: () => {} };
    const { brainLog, pushBrainLog, dispose } = subscribeBrainDecisionLog(events, () => Number.NaN);
    for (let i = 0; i < 30; i++) {
      pushBrainLog({ at: i, kind: 'answered', question: `q${i}`, outcome: 'ok' });
    }
    dispose();
    expect(brainLog).toHaveLength(20);
  });
});
