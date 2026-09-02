import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractSageBlock } from '../../src/lib/sage-block';
import {
  CALENDAR_DAYS,
  blockingCalendarRules,
  isCalendarRuleActive,
  isCalendarRuleValid,
} from '../../src/lib/model-calendar';
import { cn, safeId } from '../../src/lib/utils';

/**
 * Closes the remaining uncovered branches in the `lib/` leaf modules listed in
 * need-tests.md. These are all pure functions — no DOM, no WS.
 */

// ── utils ───────────────────────────────────────────────────────────────────

describe('cn', () => {
  it('joins class names', () => {
    expect(cn('a', 'b')).toBe('a b');
  });

  it('drops falsy entries', () => {
    expect(cn('a', false, null, undefined, '', 'b')).toBe('a b');
  });

  it('resolves conditional objects and arrays', () => {
    expect(cn(['a', { b: true, c: false }])).toBe('a b');
  });

  it('lets a later tailwind utility win over an earlier conflicting one', () => {
    expect(cn('p-2', 'p-4')).toBe('p-4');
    expect(cn('text-red-500', 'text-blue-500')).toBe('text-blue-500');
  });

  it('keeps non-conflicting utilities side by side', () => {
    expect(cn('p-2', 'm-4')).toBe('p-2 m-4');
  });

  it('returns an empty string for no input', () => {
    expect(cn()).toBe('');
  });
});

describe('safeId', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('uses crypto.randomUUID when the context is secure', () => {
    const randomUUID = vi.fn(() => '11111111-2222-3333-4444-555555555555');
    vi.stubGlobal('crypto', { randomUUID });
    expect(safeId()).toBe('11111111-2222-3333-4444-555555555555');
    expect(randomUUID).toHaveBeenCalled();
  });

  it('falls back when randomUUID is missing (plain-HTTP context)', () => {
    vi.stubGlobal('crypto', {});
    const id = safeId();
    expect(id).toMatch(/^[a-z0-9]+-[a-z0-9]+$/);
  });

  it('falls back when crypto itself is undefined', () => {
    vi.stubGlobal('crypto', undefined);
    expect(safeId()).toMatch(/^[a-z0-9]+-[a-z0-9]+$/);
  });

  it('produces distinct ids on the fallback path', () => {
    vi.stubGlobal('crypto', {});
    const ids = new Set(Array.from({ length: 50 }, () => safeId()));
    // Same-millisecond calls still differ thanks to the random suffix.
    expect(ids.size).toBeGreaterThan(40);
  });
});

// ── sage-block ──────────────────────────────────────────────────────────────

describe('extractSageBlock', () => {
  const HEADER = '--- SAGE: relevant memories ---';

  function withHeader(body: string): string {
    return `${HEADER}\n${body}`;
  }

  it('returns the output unchanged when there is no SAGE block', () => {
    const out = extractSageBlock('just some tool output');
    expect(out.cleanOutput).toBe('just some tool output');
    expect(out.sageLines).toEqual([]);
  });

  it('handles empty input', () => {
    expect(extractSageBlock('').cleanOutput).toBe('');
  });

  it('rejects a header with nothing after it', () => {
    const out = extractSageBlock(`tool output\n${HEADER}`);
    expect(out.sageLines).toEqual([]);
  });

  it('rejects a header followed only by blank lines', () => {
    const out = extractSageBlock(`tool output\n${withHeader('\n   \n')}`);
    expect(out.sageLines).toEqual([]);
  });

  it('rejects a header whose body is not memory-shaped', () => {
    const out = extractSageBlock(`tool output\n${withHeader('this is ordinary prose')}`);
    expect(out.sageLines).toEqual([]);
    expect(out.cleanOutput).toContain('ordinary prose');
  });
});

// ── model-calendar ──────────────────────────────────────────────────────────

