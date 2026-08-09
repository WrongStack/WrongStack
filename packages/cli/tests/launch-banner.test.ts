/**
 * Tests for `boot/launch-banner.ts` — the plain-ANSI launch banner.
 *
 * The artwork mirrors packages/tui/src/components/history/banner.tsx;
 * these tests pin the string-level contract (widths, compact fallback,
 * NO_COLOR behavior) without rendering anything.
 */

import { stripAnsi } from '@wrongstack/core/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { launchBannerLines, WORDMARK_WIDTH } from '../src/boot/launch-banner.js';

describe('launchBannerLines', () => {
  let savedNoColor: string | undefined;
  let savedForceColor: string | undefined;

  beforeEach(() => {
    savedNoColor = process.env.NO_COLOR;
    savedForceColor = process.env.FORCE_COLOR;
    delete process.env.NO_COLOR;
    delete process.env.FORCE_COLOR;
  });

  afterEach(() => {
    if (savedNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = savedNoColor;
    if (savedForceColor === undefined) delete process.env.FORCE_COLOR;
    else process.env.FORCE_COLOR = savedForceColor;
  });

  it('renders full art (mark + wordmark + tagline) on a wide terminal', () => {
    const lines = launchBannerLines(120, '1.2.3');
    // 3 mark rows + 1 blank + 4 wordmark rows + 1 tagline.
    expect(lines).toHaveLength(9);
    const plain = lines.map(stripAnsi);
    // Wordmark rows are exactly WORDMARK_WIDTH visible columns.
    for (const row of plain.slice(4, 8)) {
      expect(row).toHaveLength(WORDMARK_WIDTH);
    }
    expect(plain.some((l) => l.includes('█'))).toBe(true);
    expect(plain[plain.length - 1]).toContain('v1.2.3');
  });

  it('falls back to the compact one-liner on a narrow terminal', () => {
    const lines = launchBannerLines(40, '1.2.3');
    expect(lines).toHaveLength(2);
    const plain = lines.map(stripAnsi);
    expect(plain[0]).toContain('W R O N G S T A C K');
    expect(plain[1]).toContain('v1.2.3');
  });

  it('emits no ANSI escapes when NO_COLOR is set', () => {
    process.env.NO_COLOR = '1';
    const lines = launchBannerLines(120, '1.2.3');
    for (const line of lines) {
      expect(line).not.toContain('\x1b');
    }
  });

  it('emits ANSI color when FORCE_COLOR is set (even without a TTY)', () => {
    process.env.FORCE_COLOR = '1';
    const lines = launchBannerLines(120);
    expect(lines.some((l) => l.includes('\x1b[38;2;'))).toBe(true);
  });
});
