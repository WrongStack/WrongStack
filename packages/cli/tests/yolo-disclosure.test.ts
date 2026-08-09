import { describe, expect, it } from 'vitest';
import { shouldPrintYoloNotice } from '../src/boot.js';

describe('shouldPrintYoloNotice', () => {
  it('returns true on first run with default YOLO and no explicit --yolo/--no-yolo', () => {
    expect(shouldPrintYoloNotice(undefined, undefined, true)).toBe(true);
  });

  it('returns false when saved launch choices exist (not first run)', () => {
    expect(
      shouldPrintYoloNotice({ mode: 'tui', yolo: true, autonomy: 'auto' }, undefined, true),
    ).toBe(false);
  });

  it('returns false when --no-yolo was explicitly passed', () => {
    expect(shouldPrintYoloNotice(undefined, false, false)).toBe(false);
  });

  it('returns false when --yolo was explicitly passed', () => {
    expect(shouldPrintYoloNotice(undefined, true, true)).toBe(false);
  });

  it('returns false when YOLO ended up off despite first run (non-default config)', () => {
    expect(shouldPrintYoloNotice(undefined, undefined, false)).toBe(false);
  });

  it('returns false when both saved choices exist and yolo is explicitly off', () => {
    expect(shouldPrintYoloNotice({ mode: 'tui', yolo: true, autonomy: 'auto' }, false, false)).toBe(
      false,
    );
  });
});
