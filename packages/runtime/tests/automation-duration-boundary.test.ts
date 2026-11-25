import { expect, it } from 'vitest';
import { buildAutomationResult } from '../src/automation/result.js';

it('normalizes non-finite automation durations to zero', () => {
  const output = JSON.stringify({ status: 'done' });
  expect(buildAutomationResult(output, null, Number.NaN).durationMs).toBe(0);
  expect(buildAutomationResult(output, null, Number.POSITIVE_INFINITY).durationMs).toBe(0);
});
