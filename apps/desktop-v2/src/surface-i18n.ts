import { createInstance, type i18n } from 'i18next';
import resourcesToBackend from 'i18next-resources-to-backend';
import { initReactI18next } from 'react-i18next';
import activity from '../../../packages/webui/src/i18n/locales/en/activity.json';
import common from '../../../packages/webui/src/i18n/locales/en/common.json';

/** Languages the WebUI catalogs ship; English is bundled, the others load on demand. */
export const surfaceLanguages = ['en', 'tr', 'de', 'fr', 'it', 'es', 'pt-BR'] as const;

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
    supportedLngs: [...surfaceLanguages],
    ns: ['common', 'activity'],
    defaultNS: 'common',
    partialBundledLanguages: true,
    resources: { en: { common, activity } },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
    returnNull: false,
  });
