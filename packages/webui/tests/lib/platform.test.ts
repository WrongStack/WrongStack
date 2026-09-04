import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * B-15: every chord label in the app was the literal string "Ctrl", including
 * on macOS — where the handlers accept `e.metaKey` and the user presses ⌘. The
 * labels were wrong on exactly the platform whose users read them most.
 *
 * `IS_APPLE_PLATFORM` is resolved once at module load (the platform cannot
 * change mid-session), so each case here has to stub `navigator` and then
 * re-import the module with a fresh registry.
 */
async function loadPlatform(platform: string | undefined, useUaData = false) {
  vi.resetModules();
  if (platform === undefined) {
    vi.stubGlobal('navigator', undefined);
  } else if (useUaData) {
    vi.stubGlobal('navigator', { userAgentData: { platform }, platform: 'Win32' });
  } else {
    vi.stubGlobal('navigator', { platform });
  }
  return import('../../src/lib/platform.js');
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('platform key labels', () => {
  it.each(['MacIntel', 'macOS', 'iPhone', 'iPad'])('treats %s as an Apple platform', async (p) => {
    const mod = await loadPlatform(p);
    expect(mod.IS_APPLE_PLATFORM).toBe(true);
    expect(mod.MOD_KEY_LABEL).toBe('⌘');
    expect(mod.ALT_KEY_LABEL).toBe('⌥');
    expect(mod.SHIFT_KEY_LABEL).toBe('⇧');
  });

  it.each(['Win32', 'Linux x86_64', ''])('treats %s as non-Apple', async (p) => {
    const mod = await loadPlatform(p);
    expect(mod.IS_APPLE_PLATFORM).toBe(false);
    expect(mod.MOD_KEY_LABEL).toBe('Ctrl');
  });

  // UA-CH is the non-deprecated source and must win over navigator.platform,
  // which Chrome freezes at a legacy value.
  it('prefers navigator.userAgentData.platform over navigator.platform', async () => {
    const mod = await loadPlatform('macOS', true);
    expect(mod.IS_APPLE_PLATFORM).toBe(true);
  });

  it('falls back to non-Apple when there is no navigator at all', async () => {
    const mod = await loadPlatform(undefined);
    expect(mod.IS_APPLE_PLATFORM).toBe(false);
    expect(mod.MOD_KEY_LABEL).toBe('Ctrl');
  });

  it('maps only the three modifier names and passes everything else through', async () => {
    const mod = await loadPlatform('MacIntel');
    expect(mod.platformKeyLabel('Ctrl')).toBe('⌘');
    expect(mod.platformKeyLabel('Alt')).toBe('⌥');
    expect(mod.platformKeyLabel('Shift')).toBe('⇧');
    for (const passthrough of ['K', '1', 'F5', 'Enter', 'Esc', '↑', '\\', '?']) {
      expect(mod.platformKeyLabel(passthrough)).toBe(passthrough);
    }
  });
});

describe('activity shortcut labels follow the platform', () => {
  it('renders ⌘ chords on macOS and Ctrl chords elsewhere', async () => {
    vi.resetModules();
    vi.stubGlobal('navigator', { platform: 'MacIntel' });
    const mac = await import('../../src/lib/view-navigation.js');
    expect(mac.ACTIVITY_SHORTCUT_LABEL_BY_ACTIVITY.chat).toBe('⌘+1');
    expect(mac.ACTIVITY_SHORTCUT_LABEL_BY_ACTIVITY.design).toBe('⌘+0');

    vi.resetModules();
    vi.stubGlobal('navigator', { platform: 'Win32' });
    const win = await import('../../src/lib/view-navigation.js');
    expect(win.ACTIVITY_SHORTCUT_LABEL_BY_ACTIVITY.chat).toBe('Ctrl+1');
    expect(win.ACTIVITY_SHORTCUT_LABEL_BY_ACTIVITY.design).toBe('Ctrl+0');
  });

  /**
   * The label table is derived from the binding table now. A digit rebound in
   * `ACTIVITY_SHORTCUT_BY_KEY` can no longer leave a stale label behind, and
   * `agents` — the one activity with no digit — stays deliberately blank.
   */
  it('derives every label from the binding table', async () => {
    vi.resetModules();
    vi.stubGlobal('navigator', { platform: 'Win32' });
    const nav = await import('../../src/lib/view-navigation.js');
    for (const [digit, activity] of Object.entries(nav.ACTIVITY_SHORTCUT_BY_KEY)) {
      expect(nav.ACTIVITY_SHORTCUT_LABEL_BY_ACTIVITY[activity]).toBe(`Ctrl+${digit}`);
    }
    expect(nav.ACTIVITY_SHORTCUT_LABEL_BY_ACTIVITY.agents).toBe('');
  });
});
