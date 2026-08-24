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
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { i18n, installDesktopHostLocaleBridge, useAppTranslation } from '../../src/i18n';
import { handlePrefsUpdated } from '../../src/hooks/ws-handlers/misc-handlers';
import { useLocalPrefs } from '../../src/stores/local-prefs';
import settings_en from '../../src/i18n/locales/en/settings.json';
import settings_tr from '../../src/i18n/locales/tr/settings.json';
import settings_de from '../../src/i18n/locales/de/settings.json';
import settings_fr from '../../src/i18n/locales/fr/settings.json';
import settings_it from '../../src/i18n/locales/it/settings.json';
import settings_ptBR from '../../src/i18n/locales/pt-BR/settings.json';
import common_en from '../../src/i18n/locales/en/common.json';
import common_tr from '../../src/i18n/locales/tr/common.json';
import common_de from '../../src/i18n/locales/de/common.json';

// Mutable host-listener slot. Filled by the bridge the i18n module subscribes
// to at module load. Tests fire the host listener through `fireHostLocale`
// rather than touching window.wrongstackDesktopHost directly so the test
// surface stays small.
let hostListener: ((locale: string) => void) | undefined;

interface DesktopHostBridge {
  onLocaleChanged(cb: (locale: string) => void): () => void;
}

// The bridge has to be present BEFORE the i18n module's top-level listener
// runs. Vitest evaluates top-level imports once per worker — and so did the
// previous module load — so installing on the global `window` here won't help
// retroactively. Instead, the bridge is installed fresh in `beforeAll` and
// `vi.resetModules()` + dynamic import re-runs the i18n module so its listener
// captures it. Each test that exercises the bridge path must do this dance.
function installDesktopHostBridge(): void {
  const w = window as unknown as { wrongstackDesktopHost?: DesktopHostBridge };
  w.wrongstackDesktopHost = {
    onLocaleChanged: (cb: (locale: string) => void) => {
      hostListener = cb;
      return () => {
        hostListener = undefined;
      };
    },
  };
}

