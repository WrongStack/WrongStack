import type { Page } from '@playwright/test';

/**
 * Seed the persisted local-prefs store with `keyboardShortcuts: true`
 * before the app loads.
 *
 * The master toggle defaults to false (browser F-key conflicts: F1 help,
 * F5 reload, F11 fullscreen, F12 devtools), so a fresh browser profile —
 * exactly what headless CI gets — never registers the global F-key
 * handler (`useGlobalKeyboardShortcuts` returns early while the pref is
 * off) and every F-key spec times out. Specs that exercise F-key
 * behavior call this in their beforeEach so they run as the opted-in
 * user the shortcuts exist for.
 */
export async function enableKeyboardShortcuts(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const KEY = 'wrongstack-local-prefs';
    const VERSION = 17;
    let doc: { state: Record<string, unknown>; version: number };
    try {
      doc = JSON.parse(localStorage.getItem(KEY) ?? '{}') as typeof doc;
    } catch {
      doc = { state: {}, version: VERSION };
    }
    doc.state = { ...(doc.state ?? {}), keyboardShortcuts: true };
    doc.version = VERSION;
    localStorage.setItem(KEY, JSON.stringify(doc));
  });
}
