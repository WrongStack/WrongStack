/**
 * Locale-switching reactivity test ("dil değiştirme ve anında işlemesi").
 *
 * Verifies the display-only i18n chain so a language change applies INSTANTLY
 * (no reload):
 *   1. `i18n.changeLanguage()` re-renders any component using `useAppTranslation`
 *      (react-i18next reactivity),
 *   2. the prefs store (`useLocalPrefs.set({ uiLocale })` — the path the
 *      SettingsPanel picker takes) drives `i18n.changeLanguage` via the
 *      `useLocalPrefs.subscribe` in i18n/index.ts,
 *   3. `<html lang>` follows the locale (a11y/SEO), and
 *   4. namespace-prefixed keys (the defaultNS='common' gotcha) swap too.
 *
 * Resource bundles for every locale are registered synchronously in `beforeAll`
 * (via `addResourceBundle`). This isolates the REACTIVITY test from Vite's
 * `resourcesToBackend` lazy-chunk loader, which has different load timing under
 * vitest/jsdom (the backend CAN load — see the `reloadResources` test below —
 * but its changeLanguage auto-load doesn't deterministically resolve in the test
 * runner). The lazy-load is a Vite/browser runtime concern verified separately
 * by the 42 locale chunks emitted into dist.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { i18n, useAppTranslation } from '../../src/i18n';
import { useLocalPrefs } from '../../src/stores/local-prefs';
import settings_en from '../../src/i18n/locales/en/settings.json';
import settings_tr from '../../src/i18n/locales/tr/settings.json';
import settings_de from '../../src/i18n/locales/de/settings.json';
import settings_fr from '../../src/i18n/locales/fr/settings.json';
import settings_it from '../../src/i18n/locales/it/settings.json';
import settings_es from '../../src/i18n/locales/es/settings.json';
import settings_ptBR from '../../src/i18n/locales/pt-BR/settings.json';
import common_en from '../../src/i18n/locales/en/common.json';
import common_tr from '../../src/i18n/locales/tr/common.json';
import common_de from '../../src/i18n/locales/de/common.json';

/** Renders `settings:title` — differs across every locale. */
function SettingsProbe() {
  const { t } = useAppTranslation();
  return <div data-testid="settings-probe">{t('settings:title')}</div>;
}

/** Renders a namespace-prefixed key (`common:action.cancel`). */
function CancelProbe() {
  const { t } = useAppTranslation();
  return <div data-testid="cancel-probe">{t('common:action.cancel')}</div>;
}

// Register every locale's bundles synchronously so the reactivity test is
// deterministic (decoupled from the Vite lazy-chunk backend timing).
beforeAll(() => {
  const settings: Record<string, Record<string, unknown>> = {
    en: settings_en,
    tr: settings_tr,
    de: settings_de,
    fr: settings_fr,
    it: settings_it,
    es: settings_es,
    'pt-BR': settings_ptBR,
  };
  const common: Record<string, Record<string, unknown>> = {
    en: common_en,
    tr: common_tr,
    de: common_de,
  };
  for (const [lng, bundle] of Object.entries(settings)) {
    i18n.addResourceBundle(lng, 'settings', bundle, true, true);
  }
  for (const [lng, bundle] of Object.entries(common)) {
    i18n.addResourceBundle(lng, 'common', bundle, true, true);
  }
});

afterAll(() => {
  useLocalPrefs.getState().set({ uiLocale: 'en' });
  void i18n.changeLanguage('en');
});

describe('locale switching applies instantly', () => {
  beforeEach(async () => {
    useLocalPrefs.getState().set({ uiLocale: 'en' });
    await i18n.changeLanguage('en');
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the EN string by default', () => {
    render(<SettingsProbe />);
    expect(screen.getByTestId('settings-probe').textContent).toBe('Settings');
  });

  it('re-renders instantly when i18n.changeLanguage swaps the locale', async () => {
    render(<SettingsProbe />);
    expect(screen.getByTestId('settings-probe').textContent).toBe('Settings');

    await i18n.changeLanguage('tr');
    await waitFor(() => expect(screen.getByTestId('settings-probe').textContent).toBe('Ayarlar'));

    await i18n.changeLanguage('de');
    await waitFor(() => expect(screen.getByTestId('settings-probe').textContent).toBe('Einstellungen'));
  });

  it('the prefs store drives i18n via subscribe (the picker path) + syncs <html lang>', async () => {
    render(<SettingsProbe />);
    expect(screen.getByTestId('settings-probe').textContent).toBe('Settings');

    // Exactly what SettingsPanel's setUiLocale does: mutate the store; the
    // useLocalPrefs.subscribe in i18n/index.ts calls i18n.changeLanguage.
    useLocalPrefs.getState().set({ uiLocale: 'fr' });

    await waitFor(() => expect(screen.getByTestId('settings-probe').textContent).toBe('Paramètres'));
    await waitFor(() => expect(document.documentElement.lang).toBe('fr'));
    expect(i18n.language).toBe('fr');
  });

  it('cycles every locale — each switch re-renders with the right label', async () => {
    render(<SettingsProbe />);
    const expected: Record<string, string> = {
      en: 'Settings',
      tr: 'Ayarlar',
      de: 'Einstellungen',
      fr: 'Paramètres',
      it: 'Impostazioni',
      es: 'Ajustes',
      'pt-BR': 'Configurações',
    };
    for (const [code, label] of Object.entries(expected)) {
      useLocalPrefs.getState().set({ uiLocale: code });
      // eslint-disable-next-line no-await-in-loop
      await waitFor(() => expect(screen.getByTestId('settings-probe').textContent).toBe(label));
      expect(document.documentElement.lang).toBe(code);
    }
  });

  it('namespace-prefixed keys swap with the locale (defaultNS gotcha guard)', async () => {
    render(<CancelProbe />);
    expect(screen.getByTestId('cancel-probe').textContent).toBe('Cancel');

    useLocalPrefs.getState().set({ uiLocale: 'tr' });
    await waitFor(() => expect(screen.getByTestId('cancel-probe').textContent).toBe('İptal'));

    useLocalPrefs.getState().set({ uiLocale: 'de' });
    await waitFor(() => expect(screen.getByTestId('cancel-probe').textContent).toBe('Abbrechen'));
  });

  it('a prefs.updated broadcast carrying uiLocale swaps the locale (live cross-instance path)', async () => {
    // When another webui instance (or the desktop) changes the language, the
    // server broadcasts prefs.updated; the client reconciles via
    // handlePrefsUpdated → useLocalPrefs → the i18n subscribe. This exercises
    // that exact path (the same-server live propagation, no restart).
    const { handlePrefsUpdated } = await import('../../src/hooks/ws-handlers/misc-handlers');
    render(<SettingsProbe />);
    expect(screen.getByTestId('settings-probe').textContent).toBe('Settings');

    handlePrefsUpdated({ type: 'prefs.updated', payload: { uiLocale: 'es' } });
    await waitFor(() => expect(screen.getByTestId('settings-probe').textContent).toBe('Ajustes'));
    expect(useLocalPrefs.getState().uiLocale).toBe('es');
  });

  it('the resourcesToBackend lazy loader CAN fetch a locale bundle (reloadResources)', async () => {
    // The Vite backend is wired; explicit reload loads + registers the bundle.
    // (changeLanguage's auto-load is non-deterministic under vitest timing, so
    // this asserts the loader itself resolves — proving the browser path.)
    await i18n.reloadResources(['es'], ['chat']);
    expect(i18n.hasResourceBundle('es', 'chat')).toBe(true);
  });
});
