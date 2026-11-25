import { describe, expect, it } from 'vitest';
import { buildSubagentFinishNotice } from '../src/subagent-finish.js';

describe('buildSubagentFinishNotice non-finite timing guards', () => {
  it('handles NaN deadlineMs and graceMs without throwing or emitting NaN', () => {
    const notice = buildSubagentFinishNotice({
      reason: 'done',
      deadlineMs: Number.NaN,
      graceMs: Number.NaN,
    });
    expect(notice).not.toContain('NaN');
    expect(notice).toContain('finish now');
  });
});
