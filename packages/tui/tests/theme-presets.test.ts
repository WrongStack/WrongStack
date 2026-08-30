// Structural invariants for the theme preset registry.
//
// These exist because every bug they guard against actually shipped:
//
//  - 14 of 15 presets set a `monitor.goal` key that is NOT on the `Theme`
//    interface, while `monitor.worktree` / `monitor.phase` — the keys real
//    components read — were never overridden. A `as Record<ThemeName, Theme>`
//    cast on `themePresets` hid it from tsc.
//  - 4 presets never overrode `diffAddBg` / `diffDelBg`, so their diff rows
//    rendered a Catppuccin green/maroon wash on a non-Catppuccin base.
//  - `applyWashTokens` promotes comment tokens to `grayBright`, which was
//    absent from the `pastel` map. `softColor` passes unknown names through
//    and Ink/chalk then drop them, so the token rendered with NO color.
//
// Type-level checks (every id has a preset, no stray keys) are now enforced by
// tsc via `Record<ThemePresetId, Theme>`; this file covers what types cannot:
// value ranges, per-preset override completeness, and palette membership.

import { THEME_PRESET_IDS } from '@wrongstack/core/types';
import { afterEach, describe, expect, it } from 'vitest';
import { applyWashTokens } from '../src/components/history/code-block.js';
import { highlightLine } from '../src/highlight.js';
import {
  getActiveThemeName,
  pastel,
  resolveSyntaxPalette,
  setActiveTheme,
  softColor,
  theme,
  THEME_OPTIONS,
  type Theme,
  themePresets,
} from '../src/theme.js';

const HEX = /^#[0-9a-f]{6}$/;

