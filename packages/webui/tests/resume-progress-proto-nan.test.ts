import { describe, expect, it } from 'vitest';
import {
  formatResumeBytes,
  resumeProgressPercent,
  resumeStageLabel,
} from '../src/stores/resume-progress-store';

describe('resume-progress-store prototype and non-finite guards', () => {
  it('handles inherited prototype keys and non-finite byte counts safely', () => {
    expect(resumeStageLabel('toString')).toBe('toString');
    expect(
      resumeProgressPercent({ stage: 's', loadedBytes: Number.NaN, totalBytes: 100, updatedAt: 0 }),
    ).toBeNull();
    expect(formatResumeBytes(Number.NaN)).toBe('0 B');
    expect(formatResumeBytes(-5)).toBe('0 B');
  });
});
