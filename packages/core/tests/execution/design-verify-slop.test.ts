import type { DesignKitTokens } from '@wrongstack/contracts/types/design-kit';
import { describe, expect, it } from 'vitest';
import { verifyFiles } from '../../src/execution/design-verify.js';

/**
 * The `composition` axis exists because token adherence and taste are
 * independent failures: the snippets below are 100% on-palette — `verify`'s
 * color score stays 1 — and every one of them is a recognizable
 * generated-by-default pattern. Without this axis a slop screen reports clean.
 *
 * Every rule here must be kit-INDEPENDENT (drift under every kit). Looks a kit
 * can legitimately sanction (glass panels, aurora washes) are deliberately not
 * encoded — judging those needs the kit body, which is `design-critique`'s job.
 */

const tokens: DesignKitTokens = {
  light: { bg: 'oklch(100% 0 0)', primary: 'oklch(62.79% 0.2577 29.23)' },
  dark: { bg: 'oklch(0% 0 0)', primary: 'oklch(62.79% 0.2577 29.23)' },
};

const composition = (text: string, path = 'a.tsx') =>
  verifyFiles(tokens, [{ path, text }]).violations.filter((v) => v.axis === 'composition');

describe('verifyFiles — composition axis', () => {
  it('flags gradient-filled text', () => {
    const v = composition('<h1 className="bg-clip-text text-transparent">Hi</h1>');
    expect(v).toHaveLength(1);
    expect(v[0]?.reason).toMatch(/gradient-filled text/);
  });

  it('does not flag bg-clip-text without a transparent fill', () => {
    expect(composition('<h1 className="bg-clip-text">Hi</h1>')).toHaveLength(0);
  });

  it('flags stock Tailwind elevation but not the kit ramp', () => {
    const v = composition('<div className="shadow-lg" /><div className="shadow-2" />');
    expect(v).toHaveLength(1);
    expect(v[0]?.snippet).toBe('shadow-lg');
    expect(v[0]?.reason).toMatch(/elevation ramp/);
  });

  it('flags an emoji standing in for an icon', () => {
    const v = composition('<button type="button">🚀 Deploy</button>');
    expect(v).toHaveLength(1);
    expect(v[0]?.reason).toMatch(/emoji/);
  });

  it('flags filler / launch-copy boilerplate', () => {
    const v = composition('<p>Unlock the power of seamlessly integrated workflows.</p>');
    expect(v.length).toBeGreaterThanOrEqual(2);
    expect(v.every((x) => /filler/.test(x.reason))).toBe(true);
  });

  it('flags a page where every section is a centered stack', () => {
    const page = [
      '<section><div className="text-center">A</div></section>',
      '<section><div className="text-center">B</div></section>',
      '<section><div className="text-center">C</div></section>',
      '<section><div className="text-center">D</div></section>',
    ].join('\n');
    const v = composition(page);
    expect(v.some((x) => /centered blocks/.test(x.reason))).toBe(true);
  });

  it('leaves a couple of centered blocks alone', () => {
    const page = '<section><div className="text-center">A</div></section>\n<section>B</section>';
    expect(composition(page)).toHaveLength(0);
  });

  it('flags an identical block repeated into a uniform grid', () => {
    const card = '<div className="rounded-lg border border-border bg-surface p-6 shadow-1">x</div>';
    const v = composition(Array.from({ length: 4 }, () => card).join('\n'));
    expect(v.some((x) => /identical block repeated 4/.test(x.reason))).toBe(true);
  });

  it('does not flag a block repeated only twice', () => {
    const card = '<div className="rounded-lg border border-border bg-surface p-6 shadow-1">x</div>';
    expect(composition(`${card}\n${card}`)).toHaveLength(0);
  });

  it('keeps the color score intact — composition drift is not palette drift', () => {
    const r = verifyFiles(tokens, [
      { path: 'a.tsx', text: '<h1 className="bg-clip-text text-transparent shadow-lg">Hi</h1>' },
    ]);
    expect(r.score).toBe(1);
    expect(r.ok).toBe(false);
    expect(r.violations.every((v) => v.axis === 'composition')).toBe(true);
  });

  it('stays quiet on token-driven, considered markup', () => {
    const good = [
      '<section className="grid gap-6 md:grid-cols-[2fr_1fr]">',
      '  <h1 className="text-3xl font-semibold text-fg">Ship the release</h1>',
      '  <p className="text-base text-muted-fg">Runs appear here after the first deploy.</p>',
      '</section>',
    ].join('\n');
    expect(verifyFiles(tokens, [{ path: 'a.tsx', text: good }]).violations).toHaveLength(0);
  });

  // ── False positives found by running this against a real 404-file UI ───────

  it('does not treat a repeated LABEL class as a repeated block', () => {
    // Four dropdown labels sharing one long typographic class is not a card grid.
    const label = '<span className="text-sm uppercase tracking-wider text-muted">Panels</span>';
    expect(composition(Array.from({ length: 4 }, () => label).join('\n'))).toHaveLength(0);
  });

  it('still flags a repeated CONTAINER class', () => {
    const tile = '<div className="rounded-lg border bg-surface px-2 py-1.5 text-center">1</div>';
    const v = composition(Array.from({ length: 4 }, () => tile).join('\n'));
    expect(v.some((x) => /identical block repeated 4/.test(x.reason))).toBe(true);
  });

  it('reports the line the repeated block actually starts on', () => {
    // A LONGER class attribute that merely contains the repeated group's string
    // sits above it. A substring search reports line 1; the group starts at 2.
    // Must be ≥40 chars or CLASS_ATTR_RE never captures it in the first place.
    const shell = 'rounded-xl border border-border bg-surface p-4 shadow-1';
    const text = [
      `<div className="flex items-start gap-3 ${shell}">component</div>`,
      `<div className="${shell}">a</div>`,
      `<div className="${shell}">b</div>`,
      `<div className="${shell}">c</div>`,
      `<div className="${shell}">d</div>`,
    ].join('\n');
    const v = composition(text);
    expect(v).toHaveLength(1);
    expect(v[0]?.line).toBe(2);
  });

  it('does not flag typographic symbols as emoji iconography', () => {
    // Arrows, status glyphs and keyboard symbols are legitimate in dense UI.
    const glyphs = [
      '<span className="text-muted">→</span>',
      '<span className="text-destructive">✗</span>',
      '<span className="text-warning">⚠</span>',
      '<span className="text-warning">★</span>',
      '<DropdownMenuShortcut>⌘K</DropdownMenuShortcut>',
    ].join('\n');
    expect(composition(glyphs)).toHaveLength(0);
  });

  it('exempts a pictograph that is explicitly decorative', () => {
    expect(composition('<span aria-hidden>🦂</span>')).toHaveLength(0);
    expect(composition('<button type="button">🦂 Run</button>')).toHaveLength(1);
  });
});

