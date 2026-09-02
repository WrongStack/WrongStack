import { describe, expect, it } from 'vitest';
import { applyTokenOverrides } from '../../src/execution/design-project-store.js';
import { verifyFiles } from '../../src/execution/design-verify.js';
import type { DesignKitTokens } from '../../src/types/design-kit.js';

const tokens: DesignKitTokens = {
  light: { bg: 'oklch(100% 0 0)', primary: 'oklch(62.79% 0.2577 29.23)' }, // primary = #ff0000
  dark: { bg: 'oklch(0% 0 0)', primary: 'oklch(62.79% 0.2577 29.23)' },
};

describe('verifyFiles', () => {
  it('passes when colors are on-palette or use token names', () => {
    const r = verifyFiles(tokens, [
      { path: 'a.css', text: '.btn { background: #ff0000; color: var(--primary); }' },
      { path: 'b.tsx', text: '<div className="bg-primary text-bg" />' },
    ]);
    expect(r.violations).toHaveLength(0);
    expect(r.ok).toBe(true);
    expect(r.score).toBe(1);
  });

  it('flags off-palette hardcoded colors', () => {
    const r = verifyFiles(tokens, [{ path: 'a.css', text: '.x { color: #123456; }' }]);
    expect(r.violations.length).toBe(1);
    expect(r.violations[0]?.reason).toMatch(/off-palette/);
    expect(r.ok).toBe(false);
  });

  it('flags generic Tailwind palette utilities', () => {
    const r = verifyFiles(tokens, [
      { path: 'a.tsx', text: '<div className="bg-blue-500 text-gray-700" />' },
    ]);
    expect(r.violations.length).toBe(2);
    expect(r.violations.every((v) => /generic Tailwind/.test(v.reason))).toBe(true);
  });

  it('respects overrides — an overridden primary becomes the on-palette color', () => {
    const overridden = applyTokenOverrides(tokens, { primary: 'oklch(0% 0 0)' }); // → #000000
    const r = verifyFiles(overridden, [{ path: 'a.css', text: '.x { color: #000000; }' }]);
    expect(r.violations).toHaveLength(0);
    // original red is now off-palette
    const r2 = verifyFiles(overridden, [{ path: 'b.css', text: '.x { color: #ff0000; }' }]);
    expect(r2.violations.length).toBe(1);
  });

  it('empty input scores 1 (nothing to flag)', () => {
    expect(verifyFiles(tokens, []).score).toBe(1);
  });

  it('flags arbitrary radius/spacing utilities but not scale utilities', () => {
    const r = verifyFiles(tokens, [
      { path: 'a.tsx', text: '<div className="rounded-[7px] p-[13px] rounded-lg p-4" />' },
    ]);
    // rounded-[7px] + p-[13px] flagged; rounded-lg + p-4 are token-driven.
    expect(r.violations.length).toBe(2);
    expect(r.violations.some((v) => v.axis === 'radius')).toBe(true);
    expect(r.violations.some((v) => v.axis === 'spacing')).toBe(true);
    // Non-color axes must NOT drag the color score down.
    expect(r.score).toBe(1);
  });

  it('flags hardcoded border-radius but ignores var() and trivial values', () => {
    const r = verifyFiles(tokens, [
      {
        path: 'a.css',
        text: '.a{border-radius: 7px} .b{border-radius: var(--radius-md)} .c{border-radius: 50%}',
      },
    ]);
    expect(r.violations.length).toBe(1);
    expect(r.violations[0]?.axis).toBe('radius');
  });
});
