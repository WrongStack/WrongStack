/**
 * Platform-dependent presentation details.
 *
 * The keyboard handlers throughout the app already accept either modifier
 * (`e.ctrlKey || e.metaKey`), so the SHORTCUTS WORK on macOS — but every label
 * that advertised them said "Ctrl", which is the key a Mac user does not press.
 * The activity bar tooltips, the "…" overflow menu and the shortcuts overlay
 * all hard-coded the string. This module is the one place that decides.
 * See docs/audit/webui-full-review-2026-09-03.md B-15.
 */

/**
 * True on Apple platforms, where the primary chord modifier is ⌘ rather than
 * Ctrl. Read once at module load: the platform cannot change mid-session, and
 * a per-render probe would be a needless global access in hot paths.
 *
 * `navigator.userAgentData.platform` is the modern, non-deprecated source;
 * `navigator.platform` is the fallback for browsers that do not ship UA-CH
 * (Safari and Firefox, which is to say most of the Macs this matters for).
 * Guarded for non-browser contexts (SSR-style imports, vitest node env).
 */
export const IS_APPLE_PLATFORM: boolean = (() => {
  try {
    if (typeof navigator === 'undefined') return false;
    const uaData = (navigator as Navigator & { userAgentData?: { platform?: string } })
      .userAgentData;
    const platform = uaData?.platform ?? navigator.platform ?? '';
    return /mac|iphone|ipad|ipod/i.test(platform);
  } catch {
    return false;
  }
})();

/**
 * Label for the primary chord modifier: `⌘` on Apple platforms, `Ctrl`
 * elsewhere. Deliberately NOT translated — modifier keys are engraved on the
 * hardware and carry the same name in every locale this app ships.
 */
export const MOD_KEY_LABEL: string = IS_APPLE_PLATFORM ? '⌘' : 'Ctrl';

/** `Alt` is `⌥` on Apple keyboards. Same reasoning as {@link MOD_KEY_LABEL}. */
export const ALT_KEY_LABEL: string = IS_APPLE_PLATFORM ? '⌥' : 'Alt';

/** `Shift` renders as `⇧` alongside the other glyphs on Apple keyboards. */
export const SHIFT_KEY_LABEL: string = IS_APPLE_PLATFORM ? '⇧' : 'Shift';

/**
 * Render one key name from a shortcut table for the current platform.
 *
 * Tables stay written in the portable `['Ctrl', 'Shift', 'W']` form; this maps
 * the three modifier names at display time and passes everything else through
 * (letters, digits, `F5`, `Enter`, arrows) unchanged.
 */
export function platformKeyLabel(key: string): string {
  switch (key) {
    case 'Ctrl':
      return MOD_KEY_LABEL;
    case 'Alt':
      return ALT_KEY_LABEL;
    case 'Shift':
      return SHIFT_KEY_LABEL;
    default:
      return key;
  }
}