describe('verifyFiles — type axis', () => {
  it('flags a hardcoded font family in CSS but not a token var', () => {
    const r = verifyFiles(tokens, [
      {
        path: 'a.css',
        text: 'h1 { font-family: Inter, sans-serif; }\np { font-family: var(--font-sans); }',
      },
    ]);
    const type = r.violations.filter((v) => v.axis === 'type');
    expect(type).toHaveLength(1);
    expect(type[0]?.snippet).toMatch(/Inter/);
  });

  it('flags an arbitrary Tailwind font utility', () => {
    const r = verifyFiles(tokens, [{ path: 'a.tsx', text: `<p className="font-['Inter']" />` }]);
    expect(r.violations.filter((v) => v.axis === 'type')).toHaveLength(1);
  });
});

describe('verifyFiles — craft rules measured against a real corpus first', () => {
  it('flags pure black/white surfaces the named scales miss', () => {
    const r = verifyFiles(tokens, [
      { path: 'a.tsx', text: '<div className="bg-white text-black border-white" />' },
    ]);
    const color = r.violations.filter((v) => v.axis === 'color');
    expect(color).toHaveLength(3);
    expect(color[0]?.reason).toMatch(/pure black\/white/);
    // Same class of drift as a named scale: it must move the palette score.
    expect(r.score).toBeLessThan(1);
  });

  it('leaves kit surface tokens alone', () => {
    expect(
      verifyFiles(tokens, [{ path: 'a.tsx', text: '<div className="bg-surface text-fg" />' }])
        .violations,
    ).toHaveLength(0);
  });

  it('flags all-caps without tracking, but not with it', () => {
    const bad = verifyFiles(tokens, [
      { path: 'a.tsx', text: '<span className="text-xs uppercase text-muted">Panels</span>' },
    ]).violations;
    expect(bad).toHaveLength(1);
    expect(bad[0]?.axis).toBe('type');
    expect(bad[0]?.reason).toMatch(/opened letter-spacing/);

    const good = verifyFiles(tokens, [
      {
        path: 'a.tsx',
        text: '<span className="text-xs uppercase tracking-wide text-muted">Panels</span>',
      },
    ]).violations;
    expect(good).toHaveLength(0);
  });

  it('flags a border stacked with kit elevation, but not with the hairline step', () => {
    const stacked = verifyFiles(tokens, [
      { path: 'a.tsx', text: '<div className="rounded-lg border border-border shadow-3" />' },
    ]).violations;
    expect(stacked.some((v) => /two elevation|elevation strategy/.test(v.reason))).toBe(true);

    // shadow-1 is the hairline step — border + shadow-1 is a legitimate pairing.
    const fine = verifyFiles(tokens, [
      { path: 'a.tsx', text: '<div className="rounded-lg border border-border shadow-1" />' },
    ]).violations;
    expect(fine).toHaveLength(0);
  });

  it('does not double-report stock Tailwind shadows as stacking', () => {
    // `shadow-lg` is already reported as stock elevation; flagging the same
    // surface again for "stacking" would just be noise.
    const v = verifyFiles(tokens, [
      { path: 'a.tsx', text: '<div className="border border-border shadow-lg" />' },
    ]).violations;
    expect(v).toHaveLength(1);
    expect(v[0]?.reason).toMatch(/stock Tailwind elevation/);
  });

  it('flags an empty state that says nothing, but not one that explains', () => {
    const v = composition('<p className="text-muted">No data available</p>');
    expect(v).toHaveLength(1);
    expect(v[0]?.reason).toMatch(/empty state that says nothing/);

    // The phrase is only slop when it IS the whole label.
    expect(
      composition('<p className="text-muted">No data available for this range — widen it.</p>'),
    ).toHaveLength(0);
    expect(
      composition('<p className="text-muted">Runs appear here after the first deploy.</p>'),
    ).toHaveLength(0);
  });

  it('flags a control labelled with the mechanism instead of the action', () => {
    const v = verifyFiles(tokens, [
      { path: 'a.tsx', text: '<button type="submit">Submit</button>' },
    ]).violations;
    expect(v).toHaveLength(1);
    expect(v[0]?.reason).toMatch(/names the mechanism/);
    expect(
      verifyFiles(tokens, [
        { path: 'a.tsx', text: '<button type="submit">Create workspace</button>' },
      ]).violations,
    ).toHaveLength(0);
  });
});