describe('CALENDAR_DAYS', () => {
  it('starts on Sunday to match Date#getDay', () => {
    expect(CALENDAR_DAYS).toEqual(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
  });
});

describe('isCalendarRuleActive — guards', () => {
  const base = { id: 'r', provider: 'cc', start: '09:00', end: '17:00', timezone: 'UTC' };

  it('is inactive when the rule is explicitly disabled', () => {
    expect(
      isCalendarRuleActive({ ...base, enabled: false }, new Date('2026-07-29T12:00:00Z')),
    ).toBe(false);
  });

  it('is active when `enabled` is omitted', () => {
    expect(isCalendarRuleActive(base, new Date('2026-07-29T12:00:00Z'))).toBe(true);
  });

  it.each(['9:00', '0900', '25:00', '09:60', '', 'noon'])(
    'rejects the malformed start time %j',
    (start) => {
      expect(isCalendarRuleActive({ ...base, start }, new Date('2026-07-29T12:00:00Z'))).toBe(
        false,
      );
    },
  );

  it('rejects a malformed end time', () => {
    expect(isCalendarRuleActive({ ...base, end: '99:99' }, new Date('2026-07-29T12:00:00Z'))).toBe(
      false,
    );
  });

  it('accepts the 00:00 and 23:59 boundaries', () => {
    expect(
      isCalendarRuleActive(
        { ...base, start: '00:00', end: '23:59' },
        new Date('2026-07-29T12:00:00Z'),
      ),
    ).toBe(true);
  });

  it('returns false for an invalid timezone instead of throwing', () => {
    expect(
      isCalendarRuleActive({ ...base, timezone: 'Not/AZone' }, new Date('2026-07-29T12:00:00Z')),
    ).toBe(false);
  });

  it('treats start === end as an all-day rule', () => {
    expect(
      isCalendarRuleActive(
        { ...base, start: '09:00', end: '09:00' },
        new Date('2026-07-29T03:00:00Z'),
      ),
    ).toBe(true);
  });

  it('restricts an all-day rule to its listed days', () => {
    const allDay = { ...base, start: '09:00', end: '09:00' };
    // 2026-07-29 is a Wednesday (day 3).
    expect(isCalendarRuleActive({ ...allDay, days: [3] }, new Date('2026-07-29T03:00:00Z'))).toBe(
      true,
    );
    expect(isCalendarRuleActive({ ...allDay, days: [1] }, new Date('2026-07-29T03:00:00Z'))).toBe(
      false,
    );
  });

  it('treats an empty days array as "every day"', () => {
    expect(isCalendarRuleActive({ ...base, days: [] }, new Date('2026-07-29T12:00:00Z'))).toBe(
      true,
    );
  });

  it('excludes the end minute of a same-day window', () => {
    expect(isCalendarRuleActive(base, new Date('2026-07-29T17:00:00Z'))).toBe(false);
    expect(isCalendarRuleActive(base, new Date('2026-07-29T16:59:00Z'))).toBe(true);
  });

  it('includes the start minute', () => {
    expect(isCalendarRuleActive(base, new Date('2026-07-29T09:00:00Z'))).toBe(true);
  });

  it('attributes the morning tail of an overnight window to the previous day', () => {
    const overnight = { ...base, start: '22:00', end: '07:00' };
    // Wednesday 06:00 belongs to Tuesday's (day 2) window.
    expect(
      isCalendarRuleActive({ ...overnight, days: [2] }, new Date('2026-07-29T06:00:00Z')),
    ).toBe(true);
    expect(
      isCalendarRuleActive({ ...overnight, days: [3] }, new Date('2026-07-29T06:00:00Z')),
    ).toBe(false);
  });

  it('attributes the evening head of an overnight window to that day', () => {
    const overnight = { ...base, start: '22:00', end: '07:00' };
    expect(
      isCalendarRuleActive({ ...overnight, days: [3] }, new Date('2026-07-29T23:00:00Z')),
    ).toBe(true);
  });

  it("is inactive in the middle of an overnight rule's off-hours", () => {
    expect(
      isCalendarRuleActive(
        { ...base, start: '22:00', end: '07:00' },
        new Date('2026-07-29T12:00:00Z'),
      ),
    ).toBe(false);
  });

  it('respects a non-UTC timezone', () => {
    // 12:00 UTC is 15:00 in Istanbul, inside 14:00-16:00.
    expect(
      isCalendarRuleActive(
        { ...base, start: '14:00', end: '16:00', timezone: 'Europe/Istanbul' },
        new Date('2026-07-29T12:00:00Z'),
      ),
    ).toBe(true);
  });
});

describe('isCalendarRuleValid', () => {
  const base = { id: 'r', provider: 'cc', start: '09:00', end: '17:00', timezone: 'UTC' };

  it('accepts a well-formed rule', () => {
    expect(isCalendarRuleValid(base)).toBe(true);
  });

  it('rejects a malformed start or end', () => {
    expect(isCalendarRuleValid({ ...base, start: '9:00' })).toBe(false);
    expect(isCalendarRuleValid({ ...base, end: '' })).toBe(false);
  });

  it('rejects an unknown timezone', () => {
    expect(isCalendarRuleValid({ ...base, timezone: 'Not/AZone' })).toBe(false);
  });

  it('accepts a real IANA zone', () => {
    expect(isCalendarRuleValid({ ...base, timezone: 'Europe/Istanbul' })).toBe(true);
  });
});

describe('blockingCalendarRules', () => {
  const at = new Date('2026-07-29T12:00:00Z');

  it('returns nothing for an empty rule set', () => {
    expect(blockingCalendarRules([], at)).toEqual([]);
  });

  it('reports an active blackout', () => {
    const rule = {
      id: 'b',
      provider: 'cc',
      start: '09:00',
      end: '17:00',
      timezone: 'UTC',
    };
    expect(blockingCalendarRules([rule], at)).toEqual([rule]);
  });

  it('ignores an inactive blackout', () => {
    const rule = {
      id: 'b',
      provider: 'cc',
      start: '01:00',
      end: '02:00',
      timezone: 'UTC',
    };
    expect(blockingCalendarRules([rule], at)).toEqual([]);
  });

  it('does not block while an allow_only window is open', () => {
    const rule = {
      id: 'a',
      mode: 'allow_only' as const,
      provider: 'cc',
      start: '09:00',
      end: '17:00',
      timezone: 'UTC',
    };
    expect(blockingCalendarRules([rule], at)).toEqual([]);
  });

  it('blocks outside every allow_only window for that target', () => {
    const rule = {
      id: 'a',
      mode: 'allow_only' as const,
      provider: 'cc',
      start: '01:00',
      end: '02:00',
      timezone: 'UTC',
    };
    expect(blockingCalendarRules([rule], at)).toEqual([rule]);
  });

  it('an open allow_only window rescues a closed sibling for the same target', () => {
    const closed = {
      id: 'a1',
      mode: 'allow_only' as const,
      provider: 'cc',
      start: '01:00',
      end: '02:00',
      timezone: 'UTC',
    };
    const open = { ...closed, id: 'a2', start: '09:00', end: '17:00' };
    expect(blockingCalendarRules([closed, open], at)).toEqual([]);
  });

  it('prefers a hard blackout over the allow_only check for the same target', () => {
    const blackout = { id: 'b', provider: 'cc', start: '09:00', end: '17:00', timezone: 'UTC' };
    const allow = { ...blackout, id: 'a', mode: 'allow_only' as const };
    const blocked = blockingCalendarRules([blackout, allow], at);
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.id).toBe('b');
  });

  it('groups independently per provider/model target', () => {
    const ccBlackout = { id: 'b', provider: 'cc', start: '09:00', end: '17:00', timezone: 'UTC' };
    const openaiQuiet = {
      id: 'q',
      provider: 'openai',
      start: '01:00',
      end: '02:00',
      timezone: 'UTC',
    };
    const blocked = blockingCalendarRules([ccBlackout, openaiQuiet], at);
    expect(blocked.map((r) => r.id)).toEqual(['b']);
  });

  it('treats a model-specific rule as a separate target from the provider-wide one', () => {
    const wide = { id: 'w', provider: 'cc', start: '01:00', end: '02:00', timezone: 'UTC' };
    const specific = { ...wide, id: 's', model: 'opus', start: '09:00', end: '17:00' };
    const blocked = blockingCalendarRules([wide, specific], at);
    expect(blocked.map((r) => r.id)).toEqual(['s']);
  });
});
