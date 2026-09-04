/**
 * B-13 (docs/audit/webui-full-review-2026-09-03.md) — `activity` and `settings`
 * used to be inlined into the English bundle (148 KB + 52 KB on the entry
 * chunk), dominating first paint even though neither namespace renders on the
 * default landing surface (chat). They are now fetched through the
 * resourcesToBackend on the same tick as `init`, so first paint of those two
 * views lands translated, just via a separate Vite chunk.
 *
 * Two contracts are pinned here:
 *
 *  1. The `i18n/index.ts` source does not import the locale JSON for
 *     `activity` or `settings`. That import is what causes Vite to fold the
 *     JSON into the entry chunk; asserting it is absent is the same shape the
 *     bundler observes, so a regression can never look like "is still
 *     inlined because some other test added the bundle at runtime".
 *  2. The deferred pre-fetch resolves activity/settings for English through
 *     the backend, so the loading path is identical to non-English locales
 *     and there's no key-fallback surprise.
 *
 * The companion `locale-switch.test.tsx` continues to pin reactivity across
 * locale changes; this file pins the bundle-shape change that cost savings
 * depends on.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { i18n } from '../../src/i18n';

const I18N_INDEX_SOURCE = readFileSync(
  resolve(__dirname, '../../src/i18n/index.ts'),
  'utf8',
);

describe('B-13 — deferred i18n namespaces are NOT inlined', () => {
  it('does not import the activity locale JSON inline', () => {
    expect(I18N_INDEX_SOURCE).not.toMatch(/from\s+['"]\.\/locales\/en\/activity\.json['"]/);
  });

  it('does not import the settings locale JSON inline', () => {
    expect(I18N_INDEX_SOURCE).not.toMatch(/from\s+['"]\.\/locales\/en\/settings\.json['"]/);
  });

  it('still inlines the small chrome namespaces that paint the default landing surface', () => {
    // A regression here would re-add ~200 KB of JSON to the entry chunk.
    expect(I18N_INDEX_SOURCE).toMatch(/from\s+['"]\.\/locales\/en\/common\.json['"]/);
    expect(I18N_INDEX_SOURCE).toMatch(/from\s+['"]\.\/locales\/en\/chat\.json['"]/);
    expect(I18N_INDEX_SOURCE).toMatch(
      /from\s+['"]\.\/locales\/en\/commandPalette\.json['"]/,
    );
    expect(I18N_INDEX_SOURCE).toMatch(/from\s+['"]\.\/locales\/en\/setup\.json['"]/);
    expect(I18N_INDEX_SOURCE).toMatch(/from\s+['"]\.\/locales\/en\/toasts\.json['"]/);
  });

  it('drives a pre-fetch for both deferred namespaces', () => {
    // Belt-and-braces: the source must actually drive the pre-fetch, not just
    // remove the inline import. Without this, removing the inline resource
    // would leave activity/settings untranslated until first use — visible
    // flash on entering Settings or Activity from the tab strip.
    //
    // Either inline `loadNamespaces('activity', 'settings')` or a constant
    // (`loadNamespaces(DEFERRED_NAMESPACES)` where the constant lists both)
    // is acceptable. We can only check the call form + the constant, not the
    // constant's value, so the constant must additionally bind both names.
    const callsLoadNamespaces = /loadNamespaces\s*\(/.test(I18N_INDEX_SOURCE);
    expect(callsLoadNamespaces).toBe(true);

    const constantDeclaration = I18N_INDEX_SOURCE.match(
      /(?:const|let|var)\s+DEFERRED_NAMESPACES\s*=\s*\[([^\]]+)\]/,
    );
    if (constantDeclaration) {
      // Path: deferred list is a constant — pin it contains both names.
      expect(constantDeclaration[1]).toMatch(/['"]activity['"]/);
      expect(constantDeclaration[1]).toMatch(/['"]settings['"]/);
      return;
    }
    // Path: deferred list is inline at the call site. Both names must appear
    // inside the call's parentheses.
    const inline = I18N_INDEX_SOURCE.match(/loadNamespaces\s*\(([^)]+)\)/);
    expect(inline, 'loadNamespaces call not found inline').toBeTruthy();
    expect(inline![1]).toMatch(/['"]activity['"]/);
    expect(inline![1]).toMatch(/['"]settings['"]/);
  });
});

describe('B-13 — deferred namespaces are loaded via the backend', () => {
  /**
   * The singleton `i18n` is shared with locale-switch.test.tsx (which
   * pre-registers `en` settings/chat in its `beforeAll` for reactivity
   * determinism). The "before hasResourceBundle is false" assertion is
   * therefore unreliable across test-file ordering; pin the contract that
   * actually matters: the backend resolver returns a usable bundle with the
   * expected keys.
   */
  it('resolves activity through resourcesToBackend for English', async () => {
    await i18n.reloadResources(['en'], ['activity']);
    expect(i18n.hasResourceBundle('en', 'activity')).toBe(true);
    // Spot-check a key that's used in the Activity surface so a future
    // namespace re-shape is caught here rather than in production.
    expect(i18n.t('activity:nav.coordinator', { lng: 'en' })).toBeTruthy();
  });

  it('resolves settings through resourcesToBackend for English', async () => {
    await i18n.reloadResources(['en'], ['settings']);
    expect(i18n.hasResourceBundle('en', 'settings')).toBe(true);
    expect(i18n.t('settings:title', { lng: 'en' })).toBe('Settings');
  });
});