describe('verifyFiles — a rule must never fight the kit it enforces', () => {
  // Measured, not assumed: a pixel-8bit screen tripped the border+elevation rule
  // on the exact pattern that kit's own KIT.md prescribes. Border + elevation is
  // a conflict only when the elevation is SOFT.
  const hardShadowKit: DesignKitTokens = {
    light: { bg: 'oklch(93% 0.03 110)', 'shadow-2': '4px 4px 0 oklch(55% 0.05 130)' },
    dark: { bg: 'oklch(18% 0.02 265)', 'shadow-2': '4px 4px 0 oklch(12% 0.02 265)' },
  };
  const softShadowKit: DesignKitTokens = {
    light: { bg: 'oklch(99% 0 0)', 'shadow-2': '0 2px 8px oklch(0% 0 0 / 0.08)' },
    dark: { bg: 'oklch(18% 0.01 260)', 'shadow-2': '0 2px 8px oklch(0% 0 0 / 0.5)' },
  };
  const stacked = '<div className="border-4 border-border bg-surface p-6 shadow-3" />';

  it('stays silent when the kit stamps its elevation as a hard offset', () => {
    const v = verifyFiles(hardShadowKit, [{ path: 'a.tsx', text: stacked }]).violations;
    expect(v.filter((x) => /elevation strategy/.test(x.reason))).toHaveLength(0);
  });

  it('still flags the stack when the kit uses a soft shadow', () => {
    const v = verifyFiles(softShadowKit, [{ path: 'a.tsx', text: stacked }]).violations;
    expect(v.some((x) => /elevation strategy/.test(x.reason))).toBe(true);
  });

  it('does not sanction shadow-2/3/4 from the base shadow token — utilities resolve to the ramp', () => {
    // comic-pop shape (real kit): ONLY the base `shadow` key is a hard offset;
    // its shadow-2/3/4 scale is absent, and readTokens() merges the foundations
    // base scales under every kit — so the shadow-3 utility resolves to the
    // SOFT foundations default, not to the kit's hard stamp. Border + soft
    // shadow-3 is exactly the "two elevation strategies" stack this rule
    // exists to catch; the base key must not suppress it.
    const comicPopMerged: DesignKitTokens = {
      light: {
        bg: 'oklch(97% 0.07 105)',
        'shadow-2': '0 2px 8px oklch(0% 0 0 / 0.08)',
        'shadow-3': '0 8px 24px oklch(0% 0 0 / 0.12)',
        shadow: '4px 4px 0 oklch(15% 0 0)',
      },
      dark: {
        bg: 'oklch(20% 0.05 300)',
        'shadow-2': '0 2px 8px oklch(0% 0 0 / 0.2)',
        'shadow-3': '0 8px 24px oklch(0% 0 0 / 0.45)',
        shadow: '4px 4px 0 oklch(96% 0 0)',
      },
    };
    const v = verifyFiles(comicPopMerged, [{ path: 'a.tsx', text: stacked }]).violations;
    expect(v.some((x) => /elevation strategy/.test(x.reason))).toBe(true);
  });
});

