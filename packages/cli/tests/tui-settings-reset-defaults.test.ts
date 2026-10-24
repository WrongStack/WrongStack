/**
 * `/settings reset <name>` (and the picker's reset) writes
 * `SETTINGS_DEFAULTS[key]`. Those values must be what a fresh install
 * actually runs with — the core config defaults as the TUI reads them —
 * or "reset to default" silently lands on a different value. Drifted
 * before: auto-proceed delay (0 vs 15s), cache TTL (default vs 1h), SAGE
 * inject visibility (on vs off) and threshold (0.85 vs 0.9).
 */

import type { ConfigStore } from '@wrongstack/contracts/types';
import { CONFIG_BEHAVIOR_DEFAULTS } from '@wrongstack/core/storage';
import { describe, expect, it } from 'vitest';
import { SETTINGS_DEFAULTS } from '../../tui/src/components/settings-picker-model.js';
import { readTuiSettings } from '../src/boot/tui-settings-read.js';

/** Picker keys whose `readTuiSettings` field has another name. */
const READ_KEY: Record<string, string> = {
  fleetChat: 'fleetChatVerbosity',
  tokenSavingTier: 'featureTokenSaving',
  // The adapter layers the next-session pick over the live variant.
  nextSystemPromptVariant: 'systemPromptVariant',
};

/** No core default exists — the picker owns the fallback. */
const PICKER_OWNED = new Set(['wrongProxyUrl']);

describe('TUI settings reset targets match the core config defaults', () => {
  const cfg = structuredClone(CONFIG_BEHAVIOR_DEFAULTS);
  const live = readTuiSettings({ get: () => cfg } as unknown as ConfigStore);

  for (const [key, resetValue] of Object.entries(SETTINGS_DEFAULTS)) {
    if (PICKER_OWNED.has(key)) continue;
    it(key, () => {
      const readKey = READ_KEY[key] ?? key;
      expect(live).toHaveProperty(readKey);
      expect(resetValue).toEqual(live[readKey]);
    });
  }
});