function uninstallDesktopHostBridge(): void {
  delete (window as { wrongstackDesktopHost?: unknown }).wrongstackDesktopHost;
  hostListener = undefined;
}

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
    // Deliberately do NOT pre-register `es/settings`: tests below verify that
    // changeLanguage('es') loads it through resourcesToBackend.
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

    await act(async () => {
      await i18n.changeLanguage('tr');
    });
    await waitFor(() => expect(screen.getByTestId('settings-probe').textContent).toBe('Ayarlar'));

    await act(async () => {
      await i18n.changeLanguage('de');
    });
    await waitFor(() =>
      expect(screen.getByTestId('settings-probe').textContent).toBe('Einstellungen'),
    );
  });

  it('the prefs store drives i18n via subscribe (the picker path) + syncs <html lang>', async () => {
    render(<SettingsProbe />);
    expect(screen.getByTestId('settings-probe').textContent).toBe('Settings');

    // Exactly what SettingsPanel's setUiLocale does: mutate the store; the
    // useLocalPrefs.subscribe in i18n/index.ts calls i18n.changeLanguage.
    act(() => {
      useLocalPrefs.getState().set({ uiLocale: 'fr' });
    });

    await waitFor(() =>
      expect(screen.getByTestId('settings-probe').textContent).toBe('Paramètres'),
    );
    await waitFor(() => expect(document.documentElement.lang).toBe('fr'));
    expect(i18n.language).toBe('fr');
  });

  it('changeLanguage lazy-loads a non-English locale bundle through the backend', async () => {
    expect(i18n.hasResourceBundle('es', 'settings')).toBe(false);

    render(<SettingsProbe />);
    await act(async () => {
      await i18n.changeLanguage('es');
    });

    await waitFor(() => expect(i18n.hasResourceBundle('es', 'settings')).toBe(true));
    await waitFor(() => expect(screen.getByTestId('settings-probe').textContent).toBe('Ajustes'));
    expect(i18n.resolvedLanguage).toBe('es');
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
      act(() => {
        useLocalPrefs.getState().set({ uiLocale: code });
      });
      // eslint-disable-next-line no-await-in-loop
      await waitFor(() => expect(screen.getByTestId('settings-probe').textContent).toBe(label));
      expect(document.documentElement.lang).toBe(code);
    }
  });

  it('namespace-prefixed keys swap with the locale (defaultNS gotcha guard)', async () => {
    render(<CancelProbe />);
    expect(screen.getByTestId('cancel-probe').textContent).toBe('Cancel');

    act(() => {
      useLocalPrefs.getState().set({ uiLocale: 'tr' });
    });
    await waitFor(() => expect(screen.getByTestId('cancel-probe').textContent).toBe('İptal'));

    act(() => {
      useLocalPrefs.getState().set({ uiLocale: 'de' });
    });
    await waitFor(() => expect(screen.getByTestId('cancel-probe').textContent).toBe('Abbrechen'));
  });

  it('a prefs.updated broadcast carrying uiLocale swaps the locale (live cross-instance path)', async () => {
    // When another webui instance (or the desktop) changes the language, the
    // server broadcasts prefs.updated; the client reconciles via
    // handlePrefsUpdated → useLocalPrefs → the i18n subscribe. This exercises
    // that exact path (the same-server live propagation, no restart).
    render(<SettingsProbe />);
    expect(screen.getByTestId('settings-probe').textContent).toBe('Settings');

    act(() => {
      handlePrefsUpdated({ type: 'prefs.updated', payload: { uiLocale: 'es' } });
    });
    await waitFor(() => expect(screen.getByTestId('settings-probe').textContent).toBe('Ajustes'));
    expect(useLocalPrefs.getState().uiLocale).toBe('es');
  });

  it('desktop-host onLocaleChanged pushes the WebUI to the new language (desktop sidebar picker)', async () => {
    // When running inside the WrongStack desktop shell, the shell's language
    // picker (and config-file watcher) push locale changes to every embedded
    // WebUI view via the wrongstackDesktopHost IPC bridge. The webui-side
    // listener mirrors the push into the prefs store + i18next so the React
    // UI re-renders in the new language without waiting for the prefs.updated
    // round-trip. The picker path (the test above) handles the same surface
    // when the user changes language in the WebUI's own SettingsPanel.
    //
    // The module-load auto-subscribe ran before this test's `beforeAll`, so
    // we install the bridge THEN call `installDesktopHostLocaleBridge()` to
    // bind the listener.
    installDesktopHostBridge();
    installDesktopHostLocaleBridge();
    try {
      render(<SettingsProbe />);
      expect(screen.getByTestId('settings-probe').textContent).toBe('Settings');
      expect(hostListener).toBeDefined();

      // The desktop shell pushes 'tr' (e.g. user picked Türkçe in the shell).
      act(() => {
        hostListener!('tr');
      });
      await waitFor(() => expect(screen.getByTestId('settings-probe').textContent).toBe('Ayarlar'));
      expect(document.documentElement.lang).toBe('tr');
      expect(useLocalPrefs.getState().uiLocale).toBe('tr');
      expect(i18n.language).toBe('tr');

      // And the reverse: a non-English → non-English switch from the shell.
      act(() => {
        hostListener!('de');
      });
      await waitFor(() =>
        expect(screen.getByTestId('settings-probe').textContent).toBe('Einstellungen'),
      );
      expect(document.documentElement.lang).toBe('de');

      // An unknown locale normalizes to the closest supported one (so the
      // shell accidentally sending 'pt-PT' → Brazilian Portuguese here).
      act(() => {
        hostListener!('pt-PT');
      });
      await waitFor(() =>
        expect(screen.getByTestId('settings-probe').textContent).toBe('Configurações'),
      );
      expect(useLocalPrefs.getState().uiLocale).toBe('pt-BR');
    } finally {
      uninstallDesktopHostBridge();
    }
  });

  it('the resourcesToBackend lazy loader CAN fetch a locale bundle (reloadResources)', async () => {
    // Separate smoke for explicit reloadResources: the test above covers the
    // normal changeLanguage auto-load path, while this verifies the backend
    // resolver itself still works when called directly.
    await i18n.reloadResources(['es'], ['chat']);
    expect(i18n.hasResourceBundle('es', 'chat')).toBe(true);
  });
});
