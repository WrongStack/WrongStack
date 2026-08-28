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
import type { Config, ConfigStore, ThemePresetId } from '@wrongstack/core/types';
import { THEME_PRESET_IDS } from '@wrongstack/core/types';
import { atomicWrite, type WstackPaths } from '@wrongstack/core/utils';
import { activeProfileConfigPath } from '../profile-config-path.js';

/**
 * Set of valid preset ids, derived from the canonical `THEME_PRESET_IDS` in
 * core. This used to be a hand-maintained copy, which silently drifted out of
 * lockstep with `packages/tui/src/theme.ts` — a preset added there but missed
 * here was rejected at save time with "Unknown theme preset". Deriving it
 * makes that class of drift impossible.
 */
const VALID_PRESETS: ReadonlySet<ThemePresetId> = new Set<ThemePresetId>(THEME_PRESET_IDS);

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
      return candidate && VALID_PRESETS.has(candidate) ? candidate : undefined;
    },
    saveThemePreset: async (preset: ThemePresetId) => {
      if (!VALID_PRESETS.has(preset)) {
        throw new Error(`Unknown theme preset: ${preset}`);
      }
      // Memory update first so any concurrent read sees the new value
      // before the disk write completes (mirrors createSettingsAdapter).
      configStore.update({ themePreset: preset });

      // Then persist to disk. We read-modify-write the same JSON file the
      // settings adapter targets so the source of truth stays single-file.
      const configPath = activeProfileConfigPath(wpaths, configStore.get());
      let parsed: Record<string, unknown> = {};
      try {
        const raw = await fs.readFile(configPath, 'utf8');
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code !== 'ENOENT') {
          // ENOENT = first-ever boot, the file just doesn't exist yet.
          // Anything else (parse error, permission) surfaces to the caller
          // so the UI can show an error rather than silently dropping the
          // user's choice.
          throw err;
        }
      }
      parsed.themePreset = preset;
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await atomicWrite(configPath, JSON.stringify(parsed, null, 2), { mode: 0o600 });
    },
  };
}
