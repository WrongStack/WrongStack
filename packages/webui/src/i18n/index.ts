/**
 * i18next bootstrap for the WrongStack WebUI.
 *
 * DISPLAY-ONLY: this layer only translates the WebUI chrome (buttons, labels,
 * headings, toasts, …). It never touches the agent, system prompts, skills,
 * the prompt library, slash commands, or model output.
 *
 * The active locale (`uiLocale`) lives in localStorage via the prefs store and
 * is NOT synced to the server / config.json — it follows the same local-only
 * precedent as the theme (see components/ThemeProvider.tsx).
 *
 * Importing this module (side-effect import in main.tsx) initializes i18next
 * and wires locale reactivity. The English catalog is bundled inline so the
 * default + fallback language renders without a flash; every other locale is
 * lazy-loaded as its own Vite chunk via `resourcesToBackend`.
 */
import i18n from 'i18next';
import resourcesToBackend from 'i18next-resources-to-backend';
import { initReactI18next } from 'react-i18next';

import { useLocalPrefs } from '@/stores/local-prefs';
import { FALLBACK_LNG, normalizeLocale, SUPPORTED_LNGS } from './languages';
import activity_en from './locales/en/activity.json';
import chat_en from './locales/en/chat.json';
import commandPalette_en from './locales/en/commandPalette.json';
// English is the source of truth + universal fallback → bundle it inline so
// fallback strings are available on the very first paint with no network/chunk.
import common_en from './locales/en/common.json';
import settings_en from './locales/en/settings.json';
import setup_en from './locales/en/setup.json';
import toasts_en from './locales/en/toasts.json';

const NAMESPACES = [
  'common',
  'activity',
  'chat',
  'commandPalette',
  'settings',
  'setup',
  'toasts',
] as const;

function readInitialLocale(): string {
  // The persist middleware hydrates synchronously from localStorage at store
  // creation, so this is available before React mounts.
  try {
    return normalizeLocale(useLocalPrefs.getState().uiLocale);
  } catch {
    return FALLBACK_LNG;
  }
}

void i18n
  .use(initReactI18next)
  .use(
    resourcesToBackend((lng: string, ns: string) => {
      // The dynamic import template literal is required so Vite emits one
      // chunk per (lng, ns) pair. Locales live under src/, so they are NOT
      // folded into the vendor chunk (manualChunks only buckets node_modules).
      return import(`./locales/${lng}/${ns}.json`);
    }),
  )
  .init({
    lng: readInitialLocale(),
    fallbackLng: FALLBACK_LNG,
    supportedLngs: [...SUPPORTED_LNGS],
    ns: [...NAMESPACES],
    defaultNS: 'common',
    // English inline → immediate fallback for every locale, no suspense/flash.
    resources: {
      en: {
        common: common_en,
        activity: activity_en,
        chat: chat_en,
        commandPalette: commandPalette_en,
        settings: settings_en,
        setup: setup_en,
        toasts: toasts_en,
      },
    },
    interpolation: { escapeValue: false }, // React escapes by itself.
    // No <Suspense> boundary above <App/>; render fallback keys until a locale
    // chunk resolves, then re-render (never throws/suspends).
    react: { useSuspense: false },
    returnNull: false,
  });

// Keep <html lang="…"> in sync for a11y / SEO.
function syncHtmlLang(lng: string): void {
  if (typeof document !== 'undefined') {
    document.documentElement.lang = lng;
  }
}
syncHtmlLang(i18n.language || FALLBACK_LNG);

// Locale reactivity: any change to the stored uiLocale (picker, reset(), or a
// cross-tab localStorage rehydrate) drives i18next + <html lang> from one place.
useLocalPrefs.subscribe((state, prev) => {
  const next = state.uiLocale;
  if (next && next !== prev.uiLocale && next !== i18n.language) {
    void i18n.changeLanguage(next).then(() => syncHtmlLang(next));
  }
});

export { useTranslation as useAppTranslation } from 'react-i18next';
export type { AppLocaleCode } from './languages';
export {
  detectLocale,
  FALLBACK_LNG,
  LANGUAGES,
  normalizeLocale,
  SUPPORTED_LNGS,
} from './languages';
export { i18n };