/** Relative luminance (WCAG 2.x) of a `#rrggbb` string. */
function luminance(hex: string): number {
  const channel = (i: number) => {
    const v = Number.parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

function contrast(fg: string, bg: string): number {
  const [a, b] = [luminance(fg), luminance(bg)].sort((x, y) => y - x) as [number, number];
  return (a + 0.05) / (b + 0.05);
}

/** Every color-valued key on `Theme` (excludes `dim`, `supportsBackground`, `monitor`). */
const COLOR_KEYS = [
  'textPrimary',
  'textSecondary',
  'textMuted',
  'brandPrimary',
  'brandAccent',
  'surface',
  'surfaceRaised',
  'accent',
  'user',
  'assistant',
  'tool',
  'success',
  'warn',
  'error',
  'borderDefault',
  'borderSubtle',
  'borderActive',
  'brand',
  'diffAddBg',
  'diffDelBg',
] as const satisfies readonly (keyof Theme)[];

const MONITOR_KEYS = ['fleet', 'agents', 'worktree', 'phase'] as const;

/**
 * Marker-on-wash contrast floor. 3:1 is the WCAG bar for a bold glyph.
 *
 * `rose-pine` is a documented exception: the palette has no green at all, so
 * `success` is pine (#31748f) — dark enough that NO wash which still reads as
 * a tinted "added" row can clear 3:1. Distorting the palette to satisfy the
 * assertion would be worse than recording the floor here. Listed explicitly
 * (not a blanket lower threshold) so the other 34 presets stay held to 3:1.
 */
const MARKER_CONTRAST_FLOOR: Partial<Record<(typeof THEME_PRESET_IDS)[number], number>> = {
  'rose-pine': 2.4,
};

describe('theme preset registry', () => {
  it('has a palette for every canonical preset id, and no extras', () => {
    expect(Object.keys(themePresets).sort()).toEqual([...THEME_PRESET_IDS].sort());
  });

  it('exposes exactly one picker option per preset, in canonical order', () => {
    expect(THEME_OPTIONS.map((o) => o.id)).toEqual([...THEME_PRESET_IDS]);
    for (const opt of THEME_OPTIONS) {
      expect(opt.name.trim()).not.toBe('');
      expect(opt.description.trim()).not.toBe('');
    }
  });

  it('has no duplicate picker names', () => {
    const names = THEME_OPTIONS.map((o) => o.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe.each(THEME_PRESET_IDS)('preset %s', (id) => {
  const preset = themePresets[id];

  it('defines every color key as a 6-digit lowercase hex', () => {
    for (const key of COLOR_KEYS) {
      expect(preset[key], `${id}.${key}`).toMatch(HEX);
    }
  });

  it('defines exactly the four declared monitor accents — no stray keys', () => {
    // Guards the `goal:` typo: an unknown key here means some component's
    // `theme.monitor.X` is silently frozen at the Catppuccin default.
    expect(Object.keys(preset.monitor).sort()).toEqual([...MONITOR_KEYS].sort());
    for (const key of MONITOR_KEYS) {
      expect(preset.monitor[key], `${id}.monitor.${key}`).toMatch(HEX);
    }
  });

  it('keeps diff washes dark enough for foreground text to stay readable', () => {
    // The wash sits UNDER syntax-highlighted code at full brightness. A light
    // wash inverts the intended contrast and makes the row unreadable.
    for (const key of ['diffAddBg', 'diffDelBg'] as const) {
      expect(luminance(preset[key]), `${id}.${key} luminance`).toBeLessThan(0.25);
    }
  });

  it('distinguishes the add wash from the delete wash', () => {
    expect(preset.diffAddBg).not.toBe(preset.diffDelBg);
  });

  it('renders the +/- markers legibly on their own wash', () => {
    // `DiffBlock` paints `theme.success` on `diffAddBg` and `theme.error` on
    // `diffDelBg`. Below ~3:1 the marker disappears into the row.
    const floor = MARKER_CONTRAST_FLOOR[id] ?? 3;
    expect(contrast(preset.success, preset.diffAddBg), `${id} + marker`).toBeGreaterThan(floor);
    expect(contrast(preset.error, preset.diffDelBg), `${id} - marker`).toBeGreaterThan(floor);
  });

  it('is applied by setActiveTheme and reported back', () => {
    const before = getActiveThemeName();
    expect(setActiveTheme(id), id).toBe(id);
    expect(getActiveThemeName()).toBe(id);
    expect(theme.accent).toBe(preset.accent);
    expect(theme.diffAddBg).toBe(preset.diffAddBg);
    expect(theme.monitor.worktree).toBe(preset.monitor.worktree);
    setActiveTheme(before);
  });

  it('does not inherit optional fields from the previously active preset', () => {
    // `dark-plus` is the only preset carrying an optional `syntax` override.
    // A swap that only COPIES the incoming preset's keys would leave that
    // override behind, so every theme selected after dark-plus would render
    // VS Code's orange strings.
    const before = getActiveThemeName();
    setActiveTheme('dark-plus');
    setActiveTheme(id);
    expect(theme.syntax, `${id} after dark-plus`).toEqual(preset.syntax);
    expect(resolveSyntaxPalette(theme).string, id).toBe(resolveSyntaxPalette(preset).string);
    setActiveTheme(before);
  });

  it('resolves every syntax role to a real hex', () => {
    // The tokenizer emits role NAMES; an unresolvable one is dropped silently
    // by chalk and the token renders colorless. Every role must land on a hex.
    const syntax = resolveSyntaxPalette(preset);
    for (const [role, value] of Object.entries(syntax)) {
      expect(value, `${id}.syntax.${role}`).toMatch(HEX);
    }
  });

  it('keeps syntax roles readable on the preset surface', () => {
    // Code is normally read against `surface`, not a wash. 3:1 is the floor
    // for a glyph; comments are allowed to recede but must not vanish.
    const syntax = resolveSyntaxPalette(preset);
    for (const role of ['keyword', 'string', 'number', 'property'] as const) {
      expect(contrast(syntax[role], preset.surface), `${id}.syntax.${role}`).toBeGreaterThan(3);
    }
    expect(contrast(syntax.comment, preset.surface), `${id}.syntax.comment`).toBeGreaterThan(1.9);
  });

  it('keeps wash-promoted comment tokens above WCAG AA on both washes', () => {
    // `applyWashTokens` re-points syntax.comment → syntax.commentOnWash.
    // Both sides are roles, so this resolves per-preset.
    const [promoted] = applyWashTokens(
      [{ text: '// x', color: 'syntax.comment', dim: true }],
      true,
    );
    expect(promoted?.color).toBe('syntax.commentOnWash');
    const resolved = resolveSyntaxColorFor(preset, promoted?.color);
    expect(resolved, 'promoted comment color must resolve to a hex').toMatch(HEX);
    expect(contrast(resolved, preset.diffAddBg)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(resolved, preset.diffDelBg)).toBeGreaterThanOrEqual(4.5);
  });
});

/** Resolve a `syntax.*` name against a SPECIFIC preset (not the active theme). */
function resolveSyntaxColorFor(preset: Theme, name: string | undefined): string {
  const role = String(name).slice('syntax.'.length);
  return (resolveSyntaxPalette(preset) as Record<string, string>)[role] as string;
}

describe('syntax highlighting follows the active theme', () => {
  it('resolves the same token to different colors under different presets', () => {
    // The regression this guards: `highlight.ts` used to emit literal ANSI
    // names, which `softColor` mapped through the FROZEN `pastel` map — so a
    // Gruvbox diff rendered Catppuccin-purple keywords.
    const keyword = highlightLine('const x = 1', 'ts').tokens.find((t) => t.text === 'const');
    expect(keyword?.color).toBe('syntax.keyword');

    const before = setActiveTheme('catppuccin');
    const catppuccinKeyword = softColor(keyword?.color);
    setActiveTheme('gruvbox-material');
    const gruvboxKeyword = softColor(keyword?.color);
    setActiveTheme(before);

    expect(catppuccinKeyword).toMatch(HEX);
    expect(gruvboxKeyword).toMatch(HEX);
    expect(catppuccinKeyword).not.toBe(gruvboxKeyword);
    expect(gruvboxKeyword).toBe(themePresets['gruvbox-material'].brand);
  });

  it('restores the previous preset so later tests see a stable palette', () => {
    expect(softColor('syntax.keyword')).toMatch(HEX);
  });
});

describe('pastel palette', () => {
  it('resolves every syntax role name softColor can be handed', () => {
    // Regression: `grayBright` was emitted by applyWashTokens but never
    // defined in `pastel`, so Ink dropped it and the token rendered colorless.
    for (const role of Object.keys(resolveSyntaxPalette())) {
      expect(softColor(`syntax.${role}`), role).toMatch(HEX);
    }
  });

  it('passes an unknown syntax role through instead of inventing a color', () => {
    expect(softColor('syntax.nope')).toBe('syntax.nope');
  });

  it('maps every entry to a 6-digit lowercase hex', () => {
    for (const [name, value] of Object.entries(pastel)) {
      expect(value, name).toMatch(HEX);
    }
  });
});

// Bare ANSI names (`color="cyan"`) used to resolve against the FROZEN pastel
// map, so ~179 call sites stayed Catppuccin-coloured under every other preset —
// picking Gruvbox recoloured the tokenized chrome and left these behind. They
// now route through ANSI_TOKEN to the active palette.
describe('bare ANSI names follow the active theme', () => {
  const MAPPED: ReadonlyArray<[string, keyof Theme]> = [
    ['cyan', 'accent'],
    ['yellow', 'warn'],
    ['green', 'success'],
    ['red', 'error'],
    ['magenta', 'brand'],
    ['white', 'textPrimary'],
  ];

  afterEach(() => {
    setActiveTheme('catppuccin');
  });

  it('is a byte-identical no-op on the default preset', () => {
    setActiveTheme('catppuccin');
    for (const [name] of MAPPED) {
      expect(softColor(name), name).toBe((pastel as Record<string, string>)[name]);
    }
  });

  it('resolves to the active preset token for every preset', () => {
    for (const id of THEME_PRESET_IDS) {
      setActiveTheme(id);
      for (const [name, token] of MAPPED) {
        expect(softColor(name), `${id}/${name}`).toBe(themePresets[id][token] as string);
      }
    }
  });

  it('actually changes colour when the preset changes', () => {
    setActiveTheme('catppuccin');
    const before = MAPPED.map(([name]) => softColor(name));
    setActiveTheme('gruvbox-dark');
    const after = MAPPED.map(([name]) => softColor(name));
    expect(after).not.toEqual(before);
  });

  it('leaves unmapped names on the frozen floor', () => {
    setActiveTheme('gruvbox-dark');
    // No token equals these on Catppuccin, so mapping them would move the
    // default theme — they intentionally stay pinned.
    expect(softColor('gray')).toBe(pastel.gray);
    expect(softColor('blue')).toBe(pastel.blue);
    expect(softColor('grayBright')).toBe(pastel.grayBright);
    // Unknown names still pass through untouched.
    expect(softColor('transparent')).toBe('transparent');
    expect(softColor('#abcdef')).toBe('#abcdef');
  });

  it('mixHexColors handles 3-digit and 6-digit hex codes', async () => {
    const { mixHexColors } = await import('../src/theme-utils.js');
    expect(mixHexColors('#fff', '#000', 0.5)).toBe('#808080');
    expect(mixHexColors('#ffffff', '#000000', 0)).toBe('#000000');
    expect(mixHexColors('#ffffff', '#000000', 1)).toBe('#ffffff');
  });
});
