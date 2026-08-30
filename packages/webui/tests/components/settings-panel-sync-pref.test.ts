import { describe, expect, it, vi } from 'vitest';
import { syncSettingsPreference } from '../../src/components/SettingsPanel/sync-settings-preference';

describe('SettingsPanel preference sync', () => {
  it('applies ordinary preferences locally and through prefs.update only', () => {
    const localPrefs = { set: vi.fn() };
    const updatePrefs = vi.fn();
    const switchContextMode = vi.fn();

    syncSettingsPreference(localPrefs as never, updatePrefs, switchContextMode, 'yolo', true);

    expect(localPrefs.set).toHaveBeenCalledWith({ yolo: true });
    expect(updatePrefs).toHaveBeenCalledWith({ yolo: true });
    expect(switchContextMode).not.toHaveBeenCalled();
  });

  it('also switches the live context-window mode for contextMode changes', () => {
    const localPrefs = { set: vi.fn() };
    const updatePrefs = vi.fn();
    const switchContextMode = vi.fn();

    syncSettingsPreference(
      localPrefs as never,
      updatePrefs,
      switchContextMode,
      'contextMode',
      'balanced',
    );

    expect(localPrefs.set).toHaveBeenCalledWith({ contextMode: 'balanced' });
    expect(updatePrefs).toHaveBeenCalledWith({ contextMode: 'balanced' });
    expect(switchContextMode).toHaveBeenCalledWith('balanced');
  });
});
