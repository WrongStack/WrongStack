/**
 * i18next bootstrap for the WrongStack WebUI.
 *
 * DISPLAY-ONLY: this layer only translates the WebUI chrome (buttons, labels,
 * headings, toasts, …). It never touches the agent, system prompts, skills,
 * the prompt library, slash commands, or model output.
 *
 * The active locale (`uiLocale`) lives in the prefs store for instant local
 * rendering and is also synced through the prefs WebSocket path to shared
 * `Config.uiLocale`, so desktop, CLI WebUI, and standalone WebUI agree.
 *
 * Importing this module (side-effect import in main.tsx) initializes i18next
 * and wires locale reactivity. The English catalog is bundled inline so the
 * default + fallback language renders without a flash; every other locale is
 * lazy-loaded as its own Vite chunk via `resourcesToBackend`.
 */
import { toErrorMessage } from '@wrongstack/core/utils/error';
import i18n from 'i18next';
import resourcesToBackend from 'i18next-resources-to-backend';
import { initReactI18next } from 'react-i18next';

import { useLocalPrefs } from '@/stores/local-prefs';
import { FALLBACK_LNG, normalizeLocale, SUPPORTED_LNGS } from './languages';
import chat_en from './locales/en/chat.json';
import commandPalette_en from './locales/en/commandPalette.json';
// English is the source of truth + universal fallback → bundle the SMALL
// namespaces inline so fallback strings are available on the very first paint
// with no network/chunk. The two largest namespaces (activity 148 KB,
// settings 52 KB) ship as their own Vite chunks and load right after init
// via `loadNamespaces` below — see B-13 in docs/audit/webui-full-review.
import common_en from './locales/en/common.json';
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
    // We bundle only English inline. Every other language must still be loaded
    // through the backend when changeLanguage() runs.
    partialBundledLanguages: true,
    // English inline → immediate fallback for every locale, no suspense/flash.
    // NOTE: `activity` and `settings` are NOT inlined here — they are lazy
    // chunks pulled by `loadNamespaces` below.
    resources: {
      en: {
        common: common_en,
        chat: chat_en,
        commandPalette: commandPalette_en,
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

// Pre-fetch the two biggest namespaces as their own chunks (B-13). Called
// right after init so the work starts on the same tick as `init` resolves;
// by the time a user clicks into Settings or Activity the chunks are already
// in the module graph and `useAppTranslation` resolves to the translated
// string on the first render.
const DEFERRED_NAMESPACES = ['activity', 'settings'] as const;
void i18n.loadNamespaces(DEFERRED_NAMESPACES).catch((error: unknown) => {
  // Surfacing in the console rather than throwing — a transient chunk failure
  // (offline, CDN blip) should not take down the entire UI. i18next is
  // configured with `returnNull: false`, so components will fall back to the
  // key string until the next refresh re-loads the namespace.
  console.warn(
    JSON.stringify({
      level: 'warn',
      event: 'i18n_deferred_namespace_prefetch_failed',
      namespaces: DEFERRED_NAMESPACES,
      error: toErrorMessage(error),
      timestamp: new Date().toISOString(),
    }),
  );
});

// Locale reactivity: any change to the stored uiLocale (picker, reset(), or a
// cross-tab localStorage rehydrate) drives i18next + <html lang> from one place.
useLocalPrefs.subscribe((state, prev) => {
  const next = state.uiLocale;
  if (next && next !== prev.uiLocale && next !== i18n.language) {
    void i18n.changeLanguage(next).then(() => syncHtmlLang(next));
  }
});

// Desktop-host bridge: when the WrongStack desktop shell pushes a locale
// change over the wrongstackDesktopHost.onLocaleChanged IPC (because the user
// picked a different language in the shell sidebar, or another surface wrote
// Config.uiLocale), mirror it through the prefs store so the same subscriber
// path that handles picker changes drives i18next + <html lang>. No-op in
// browser WebUI (the bridge is absent).
//
// Extracted into a function so tests can install the bridge THEN call
// `subscribeDesktopLocaleBridge()` — the module-load side-effect form would
// race against the test's bridge installation (top-level imports are
// evaluated once per worker, before the test's `beforeAll` runs).
function subscribeDesktopLocaleBridge(): void {
  const host = (
    window as unknown as {
      wrongstackDesktopHost?: {
        onLocaleChanged?: (cb: (locale: string) => void) => () => void;
      };
    }
  ).wrongstackDesktopHost;
  host?.onLocaleChanged?.((locale: string) => {
    if (!locale) return;
    // Normalize first so a stray casing / region variant doesn't end up as
    // a separate locale in the store (the picker only ships the canonical
    // 7 codes; anything else falls back to the closest supported one).
    const code = normalizeLocale(locale);
    if (code === i18n.language) return;
    const store = useLocalPrefs.getState();
    if (store.uiLocale !== code) store.set({ uiLocale: code });
    // Drive i18n directly too: the subscribe above short-circuits when
    // `i18n.language` already matches, which is fine when the picker writes
    // first, but here we want the swap to happen whether or not the store
    // mutation was the cause of the change.
    void i18n.changeLanguage(code).then(() => syncHtmlLang(code));
  });
}
try {
  subscribeDesktopLocaleBridge();
} catch {
  /* bridge not available (browser WebUI) */
}

export { useTranslation as useAppTranslation } from 'react-i18next';
/**
 * Wire the desktop-host locale bridge if `window.wrongstackDesktopHost` is
 * present. Exposed for tests that install the bridge after module load; the
 * production app relies on the auto-call below (module-load side effect).
 */
export const installDesktopHostLocaleBridge = subscribeDesktopLocaleBridge;
export type { AppLocaleCode } from './languages';
export {
  detectLocale,
  FALLBACK_LNG,
  LANGUAGES,
  normalizeLocale,
  SUPPORTED_LNGS,
} from './languages';
// Re-export straight from the module (not the local default-import binding)
// so the dts bundler can drop the chain without leaving a dangling import.
export { default as i18n } from 'i18next';
