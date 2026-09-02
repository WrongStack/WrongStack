import { describe, expect, it } from 'vitest';
import { SlashCommandRegistry } from '@wrongstack/core/registry';
import { THEME_PRESET_IDS } from '@wrongstack/core/types';
import { buildThemeCommand, computeWindow, truncateDesc } from '../src/slash-commands/theme.js';

describe('/theme slash command', () => {
  it('registers in SlashCommandRegistry and lists theme options when no arg is passed', async () => {
    const reg = new SlashCommandRegistry();
    const cmd = buildThemeCommand({} as never);
    reg.register(cmd);

    expect(reg.get('theme')).toBeDefined();
    const res = await reg.dispatch('/theme', {} as never);
    expect(res).not.toBeNull();
    expect(res?.message).toContain('Available Theme Presets:');
    expect(res?.message).toContain('catppuccin');
    expect(res?.message).toContain('tokyo-night');
    expect(res?.message).toContain('nord');
    expect(res?.message).toContain('cyberpunk');
    expect(res?.message).toContain('dracula');
  });

  it('switches theme to a valid preset and rejects unknown presets', async () => {
    let updatedConfig: Record<string, unknown> | null = null;
    const fakeConfigStore = {
      get: () => ({ themePreset: 'catppuccin' }),
      update: (patch: Record<string, unknown>) => {
        updatedConfig = patch;
      },
    };
    const reg = new SlashCommandRegistry();
    const cmd = buildThemeCommand({ configStore: fakeConfigStore } as never);
    reg.register(cmd);

    const validRes = await reg.dispatch('/theme cyberpunk', {} as never);
    expect(validRes).not.toBeNull();
    expect(validRes?.message).toContain('Switched TUI theme preset to "cyberpunk"');
    expect(validRes?.metadata?.themePreset).toBe('cyberpunk');
    expect(updatedConfig).toEqual({ themePreset: 'cyberpunk' });

    const invalidRes = await reg.dispatch('/theme invalid-preset', {} as never);
    expect(invalidRes).not.toBeNull();
    expect(invalidRes?.message).toContain('Unknown theme preset "invalid-preset"');
  });
});

describe('computeWindow (raw picker windowing math)', () => {
  // Contract mirrors useWindowedPicker: chrome 5 (blank, title, hint, blank,
  // trailing blank) + markerRows 2 (worst-case `… more above`/`… more below`),
  // minVisible 3, top-aligned first page, centered + clamped afterwards.
  const PRESETS = THEME_PRESET_IDS.length;

  it('never renders all presets on a 24-row terminal — budget caps the window', () => {
    const w = computeWindow(PRESETS, 0, 24);
    // 24 rows − 5 chrome − 2 marker slots = 17 visible options max.
    expect(w.end - w.start).toBe(17);
    expect(w.end - w.start).toBeLessThan(PRESETS);
  });

  it('grows the window on a tall terminal and shows all presets once they fit', () => {
    const w = computeWindow(PRESETS, 0, 60);
    expect(w.start).toBe(0);
    expect(w.end).toBe(PRESETS);
    expect(w.hasAbove).toBe(false);
    expect(w.hasBelow).toBe(false);
  });

  it('shows markers above and below when the window is centered mid-list', () => {
    const w = computeWindow(PRESETS, 20, 24);
    expect(w.hasAbove).toBe(true);
    expect(w.hasBelow).toBe(true);
    expect(w.start).toBeLessThanOrEqual(20);
    expect(w.end).toBeGreaterThan(20);
    // Center on selected with a half-window offset: visible 17 → start 12.
    expect(w.start).toBe(20 - Math.floor(17 / 2));
  });

  it('top-aligns on the first page and never reports above when start is 0', () => {
    const w = computeWindow(PRESETS, 0, 24);
    expect(w.start).toBe(0);
    expect(w.hasAbove).toBe(false);
    expect(w.hasBelow).toBe(true);
  });

  it('clamps the window to the list end so the focused row stays visible', () => {
    const w = computeWindow(PRESETS, PRESETS - 1, 24);
    expect(w.end).toBe(PRESETS);
    expect(w.hasBelow).toBe(false);
    expect(w.hasAbove).toBe(true);
    // start pulled back so end lands exactly on the last preset.
    expect(w.start).toBe(PRESETS - 17);
  });

  it('clamps out-of-range selection to 0 (mirrors the picker cursor init)', () => {
    expect(computeWindow(PRESETS, -1, 24).start).toBe(0);
    expect(computeWindow(PRESETS, PRESETS, 24).start).toBe(0);
    expect(computeWindow(PRESETS, -1, 24).end - computeWindow(PRESETS, -1, 24).start).toBe(17);
  });

  it('returns an empty window for a zero-length list', () => {
    expect(computeWindow(0, 0, 24)).toEqual({
      start: 0,
      end: 0,
      hasAbove: false,
      hasBelow: false,
    });
  });

  it('enforces minVisible on a tiny terminal rather than hiding the focus', () => {
    const w = computeWindow(PRESETS, 0, 5);
    // 5 rows − 7 reserved = 0 → clamp to minVisible 3.
    expect(w.end - w.start).toBe(3);
  });

  it('never shows more options than exist for small lists', () => {
    const w = computeWindow(2, 0, 24);
    expect(w.start).toBe(0);
    expect(w.end).toBe(2);
    expect(w.hasBelow).toBe(false);
  });
});

describe('truncateDesc (narrow-terminal wrap guard)', () => {
  it('keeps a short description unchanged', () => {
    expect(truncateDesc('Soft pastel dark theme', 80, false)).toBe('Soft pastel dark theme');
  });

  it('truncates a long description to the budget (columns − 26 chrome, inactive)', () => {
    const desc = 'x'.repeat(100);
    const out = truncateDesc(desc, 60, false);
    // budget = 60 − 26 = 34 → 33 chars + ellipsis.
    expect(out.length).toBe(34);
    expect(out.endsWith('…')).toBe(true);
    expect(out.startsWith('x'.repeat(33))).toBe(true);
  });

  it('reserves the 9-column [active] mark when the option is active', () => {
    const desc = 'x'.repeat(100);
    const inactive = truncateDesc(desc, 60, false);
    const active = truncateDesc(desc, 60, true);
    // budget active = 60 − 26 − 9 = 25 → 24 + ellipsis.
    expect(active.length).toBe(25);
    expect(inactive.length).toBeGreaterThan(active.length);
  });

  it('returns just an ellipsis when the budget is 1 column or less', () => {
    expect(truncateDesc('x'.repeat(50), 27, true)).toBe('…');
    expect(truncateDesc('x'.repeat(50), 26, false)).toBe('…');
  });

  it('clamps the budget to 0 on an impossibly narrow terminal and returns the ellipsis', () => {
    expect(truncateDesc('x'.repeat(50), 20, false)).toBe('…');
  });
});
