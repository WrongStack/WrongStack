import { describe, expect, it } from 'vitest';
import { addToolActivity, emptyActivityTotals } from '../src/agent-status-helpers.js';

describe('addToolActivity line count sanitization (F1977)', () => {
  it('ignores NaN and negative line counts', () => {
    const base = addToolActivity(emptyActivityTotals(), {
      id: '1',
      name: 'read_file',
      startedAt: 0,
      completedAt: 10,
      durationMs: 10,
      ok: true,
      outputLines: 25,
    });
    const afterNan = addToolActivity(base, {
      id: '2',
      name: 'read_file',
      startedAt: 10,
      completedAt: 20,
      durationMs: 10,
      ok: true,
      outputLines: Number.NaN,
    });
    const afterNeg = addToolActivity(afterNan, {
      id: '3',
      name: 'read_file',
      startedAt: 20,
      completedAt: 30,
      durationMs: 10,
      ok: true,
      outputLines: -10,
    });
    expect(afterNeg.linesRead).toBe(25);
  });
});
