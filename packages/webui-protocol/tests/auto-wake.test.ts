/**
 * Regression tests for the auto-wake notice helpers.
 *
 * Both WebUI clients route replayed user text through `autoWakeNoticeText`; a
 * regression either renders a runtime prompt as a user bubble or swallows real
 * user input. The prompt shape below is core's `buildAutoWakeInput` output.
 */

import { describe, expect, it } from 'vitest';
import {
  AUTO_WAKE_PROMPT_MARKER,
  autoWakeNoticeText,
  formatAutoWakeNotice,
  formatAutoWakeSuppressedNotice,
  formatDeliveryPendingNotice,
  isAutoWakePrompt,
} from '../src/auto-wake.js';

const corePrompt = (ids: string) =>
  `${AUTO_WAKE_PROMPT_MARKER} Background delegation result(s) arrived: ${ids}. Review and continue.`;

describe('isAutoWakePrompt', () => {
  it('recognises the marker, tolerating leading whitespace', () => {
    expect(isAutoWakePrompt(corePrompt('d1'))).toBe(true);
    expect(isAutoWakePrompt(`\n  ${corePrompt('d1')}`)).toBe(true);
  });

  it('rejects ordinary text, including a marker that is not at the start', () => {
    expect(isAutoWakePrompt('please continue')).toBe(false);
    expect(isAutoWakePrompt(`see ${AUTO_WAKE_PROMPT_MARKER}`)).toBe(false);
  });
});

describe('formatAutoWakeNotice', () => {
  it('uses the singular form and lists the id for one delegation', () => {
    expect(formatAutoWakeNotice(['d1'])).toBe(
      'Auto-wake: a background delegation result arrived (d1); the leader started a new turn.',
    );
  });

  it('uses the plural form for several delegations and for none', () => {
    expect(formatAutoWakeNotice(['d1', 'd2'])).toBe(
      'Auto-wake: background delegation results arrived (d1, d2); the leader started a new turn.',
    );
    expect(formatAutoWakeNotice([])).toBe(
      'Auto-wake: background delegation results arrived; the leader started a new turn.',
    );
  });

  it('notes the chain position only for a positive chain', () => {
    expect(formatAutoWakeNotice(['d1'], 3)).toContain(' — woken turn 3 without your input.');
    expect(formatAutoWakeNotice(['d1'], 0)).not.toContain('woken turn');
    expect(formatAutoWakeNotice(['d1'], -1)).not.toContain('woken turn');
  });
});

describe('formatDeliveryPendingNotice', () => {
  it('formats a single ready result with its id', () => {
    expect(formatDeliveryPendingNotice(['d1'], 1)).toBe('Background delegation result ready (d1).');
  });

  it('formats several ready results with comma-separated ids and without ids', () => {
    expect(formatDeliveryPendingNotice(['d1', 'd2'], 2)).toBe(
      '2 background delegation results ready (d1, d2).',
    );
    expect(formatDeliveryPendingNotice([], 2)).toBe('2 background delegation results ready.');
  });
});

describe('formatAutoWakeSuppressedNotice', () => {
  it('pluralises the held result count', () => {
    expect(formatAutoWakeSuppressedNotice(1)).toContain('1 background result held');
    expect(formatAutoWakeSuppressedNotice(2)).toContain('2 background results held');
  });
});

describe('autoWakeNoticeText', () => {
  it('returns undefined for ordinary user input', () => {
    expect(autoWakeNoticeText('fix the build')).toBeUndefined();
  });

  it('replaces a core auto-wake prompt with the notice, carrying its ids', () => {
    expect(autoWakeNoticeText(corePrompt('del_7, del_8'))).toBe(
      formatAutoWakeNotice(['del_7', 'del_8']),
    );
  });

  it('drops blank ids from the parsed list', () => {
    expect(autoWakeNoticeText(corePrompt('d1, , d2'))).toBe(formatAutoWakeNotice(['d1', 'd2']));
  });

  it('falls back to an id-less notice when the id list is missing or empty', () => {
    expect(autoWakeNoticeText(`${AUTO_WAKE_PROMPT_MARKER} something else`)).toBe(
      formatAutoWakeNotice([]),
    );
    expect(autoWakeNoticeText(corePrompt(''))).toBe(formatAutoWakeNotice([]));
  });

  it('reads a notice-only prompt as timer/watch notices, not delegation results', () => {
    const text = autoWakeNoticeText(
      `${AUTO_WAKE_PROMPT_MARKER} Runtime notice(s) arrived: timer:wk-1#2, process:4242#exit@1. Review and continue.`,
    );
    expect(text).toBe(formatAutoWakeNotice([], undefined, ['timer:wk-1#2', 'process:4242#exit@1']));
    expect(text).not.toContain('delegation');
  });

  it('reads a mixed prompt into both lists', () => {
    expect(
      autoWakeNoticeText(
        `${AUTO_WAKE_PROMPT_MARKER} Background delegation result(s) arrived: d1; runtime notice(s) arrived: watch:pw-1#3. Review and continue.`,
      ),
    ).toBe(formatAutoWakeNotice(['d1'], undefined, ['watch:pw-1#3']));
  });
});
