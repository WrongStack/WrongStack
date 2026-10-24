/**
 * TUI Theme adapter — extracts the getThemePreset/saveThemePreset pair from
 * the runTui() options literal.
 *
 * Mirrors the `createSettingsAdapter` shape (see `./tui-settings-adapter.ts`)
 * but is much narrower: theme is a single enum-valued key, so there's no
 * section merge, no schema fan-out, and no encrypted-secret dance (the
 * value is a plain preset name, not a credential).
 *
 * The disk write goes to the active profile's config file (same target
 * `createSettingsAdapter` writes) so both layers share the same source of
 * truth: future TUI boots read `themePreset` from the same JSON file the
 * CLI writes via `/theme` and the WebUI flips via Settings.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Config, ConfigStore, ThemePresetId } from '@wrongstack/contracts/types';
import { THEME_PRESET_IDS } from '@wrongstack/contracts/types';
import { updateJsonObjectFile, type WstackPaths } from '@wrongstack/core/utils';
import { backupCurrent } from '../config-history.js';
import { activeProfileConfigPath } from '../profile-config-path.js';

/**
 * Set of valid preset ids, derived from the canonical `THEME_PRESET_IDS` in
 * core. This used to be a hand-maintained copy, which silently drifted out of
 * lockstep with `packages/tui/src/theme.ts` — a preset added there but missed
 * here was rejected at save time with "Unknown theme preset". Deriving it
 * makes that class of drift impossible.
 */
const VALID_PRESETS: ReadonlySet<string> = new Set(THEME_PRESET_IDS);

function isThemePresetId(candidate: string): candidate is ThemePresetId {
  return VALID_PRESETS.has(candidate);
}

interface ThemeAdapterDeps {
  configStore: ConfigStore;
  wpaths: Pick<WstackPaths, 'profileConfig'>;
}

interface ThemeAdapter {
  /** Read the live preset (memory-backed). Returns undefined when unset. */
  getThemePreset: () => ThemePresetId | undefined;
  /**
   * Persist a new preset to BOTH the in-memory configStore (so the running
   * session sees it immediately) and the active profile's config file on
   * disk (so the next boot starts with this preset applied). Unknown ids
   * are rejected without writing.
   */
  saveThemePreset: (preset: ThemePresetId) => Promise<void>;
}

export function createThemeAdapter({ configStore, wpaths }: ThemeAdapterDeps): ThemeAdapter {
  return {
    getThemePreset: () => {
      const live = configStore.get() as Pick<Config, 'themePreset'>;
      const candidate = live.themePreset;
      return candidate && isThemePresetId(candidate) ? candidate : undefined;
    },
    saveThemePreset: async (preset: ThemePresetId) => {
      if (!isThemePresetId(preset)) {
        throw new Error(`Unknown theme preset: ${preset}`);
      }
      // Persist to disk first. A failed write must not leave the running UI
      // claiming a theme that will disappear on restart.
      // settings adapter targets so the source of truth stays single-file.
      const configPath = activeProfileConfigPath(wpaths, configStore.get());
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await updateJsonObjectFile(configPath, async (config) => {
        await backupCurrent(undefined, configPath);
        config.themePreset = preset;
      });
      configStore.update({ themePreset: preset });
    },
  };
}
