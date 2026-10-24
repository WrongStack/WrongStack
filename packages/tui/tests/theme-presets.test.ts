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

import { THEME_PRESET_IDS } from '@wrongstack/contracts/types';
import { afterEach, describe, expect, it } from 'vitest';
import { STATUS } from '../src/components/agents-monitor-constants.js';
import { applyWashTokens } from '../src/components/history/code-block.js';
import { UI_COLORS } from '../src/components/provider-colors.js';
import { contextBarColor } from '../src/components/status-bar-format.js';
import { highlightLine } from '../src/highlight.js';
import { statuslineBackgrounds } from '../src/statusline-palette.js';
import {
  baseTheme,
  getActiveThemeName,
  pastel,
  resolveSyntaxPalette,
  setActiveTheme,
  softColor,
  THEME_OPTIONS,
  type Theme,
  theme,
  themePresets,
} from '../src/theme.js';

const HEX = /^#[0-9a-f]{6}$/;
const startupTheme = { ...theme };

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
 * The map is now EMPTY: `rose-pine` used to sit here at 2.4 because its
 * `success` was pine (#31748f), too dark to clear 3:1 on any wash that still
 * reads as a tinted "added" row. That was the recorded "dark marker on a
 * near-black base" trap — the marker itself had to move, not the wash. It now
 * uses #3e8fb0, the pine-teal `rose-pine-moon` already shipped in this family,
 * which measures 3.55:1 on the same wash. Kept as a map (rather than deleted)
 * so a future palette that genuinely needs an exception is an explicit,
 * reviewable entry instead of a loosened global threshold.
 */
const MARKER_CONTRAST_FLOOR: Partial<Record<(typeof THEME_PRESET_IDS)[number], number>> = {};

describe('theme preset registry', () => {
  it('boots with the same palette as explicitly selecting the default theme', () => {
    expect(startupTheme).toEqual(themePresets.catppuccin);
  });
  it.each(['constructor', 'toString', '__proto__'])('ignores inherited preset name %s', (name) => {
    setActiveTheme('catppuccin');
    try {
      expect(setActiveTheme(name)).toBe('catppuccin');
      expect(theme).toEqual(themePresets.catppuccin);
    } finally {
      setActiveTheme('catppuccin');
    }
  });
  it('has a palette for every canonical preset id, and no extras', () => {
    expect(Object.keys(themePresets).sort()).toEqual([...THEME_PRESET_IDS].sort());
  });

  it('exposes exactly one picker option per preset, grouped by family', () => {
    // One row per canonical id, no extras and none missing. Order is grouped
    // by family rather than raw `THEME_PRESET_IDS` order: the picker renders
    // family headers, and a family whose members are scattered ~15 rows apart
    // is not actually grouped. The set of ids is what must not drift.
    expect(THEME_OPTIONS.map((o) => o.id).sort()).toEqual([...THEME_PRESET_IDS].sort());
    for (const opt of THEME_OPTIONS) {
      expect(opt.name.trim()).not.toBe('');
      expect(opt.description.trim()).not.toBe('');
      expect(opt.family.trim()).not.toBe('');
    }
    // Canonical order preserved WITHIN each family group, and each family
    // occupies exactly one contiguous run.
    //
    // `seen` MUST be seeded with the first option's family: the loop below
    // starts at i=1 and only records indices >= 1, so without the seed a family
    // that appears at index 0 and reappears later (e.g. [A, B, ..., A]) is
    // never in `seen` at the repeat and the contiguity check passes — voiding
    // the exact guarantee this assertion exists to make.
    const seen = new Set<string>([THEME_OPTIONS[0]!.family]);
    for (let i = 1; i < THEME_OPTIONS.length; i += 1) {
      const prevIndex = THEME_PRESET_IDS.indexOf(THEME_OPTIONS[i - 1]!.id);
      const curIndex = THEME_PRESET_IDS.indexOf(THEME_OPTIONS[i]!.id);
      if (THEME_OPTIONS[i - 1]!.family === THEME_OPTIONS[i]!.family) {
        expect(curIndex, `within ${THEME_OPTIONS[i]!.family}`).toBeGreaterThan(prevIndex);
      } else {
        expect(seen.has(THEME_OPTIONS[i]!.family), 'family groups are contiguous').toBe(false);
      }
      seen.add(THEME_OPTIONS[i]!.family);
    }
  });

  it('has no duplicate picker names', () => {
    const names = THEME_OPTIONS.map((o) => o.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe.each(THEME_PRESET_IDS)('preset %s', (id) => {
  const preset = themePresets[id];

  it('updates F3 status colors and the context meter after a theme switch', () => {
    const before = getActiveThemeName();
    try {
      setActiveTheme(id);
      expect(STATUS.idle.color).toBe(preset.textMuted);
      expect(STATUS.running.color).toBe(preset.warn);
      expect(STATUS.success.color).toBe(preset.success);
      expect(STATUS.failed.color).toBe(preset.error);
      expect(contextBarColor(0.6)).toBe(preset.brandPrimary);
      expect(UI_COLORS.focused).toBe(preset.accent);
      expect(UI_COLORS.error).toBe(preset.error);
      expect(UI_COLORS.inactive).toBe(preset.textMuted);
      for (const [alias, token] of Object.entries({
        blue: 'brandPrimary',
        gray: 'textMuted',
        grey: 'textMuted',
        grayBright: 'textSecondary',
        blueBright: 'accent',
        redBright: 'error',
        greenBright: 'success',
        yellowBright: 'warn',
        magentaBright: 'brand',
      })) {
        expect(softColor(alias), `${id}/${alias}`).toBe(preset[token as keyof Theme]);
      }
    } finally {
      setActiveTheme(before);
    }
  });

  it('keeps statusline text readable on every segment tone', () => {
    for (const background of statuslineBackgrounds(preset)) {
      expect(
        contrast(preset.textPrimary, background),
        `${id}/${background}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

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

  it('meets the body-text and panel floors the 2026-09 rework established', () => {
    // Body text carries the transcript, and it is painted on BOTH surfaces:
    // panels raise to `surfaceRaised`, which is a lighter base than `surface`.
    expect(contrast(preset.textPrimary, preset.surface), `${id} body`).toBeGreaterThanOrEqual(4.5);
    expect(
      contrast(preset.textPrimary, preset.surfaceRaised),
      `${id} body/raised`,
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrast(preset.textSecondary, preset.surface),
      `${id} secondary`,
    ).toBeGreaterThanOrEqual(4.5);
    // `textMuted` drives `syntax.comment`. A comment is allowed to recede, but
    // ten presets sat under 3:1 — effectively invisible — before the rework.
    expect(contrast(preset.textMuted, preset.surface), `${id} muted`).toBeGreaterThanOrEqual(3);
    // Emphasis hierarchy. Two new ports shipped `textSecondary` BRIGHTER than
    // `textPrimary` while chasing a wash rule, which inverts what the reader
    // is told to prioritise.
    expect(
      luminance(preset.textPrimary),
      `${id} primary not brighter than secondary`,
    ).toBeGreaterThan(luminance(preset.textSecondary));
    expect(
      luminance(preset.textSecondary),
      `${id} secondary not brighter than muted`,
    ).toBeGreaterThan(luminance(preset.textMuted));
    // A panel edge has to be findable, and a raised panel has to be raised.
    expect(contrast(preset.borderDefault, preset.surface), `${id} border`).toBeGreaterThanOrEqual(
      1.3,
    );
    expect(preset.surface, `${id} has no elevation`).not.toBe(preset.surfaceRaised);
    expect(preset.borderSubtle, `${id} divider vanishes on a raised card`).not.toBe(
      preset.surfaceRaised,
    );
    expect(preset.borderSubtle, `${id} divider vanishes on the base`).not.toBe(preset.surface);
    // `borderSubtle` is the quieter sibling of `borderDefault` by definition.
    expect(
      contrast(preset.borderSubtle, preset.surface),
      `${id} borderSubtle outranks borderDefault`,
    ).toBeLessThan(contrast(preset.borderDefault, preset.surface));
    expect(
      contrast(preset.borderActive, preset.surface),
      `${id} borderActive`,
    ).toBeGreaterThanOrEqual(2);
    for (const role of ['success', 'warn', 'error', 'accent'] as const) {
      expect(contrast(preset[role], preset.surface), `${id} ${role}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('keeps the three transcript roles tellable apart', () => {
    // USER / ASSISTANT / tool rows are what a reader scans for. Before the
    // rework, `assistant == tool == accent` in several presets, so tool output
    // and prose rendered in one colour. `warn` deliberately shares the user hue
    // (a house convention across the registry), so it is NOT in this set.
    const roles = [preset.user, preset.assistant, preset.tool];
    expect(new Set(roles).size, `${id} role colours: ${roles.join(' ')}`).toBe(3);
    // The prompt colour must never double as the failure colour.
    expect(preset.accent, `${id} accent == error`).not.toBe(preset.error);
  });

  it('does not carry Catppuccin body text on a non-Catppuccin palette', () => {
    // The original bug class, and the reason every colour key is now written
    // out per preset: 14 presets spread `...baseTheme` and never overrode the
    // text tokens, so e.g. Gruvbox rendered Mocha's lavender body text.
    if (id === 'catppuccin') return;
    for (const key of ['textPrimary', 'textSecondary', 'textMuted'] as const) {
      expect(preset[key], `${id}.${key} is still the Catppuccin value`).not.toBe(baseTheme[key]);
    }
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

  it('maps remaining ANSI colors to the active theme', () => {
    setActiveTheme('gruvbox-dark');
    expect(softColor('gray')).toBe(theme.textMuted);
    expect(softColor('blue')).toBe(theme.brandPrimary);
    expect(softColor('grayBright')).toBe(theme.textSecondary);
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
