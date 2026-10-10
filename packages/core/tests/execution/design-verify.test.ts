import { describe, expect, it } from 'vitest';
import { applyTokenOverrides } from '../../src/execution/design-project-store.js';
import { kitContrastIssues, verifyFiles } from '../../src/execution/design-verify.js';
import type { DesignKitTokens } from '../../src/types/design-kit.js';

const tokens: DesignKitTokens = {
  light: { bg: 'oklch(100% 0 0)', primary: 'oklch(62.79% 0.2577 29.23)' }, // primary = #ff0000
  dark: { bg: 'oklch(0% 0 0)', primary: 'oklch(62.79% 0.2577 29.23)' },
};

describe('verifyFiles', () => {
  it('does not call token references arbitrary spacing or radius literals', () => {
    const r = verifyFiles(tokens, [
      {
        path: 'a.tsx',
        text: '<div className="p-[var(--space-4)] rounded-[var(--radius-md)] gap-[13px]" />',
      },
    ]);
    expect(r.violations.map((v) => v.snippet)).toEqual(['gap-[13px]']);
  });

  it('does not count commented-out markup as scan coverage', () => {
    const r = verifyFiles(tokens, [{ path: 'a.tsx', text: '// <div className="bg-primary" />' }]);
    expect(r.filesWithNoSignal).toBe(1);
  });

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

describe('kitContrastIssues — WCAG AA token gate', () => {
  it('returns no issues for an AA-clean token set', () => {
    const clean: DesignKitTokens = {
      light: { bg: '#ffffff', fg: '#111111', primary: '#111111' },
      dark: { bg: '#111111', fg: '#ffffff', primary: '#ffffff' },
    };
    expect(kitContrastIssues(clean)).toEqual([]);
  });

  it('flags fg/bg and primary/bg below 4.5:1, per theme, in order', () => {
    const bad: DesignKitTokens = {
      // Both light pairs fail (near-white on white); dark fg passes at ~16:1.
      light: { bg: '#ffffff', fg: '#f0f0f0', primary: '#d0d0d0' },
      // fg/bg passes (~16:1), primary/bg fails (~3.3:1).
      dark: { bg: '#111111', fg: '#eeeeee', primary: '#666666' },
    };
    const issues = kitContrastIssues(bad);
    expect(issues).toHaveLength(3);
    expect(issues[0]).toMatchObject({ theme: 'light', pair: 'fg/bg' });
    expect(issues[0]?.ratio).toBeLessThan(4.5);
    expect(issues[1]).toMatchObject({ theme: 'light', pair: 'primary/bg' });
    expect(issues[2]).toMatchObject({ theme: 'dark', pair: 'primary/bg' });
    expect(issues[2]?.ratio).toBeLessThan(4.5);
  });

  it('skips unparseable or absent tokens instead of guessing', () => {
    const odd: DesignKitTokens = {
      // fg is a font stack (not a color); primary/bg is clean.
      light: { bg: '#ffffff', fg: 'Inter, sans-serif', primary: '#111111' },
    };
    expect(kitContrastIssues(odd)).toEqual([]);
    // A custom floor moves the bar for near-miss pairs.
    const near: DesignKitTokens = {
      light: { bg: '#ffffff', fg: '#767676', primary: '#111111' }, // fg/bg ≈ 4.54:1
    };
    expect(kitContrastIssues(near)).toEqual([]);
    expect(kitContrastIssues(near, 5)).toHaveLength(1);
  });
});

describe('stock-elevation remap suppression', () => {
  it('flags shadow-lg normally, but not when the basis redefines the stock utilities', () => {
    const file = { path: 'a.tsx', text: '<div className="shadow-lg">x</div>' };

    // Kit-style basis (no stock shadow names): stock elevation IS drift.
    const stock = verifyFiles(tokens, [file]);
    expect(
      stock.violations.some(
        (v) => v.axis === 'composition' && /stock Tailwind elevation/.test(v.reason),
      ),
    ).toBe(true);

    // A capture that records an @theme remap of --shadow-sm…2xl: the same
    // utility is token-driven now, so the finding must disappear.
    const remapped = verifyFiles(
      {
        ...tokens,
        light: {
          ...tokens.light,
          'shadow-lg': '0 10px 15px -3px hsl(var(--shadow-color) / 0.1)',
        },
      },
      [file],
    );
    expect(remapped.violations.some((v) => /stock Tailwind elevation/.test(v.reason))).toBe(false);
    // Everything else still scans — only the elevation finding is suppressed.
    expect(remapped.violations).toHaveLength(stock.violations.length - 1);
  });
});
