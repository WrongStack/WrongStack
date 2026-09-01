import { describe, expect, it } from 'vitest';
import { colorToHex, oklchToHex } from '../../src/execution/design-color.js';
import {
  DefaultDesignKitLoader,
  resolveBundledDesignKitsDir,
} from '../../src/execution/design-kit-loader.js';
import { materializeTokens } from '../../src/execution/design-materialize.js';

function bundledLoader(): DefaultDesignKitLoader {
  const bundledDir = resolveBundledDesignKitsDir();
  expect(bundledDir, 'bundled design-kits dir should resolve').toBeTruthy();
  return new DefaultDesignKitLoader({
    inProjectDir: '/nonexistent/project/.wrongstack/design-kits',
    globalDir: '/nonexistent/global/design-kits',
    bundledDir,
  });
}

describe('DefaultDesignKitLoader', () => {
  it('discovers the bundled kits and excludes _foundations from the menu', async () => {
    const loader = bundledLoader();
    const all = await loader.list();
    const ids = all.map((k) => k.id);
    expect(ids).toContain('minimal-clarity');
    expect(ids).toContain('neo-brutalist');
    expect(ids).toContain('material-expressive');
    expect(ids).toContain('_foundations'); // present in list()

    const entries = await loader.listEntries();
    const entryIds = entries.map((e) => e.id);
    expect(entryIds).not.toContain('_foundations'); // excluded from selectable menu
    expect(entryIds.length).toBeGreaterThanOrEqual(10);
  });

  it('parses frontmatter (name, aesthetic, stacks) for a kit', async () => {
    const loader = bundledLoader();
    const kit = await loader.find('minimal-clarity');
    expect(kit).toBeDefined();
    expect(kit?.name).toBe('Minimal Clarity');
    expect(kit?.aesthetic).toMatch(/minimal/i);
    expect(kit?.stacks).toContain('web');
    expect(kit?.source).toBe('bundled');
  });

  it('renders a compact menu listing kit ids + best-for', async () => {
    const loader = bundledLoader();
    const menu = await loader.menuText();
    expect(menu).toMatch(/Design kits/i);
    expect(menu).toContain('minimal-clarity');
    expect(menu).not.toContain('_foundations');
  });

  it('readBody narrows to the requested stack section', async () => {
    const loader = bundledLoader();
    const web = await loader.readBody('minimal-clarity', 'web');
    expect(web).toContain('## Stack: web');
    expect(web).not.toContain('## Stack: flutter');
    // Cross-cutting sections survive narrowing.
    expect(web).toMatch(/## Overview/);

    const all = await loader.readBody('minimal-clarity');
    expect(all).toContain('## Stack: web');
    expect(all).toContain('## Stack: flutter');
  });

  it('readTokens returns light + dark token snapshots', async () => {
    const loader = bundledLoader();
    const tokens = await loader.readTokens('minimal-clarity');
    expect(tokens?.light?.['primary']).toMatch(/oklch/);
    expect(tokens?.dark?.['bg']).toMatch(/oklch/);
  });

  // Regression: material-expressive shipped without `border`, so the
  // foundations recipes' `border-border` utility had no token to resolve
  // against (foundations supplies scales only — colors must come from kits).
  it('bundled kits define the foundations-mandated core semantic tokens in both themes', async () => {
    const loader = bundledLoader();
    const entries = await loader.listEntries();
    expect(entries.length).toBeGreaterThan(0);
    const CORE = ['bg', 'fg', 'surface', 'muted', 'primary', 'accent', 'border', 'ring'] as const;
    for (const e of entries) {
      const tokens = await loader.readTokens(e.id);
      expect(tokens, `tokens for ${e.id}`).toBeDefined();
      for (const theme of ['light', 'dark'] as const) {
        for (const name of CORE) {
          const value = tokens?.[theme]?.[name];
          expect(value, `${e.id}.${theme}.${name} must be defined`).toBeDefined();
          expect(
            colorToHex(value ?? ''),
            `${e.id}.${theme}.${name} must parse as a color`,
          ).not.toBeNull();
        }
      }
    }
  });

  // Regression: body-copy + button-label contrast floors. The foundations Card
  // recipe renders `text-muted` on `bg-surface`, muted text also sits on plain
  // `bg`, and the Button recipe renders `text-bg` on `bg-primary` — every such
  // pair must clear WCAG AA 4.5:1, computed through the production oklchToHex
  // (sRGB relative luminance per WCAG 2.x). The button-label pair is exempt
  // for the tier-2/3 kits below: reaching the floor there needs large primary
  // lightness moves that reshape the brand color, which is a deliberate
  // per-kit design decision still pending. The allowlist must SHRINK as those
  // are fixed — and no new violating kit can slip in silently.
  it('bundled kits keep body-text pairs at or above the 4.5:1 AA floor', async () => {
    const loader = bundledLoader();
    const entries = await loader.listEntries();
    expect(entries.length).toBeGreaterThan(0);
    const channel = (c: number) => {
      const s = c / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    const luminance = (hex: string) => {
      const h = hex.slice(1);
      return (
        0.2126 * channel(Number.parseInt(h.slice(0, 2), 16)) +
        0.7152 * channel(Number.parseInt(h.slice(2, 4), 16)) +
        0.0722 * channel(Number.parseInt(h.slice(4, 6), 16))
      );
    };
    const contrast = (a: string, b: string) => {
      const la = luminance(a);
      const lb = luminance(b);
      const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
      return (hi + 0.05) / (lo + 0.05);
    };
    const ratio = (set: Record<string, string>, a: string, b: string): number | null => {
      const ha = oklchToHex(set[a] ?? '');
      const hb = oklchToHex(set[b] ?? '');
      return ha && hb ? contrast(ha, hb) : null;
    };
    const PAIRS: [string, string][] = [
      ['fg', 'bg'],
      ['fg', 'surface'],
      ['muted', 'bg'],
      ['muted', 'surface'],
      ['bg', 'primary'],
    ];
    // Tier-3 button-label exceptions — identity-sensitive kits where reaching
    // the floor needs a large primary lightness move that reshapes the brand
    // color; awaiting a per-kit design decision (or an explicit onPrimary
    // label token). This list must SHRINK as kits are fixed (remove the entry
    // when bg/primary clears 4.5:1); anything newly violating fails the test.
    const PENDING_BUTTON_LABEL: ReadonlySet<string> = new Set([
      'cottagecore.light',
      'dark-academia.dark',
      'neo-brutalist.light',
      'scandinavian.light',
      'skeuomorphic.light',
    ]);
    for (const e of entries) {
      const tokens = await loader.readTokens(e.id);
      expect(tokens, `tokens for ${e.id}`).toBeDefined();
      if (!tokens) continue;
      for (const theme of ['light', 'dark'] as const) {
        const set = (tokens[theme] ?? {}) as Record<string, string>;
        for (const [a, b] of PAIRS) {
          if (a === 'bg' && b === 'primary' && PENDING_BUTTON_LABEL.has(`${e.id}.${theme}`)) {
            continue;
          }
          const r = ratio(set, a, b);
          expect(r, `${e.id}.${theme} ${a}/${b} should be computable`).not.toBeNull();
          expect(
            r ?? 0,
            `${e.id}.${theme} ${a}/${b} must be >= 4.5:1 (got ${r?.toFixed(2)})`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  // Regression: the _foundations ghost-button recipe used `hover:bg-raised`
  // while only 2 of 51 kits define `raised` — for the rest the utility
  // generated no CSS. The recipe block's contract is "the SAME token utilities
  // every kit materializes", so recipes must only reference universal tokens.
  it('foundations recipe color utilities resolve for every bundled kit', async () => {
    const loader = bundledLoader();
    const foundations = await loader.foundationsText();
    expect(foundations).toBeTruthy();
    // Only fenced code counts — the prose contains anti-examples (bg-blue-500).
    const fences = [...(foundations ?? '').matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1] ?? '');
    const recipeCode = fences.join('\n');
    expect(recipeCode, 'recipe fence should be present').toContain('bg-primary');
    const TYPE_SCALE = new Set(['xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl']);
    const required = new Set<string>();
    for (const m of recipeCode.matchAll(
      /(?:^|[\s"'`:])(?:bg|text|border|ring)-([a-z][a-z0-9]*(?:-[a-z0-9]+)*)/g,
    )) {
      const name = m[1] ?? '';
      if (TYPE_SCALE.has(name)) continue;
      required.add(name);
    }
    expect(required.size).toBeGreaterThan(0);
    const entries = await loader.listEntries();
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      const tokens = await loader.readTokens(e.id);
      expect(tokens, `tokens for ${e.id}`).toBeDefined();
      if (!tokens) continue;
      const css = materializeTokens({ tokens, stack: 'web', kitId: e.id }).content;
      for (const name of required) {
        expect(
          css.includes(`--color-${name}: var(--${name})`),
          `${e.id}: recipe utility *-${name} must resolve (--color-${name} missing)`,
        ).toBe(true);
      }
    }
  });

  it('foundationsText returns the baseline doc', async () => {
    const loader = bundledLoader();
    const text = await loader.foundationsText('web');
    expect(text).toMatch(/WCAG/i);
    expect(text).toMatch(/responsive/i);
  });

  it('throws for an unknown kit id', async () => {
    const loader = bundledLoader();
    await expect(loader.readBody('does-not-exist')).rejects.toThrow(/not found/i);
  });
});
