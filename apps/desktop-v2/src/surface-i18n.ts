import { normalizeLocale, SUPPORTED_LNGS } from '@wrongstack/project-surfaces/lib/languages';
import { createInstance, type i18n } from 'i18next';
import resourcesToBackend from 'i18next-resources-to-backend';
import { initReactI18next } from 'react-i18next';
import activity from '../../../packages/webui/src/i18n/locales/en/activity.json';
import common from '../../../packages/webui/src/i18n/locales/en/common.json';
import setup from '../../../packages/webui/src/i18n/locales/en/setup.json';
import desktop from './locales/en/desktop.json';

/** The WebUI namespaces the shared surfaces translate with; each must be listed here. */
const surfaceNamespaces = ['common', 'activity', 'setup'] as const;

/** Where the display language is remembered, so the shell starts in it before any engine runs. */
const LANGUAGE_CACHE_KEY = 'wrongstack.desktop.language';

/** The display language last seen, or null before the profile was ever read. */
export function cachedLanguage(): string | null {
  try {
    const stored = localStorage.getItem(LANGUAGE_CACHE_KEY);
    return stored ? normalizeLocale(stored) : null;
  } catch {
    return null;
  }
}

/** Keeps the profile's display language for the next start. */
export function rememberLanguage(language: string): void {
  try {
    localStorage.setItem(LANGUAGE_CACHE_KEY, language);
  } catch {
    /* The profile stays the source of truth; the next read restores it. */
  }
}

/**
 * The translation catalog of the desktop: the WebUI's own catalogs for the project surfaces
 * shared with it (read in place, not copied), and the `desktop` namespace for the desktop's
 * own shell. One instance, so the shell and the surfaces always show the same language.
 */
export const surfaceI18n: i18n = createInstance();
void surfaceI18n
  .use(initReactI18next)
  .use(
    resourcesToBackend((language: string, namespace: string) =>
      namespace === 'desktop'
        ? import(`./locales/${language}/desktop.json`)
        : import(`../../../packages/webui/src/i18n/locales/${language}/${namespace}.json`),
    ),
  )
  .init({
    lng: cachedLanguage() ?? 'en',
    fallbackLng: 'en',
    // The languages the WebUI catalogs ship; English is bundled, the others load on demand.
    supportedLngs: [...SUPPORTED_LNGS],
    ns: [...surfaceNamespaces, 'desktop'],
    defaultNS: 'common',
    partialBundledLanguages: true,
    resources: { en: { common, activity, setup, desktop } },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
    returnNull: false,
  });

/**
 * The display language the profile shares with the WebUI and CLI (`Config.uiLocale`), as one
 * the catalogs ship; English while none is chosen.
 */
export function displayLanguage(prefs: Record<string, unknown> | undefined): string {
  const stored = prefs?.['uiLocale'];
  return typeof stored === 'string' && stored.trim() ? normalizeLocale(stored) : 'en';
}
