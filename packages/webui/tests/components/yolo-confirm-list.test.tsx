/**
 * The settings menu duplicates core's kind list because the browser bundle does
 * not pull in `@wrongstack/core/security`. Duplication is fine; drift is not —
 * a kind added in core but missing here would be un-gateable from the UI, and a
 * locked kind missing here would render as a toggle the user could click to no
 * effect.
 */
import { ALL_DESTRUCTIVE_KINDS, LOCKED_DESTRUCTIVE_KINDS } from '@wrongstack/core/security';
import { describe, expect, it } from 'vitest';
import {
  LOCKED_YOLO_CONFIRM_KINDS,
  YOLO_CONFIRM_KINDS,
} from '@/components/SettingsPanel/YoloConfirmList';
import en from '@/i18n/locales/en/settings.json';

describe('YoloConfirmList — parity with core', () => {
  it('lists exactly the kinds core classifies, in the same order', () => {
    expect([...YOLO_CONFIRM_KINDS]).toEqual([...ALL_DESTRUCTIVE_KINDS]);
  });

  it('marks exactly the kinds core locks', () => {
    expect([...LOCKED_YOLO_CONFIRM_KINDS].sort()).toEqual([...LOCKED_DESTRUCTIVE_KINDS].sort());
  });

  it('ships a label and a hint for every kind', () => {
    const catalog = (en as { agent: { yoloKind: Record<string, unknown> } }).agent.yoloKind;
    for (const kind of YOLO_CONFIRM_KINDS) {
      expect(catalog[kind], `settings:agent.yoloKind.${kind}`).toEqual({
        label: expect.any(String),
        hint: expect.any(String),
      });
    }
    // No stragglers: a kind removed from core must lose its strings too.
    expect(Object.keys(catalog).sort()).toEqual([...YOLO_CONFIRM_KINDS].sort());
  });
});
