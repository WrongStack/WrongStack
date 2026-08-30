import type { LocalPrefs } from '@/stores/local-prefs';

/**
 * Apply one settings-panel preference change to every surface that tracks it:
 * the persisted local store, the live server-side prefs, and — for context
 * mode — the active conversation's context-window setting.
 */
export function syncSettingsPreference(
  localPrefs: Pick<LocalPrefs, 'set'>,
  updatePrefs: (prefs: Record<string, unknown>) => void,
  switchContextMode: (id: string) => void,
  key: string,
  value: unknown,
): void {
  localPrefs.set({ [key]: value } as Parameters<LocalPrefs['set']>[0]);
  updatePrefs({ [key]: value });
  if (key === 'contextMode' && typeof value === 'string') {
    switchContextMode(value);
  }
}
