import { describe, expect, it } from 'vitest';
import { failedRunResumeDelayMs } from '../src/types/failed-run-resume.js';

describe('failedRunResumeDelayMs zero base delay', () => {
  it('returns 0 even for large attempt counts when baseMs is 0', () => {
    expect(failedRunResumeDelayMs(1, 15_000)).toBe(15_000);
    expect(failedRunResumeDelayMs(2000, 0)).toBe(0);
    expect(failedRunResumeDelayMs(10_000, 0)).toBe(0);
  });
});
