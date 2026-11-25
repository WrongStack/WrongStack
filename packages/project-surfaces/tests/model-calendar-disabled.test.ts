import type { ModelBlackoutRule } from '@wrongstack/contracts/types/model-availability';
import { describe, expect, it } from 'vitest';
import { isCalendarRuleBlocking } from '../src/lib/model-calendar';

describe('isCalendarRuleBlocking disabled allow_only guard', () => {
  it('never blocks when a rule is disabled or invalid, even in allow_only mode', () => {
    const at = new Date('2026-06-01T12:00:00Z');
    const disabledAllowOnly: ModelBlackoutRule = {
      id: 'r1',
      enabled: false,
      mode: 'allow_only',
      start: '09:00',
      end: '17:00',
      timezone: 'UTC',
    };
    expect(isCalendarRuleBlocking(disabledAllowOnly, at)).toBe(false);

    const activeAllowOnlyOutside: ModelBlackoutRule = {
      id: 'r2',
      enabled: true,
      mode: 'allow_only',
      start: '13:00',
      end: '17:00',
      timezone: 'UTC',
    };
    expect(isCalendarRuleBlocking(activeAllowOnlyOutside, at)).toBe(true);
  });
});