describe('verifyFiles — a none-elevation kit gets an accurate message', () => {
  // Probed on flat-design, whose ramp is `none` at every step: there, `shadow-3`
  // is not "a second elevation strategy", it is a class that resolves to nothing.
  const noElevationKit: DesignKitTokens = {
    light: { bg: 'oklch(97% 0 0)', 'shadow-2': 'none', 'shadow-3': 'none', 'shadow-4': 'none' },
    dark: { bg: 'oklch(20% 0.01 250)', 'shadow-2': 'none', 'shadow-3': 'none', 'shadow-4': 'none' },
  };

  it('says the utility resolves to nothing, not that two strategies are stacked', () => {
    const v = verifyFiles(noElevationKit, [
      { path: 'a.tsx', text: '<div className="border-4 border-border bg-surface p-6 shadow-3" />' },
    ]).violations;
    expect(v).toHaveLength(1);
    expect(v[0]?.reason).toMatch(/resolves to nothing/);
    expect(v[0]?.reason).not.toMatch(/elevation strategy/);
  });

  it('flags the dead utility even without a border', () => {
    const v = verifyFiles(noElevationKit, [
      { path: 'a.tsx', text: '<div className="bg-surface p-6 shadow-3" />' },
    ]).violations;
    expect(v.some((x) => /resolves to nothing/.test(x.reason))).toBe(true);
  });

  it('still flags stock Tailwind elevation, which would draw a real shadow', () => {
    const v = verifyFiles(noElevationKit, [
      { path: 'a.tsx', text: '<div className="bg-surface p-6 shadow-lg" />' },
    ]).violations;
    expect(v.some((x) => /stock Tailwind elevation/.test(x.reason))).toBe(true);
  });

  it('stays quiet on the correct flat pattern — a fill difference', () => {
    expect(
      verifyFiles(noElevationKit, [{ path: 'a.tsx', text: '<div className="bg-raised p-6" />' }])
        .violations,
    ).toHaveLength(0);
  });
});

describe('verifyFiles — a clean result is not always a checked result', () => {
  it('counts a native-stack file as unreadable rather than clean', () => {
    // A React Native screen: theme constants and a numeric scale, no utilities.
    const rn = [
      "import { darkTheme, scale } from '../theme/design-tokens';",
      'const styles = StyleSheet.create({',
      '  card: { backgroundColor: darkTheme.surface, padding: scale.space4 },',
      '});',
    ].join('\n');
    const r = verifyFiles(tokens, [{ path: 'DoseScreen.tsx', text: rn }]);
    expect(r.violations).toHaveLength(0);
    expect(r.score).toBe(1);
    // …and the report says why that 100% is meaningless here.
    expect(r.filesWithNoSignal).toBe(1);
  });

  it('does not count a web file with real markup as unreadable', () => {
    const r = verifyFiles(tokens, [
      { path: 'a.tsx', text: '<div className="bg-surface text-fg" />' },
    ]);
    expect(r.filesWithNoSignal).toBe(0);
  });

  it('counts a plain CSS file with color literals as readable', () => {
    const r = verifyFiles(tokens, [{ path: 'a.css', text: '.x { color: #123456; }' }]);
    expect(r.filesWithNoSignal).toBe(0);
  });
});

