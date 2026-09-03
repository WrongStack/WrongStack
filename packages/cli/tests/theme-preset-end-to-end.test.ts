// End-to-end proof that EVERY canonical preset is actually selectable, not
// just declared. The preset list is consumed by four independent surfaces:
//
//   1. `THEME_PRESET_IDS`            (core)  — the canonical list
//   2. `/theme <preset>`             (cli)   — direct switch + persistence
//   3. `/theme` interactive picker   (cli)   — arrow-key menu
//   4. `createThemeAdapter`          (cli)   — boot read + disk write
//
// They used to keep four hand-maintained copies, which drifted: a preset added
// to the TUI but missed in the adapter's `VALID_PRESETS` was rejected at save
// time with "Unknown theme preset". Everything now derives from (1), and this
// test walks all 35 through (2), (3) and (4) for real — including the disk
// round-trip — so "declared" and "usable" cannot diverge silently again.
//
// The TUI half of the contract (a palette + picker row exists for every id)
// lives in `packages/tui/tests/theme-presets.test.ts`; importing the TUI from
// a CLI test would invert the package dependency.

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { SlashCommandRegistry } from '@wrongstack/core/registry';
import { THEME_PRESET_IDS, type ThemePresetId } from '@wrongstack/core/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createThemeAdapter } from '../src/boot/tui-theme-adapter.js';
import { buildThemeCommand } from '../src/slash-commands/theme.js';

/** Minimal in-memory ConfigStore good enough for the theme surfaces. */
function makeConfigStore(initial: Record<string, unknown> = {}) {
  let state = { ...initial };
  return {
    store: {
      get: () => state,
      update: (patch: Record<string, unknown>) => {
        state = { ...state, ...patch };
      },
    },
    current: () => state,
  };
}

describe('every canonical preset is selectable', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'wstack-theme-e2e-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('exposes 64 presets — the count is pinned so a silent drop is visible', () => {
    expect(THEME_PRESET_IDS).toHaveLength(64);
    expect(new Set(THEME_PRESET_IDS).size).toBe(64);
  });

  it.each(THEME_PRESET_IDS)('/theme %s switches and persists to the config store', async (id) => {
    const { store, current } = makeConfigStore({ themePreset: 'catppuccin' });
    const reg = new SlashCommandRegistry();
    reg.register(buildThemeCommand({ configStore: store } as never));

    const res = await reg.dispatch(`/theme ${id}`, {} as never);
    expect(res?.message, id).toContain(`Switched TUI theme preset to "${id}"`);
    expect(res?.message, id).not.toContain('Unknown theme preset');
    expect(res?.metadata?.themePreset).toBe(id);
    expect(current().themePreset).toBe(id);
  });

  it.each(THEME_PRESET_IDS)('the boot adapter round-trips %s through disk', async (id) => {
    const { store } = makeConfigStore({});
    const configPath = path.join(dir, `${id}.json`);
    const adapter = createThemeAdapter({
      configStore: store as never,
      wpaths: { profileConfig: () => configPath } as never,
    });

    await adapter.saveThemePreset(id);

    // Memory reflects it immediately…
    expect(adapter.getThemePreset(), id).toBe(id);
    // …and so does the file the next boot will read.
    const onDisk = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    expect(onDisk.themePreset, id).toBe(id);
  });

  it('lists every preset in the no-arg output, with its human label', async () => {
    const reg = new SlashCommandRegistry();
    reg.register(buildThemeCommand({} as never));
    const res = await reg.dispatch('/theme', {} as never);
    const message = res?.message ?? '';
    for (const id of THEME_PRESET_IDS) {
      expect(message, id).toContain(id);
    }
    // A missing THEME_META entry would render as `undefined` next to the id.
    expect(message).not.toContain('undefined');
  });

  it('reaches every preset by arrow key in the interactive picker', async () => {
    // Walk ↓ from the top and Enter on the last row: proves the picker's
    // cursor covers the whole list rather than a stale slice of it.
    const target = THEME_PRESET_IDS.at(-1) as ThemePresetId;
    const keys = [...Array(THEME_PRESET_IDS.length - 1).fill('down'), 'enter'];
    let i = 0;
    const reader = { readKey: async () => keys[i++] };

    const { store, current } = makeConfigStore({ themePreset: 'catppuccin' });
    const reg = new SlashCommandRegistry();
    reg.register(buildThemeCommand({ configStore: store, inputReader: reader } as never));

    const res = await reg.dispatch('/theme', {} as never);
    expect(res?.metadata?.themePreset).toBe(target);
    expect(current().themePreset).toBe(target);
  });

  it('still rejects an id that is not in the canonical list', async () => {
    const reg = new SlashCommandRegistry();
    reg.register(buildThemeCommand({} as never));
    const res = await reg.dispatch('/theme not-a-real-theme', {} as never);
    expect(res?.message).toContain('Unknown theme preset "not-a-real-theme"');

    const { store } = makeConfigStore({});
    const adapter = createThemeAdapter({
      configStore: store as never,
      wpaths: { profileConfig: () => path.join(dir, 'reject.json') } as never,
    });
    await expect(adapter.saveThemePreset('not-a-real-theme' as ThemePresetId)).rejects.toThrow(
      /Unknown theme preset/,
    );
  });

  it('ignores a stale preset left in config by an older/newer build', async () => {
    // Forward-compat: a config written by a build that knew more presets must
    // not wedge boot — the adapter reports "unset" and the TUI falls back.
    const { store } = makeConfigStore({ themePreset: 'from-the-future' });
    const adapter = createThemeAdapter({
      configStore: store as never,
      wpaths: { profileConfig: () => path.join(dir, 'stale.json') } as never,
    });
    expect(adapter.getThemePreset()).toBeUndefined();
  });
});
