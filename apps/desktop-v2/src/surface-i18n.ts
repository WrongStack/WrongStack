import { normalizeLocale, SUPPORTED_LNGS } from '@wrongstack/project-surfaces/lib/languages';
import { createInstance, type i18n } from 'i18next';
import resourcesToBackend from 'i18next-resources-to-backend';
import { initReactI18next } from 'react-i18next';
import activity from '../../../packages/webui/src/i18n/locales/en/activity.json';
import common from '../../../packages/webui/src/i18n/locales/en/common.json';
import setup from '../../../packages/webui/src/i18n/locales/en/setup.json';

/** The WebUI namespaces the shared surfaces translate with; each must be listed here. */
const surfaceNamespaces = ['common', 'activity', 'setup'] as const;

/**
 * The translation catalog of the project surfaces shared with the WebUI. They render the
 * WebUI's own strings, so the desktop reads the same catalogs instead of copying them.
 */
export const surfaceI18n: i18n = createInstance();
void surfaceI18n
  .use(initReactI18next)
  .use(
    resourcesToBackend(
      (language: string, namespace: string) =>
        import(`../../../packages/webui/src/i18n/locales/${language}/${namespace}.json`),
    ),
  )
  .init({
    lng: 'en',
    fallbackLng: 'en',
    // The languages the WebUI catalogs ship; English is bundled, the others load on demand.
    supportedLngs: [...SUPPORTED_LNGS],
    ns: [...surfaceNamespaces],
    defaultNS: 'common',
    partialBundledLanguages: true,
    resources: { en: { common, activity, setup } },
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