describe('verifyFiles — comments are prose, not markup', () => {
  it('ignores utility names that only appear in comments', () => {
    const text = [
      '// shadow-lg is the stock ramp; use shadow-1 instead',
      '/* font-family: Inter; */',
      ' * A doc comment mentioning shadow-sm and text-center',
      '// color: #123456',
    ].join('\n');
    expect(verifyFiles(tokens, [{ path: 'a.tsx', text }]).violations).toHaveLength(0);
  });

  it('ignores hex-shaped text in comments — colors explained, and issue numbers', () => {
    // Measured, not imagined: an A/B across 1079 real React/TUI files (rules held
    // fixed, only the comment state machine disabled) found 12 findings the fix
    // removes, and 10 of them are this shape — not utility names. Six are a
    // theme file annotating its own colors; the rest are issue references, which
    // `HEX_RE` reads as three-digit colors. Code lines are unaffected: every
    // three-digit hex the corpus reports outside comments (#666, #ddd, #fff) is
    // a real color, so the fix belongs in comment handling, not in HEX_RE.
    const text = [
      '// Background: hsl(225 17% 8%) = #121318',
      '  // (fixes minified React error #310 when `payload` is null on first paint).',
      '  /** Lifetime spawn budget from server (issue #323). */',
      '  // … wraps the terminal on long prompts (GitHub issue #295).',
      '<div className="bg-surface p-4" />',
    ].join('\n');
    expect(verifyFiles(tokens, [{ path: 'a.tsx', text }]).violations).toHaveLength(0);
  });

  it('still flags real markup, and keeps the line number the comments shifted', () => {
    const text = [
      '// this file explains shadow-lg',
      ' * and mentions it again: shadow-lg',
      '',
      '<div className="shadow-lg" />',
    ].join('\n');
    const v = verifyFiles(tokens, [{ path: 'a.tsx', text }]).violations;
    expect(v).toHaveLength(1);
    expect(v[0]?.line).toBe(4);
  });

  it('ignores JSX comments, which open with `{/*` and matched no opener pattern', () => {
    // Found by dogfooding: every `{/* … */}` on its own line was scanned as
    // markup, so a comment explaining a removed utility reported it as present.
    // This is the shape real JSX comments take — on their own line, between
    // elements. A `{/* … */}` sharing a line with markup is NOT stripped, by
    // design: the markup on that line is still markup.
    const text = [
      '<section>',
      '  {/* shadow-lg was removed here; use the kit ramp */}',
      '  <div className="bg-surface p-4" />',
      '</section>',
    ].join('\n');
    expect(verifyFiles(tokens, [{ path: 'a.tsx', text }]).violations).toHaveLength(0);
  });

  it('ignores the middle lines of a multi-line block comment', () => {
    const text = [
      '/*',
      ' bare middle line mentioning shadow-lg and bg-white',
      'another middle line with text-center text-center text-center text-center',
      '*/',
      '<div className="bg-surface p-4" />',
    ].join('\n');
    expect(verifyFiles(tokens, [{ path: 'a.tsx', text }]).violations).toHaveLength(0);
  });

  it('ignores a multi-line JSX comment the same way', () => {
    const text = [
      '{/* Real spacing between targets: gap-px passed every token check',
      '    and still failed the kiosk mis-tap test. shadow-lg too. */}',
      '<div className="bg-surface p-4" />',
    ].join('\n');
    expect(verifyFiles(tokens, [{ path: 'a.tsx', text }]).violations).toHaveLength(0);
  });

  it('still scans code that merely ends with a comment', () => {
    const text = '<div className="shadow-lg" /> // stock elevation, on purpose';
    const v = verifyFiles(tokens, [{ path: 'a.tsx', text }]).violations;
    expect(v.some((x) => /stock Tailwind elevation/.test(x.reason))).toBe(true);
  });

  it('does not let commented-out markup inflate a file-level count', () => {
    const text = [
      '// <section><div className="text-center">A</div></section>',
      '// <section><div className="text-center">B</div></section>',
      '// <section><div className="text-center">C</div></section>',
      '// <section><div className="text-center">D</div></section>',
    ].join('\n');
    expect(verifyFiles(tokens, [{ path: 'a.tsx', text }]).violations).toHaveLength(0);
  });
});
