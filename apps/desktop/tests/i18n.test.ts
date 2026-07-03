import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setMainLocale, tMain } from '../src/main/i18n-main.js';

const LOCALES = ['en', 'tr', 'de', 'fr', 'it', 'es', 'pt-BR'] as const;

// Representative keys the app menu + dialogs render. Asserting each locale
// returns a real value (not the raw key) for every one guards translation
// completeness across all 7 catalogs.
const REPRESENTATIVE_KEYS = [
  'windowTitle',
  'file',
  'view',
  'workspace',
  'projects',
  'openProject',
  'registerProject',
  'settings',
  'openChat',
  'newTerminal',
  'files',
  'sessions',
  'commandPalette',
  'openInBrowser',
  'reloadWebui',
  'closeSession',
  'yoloMode',
  'noOpenProjectSessions',
  'quickView',
  'session',
];

describe('main-process i18n (i18n-main)', () => {
  beforeEach(() => setMainLocale('en'));

  it('defaults to en', () => {
    expect(tMain('file')).toBe('File');
    expect(tMain('settings')).toBe('Settings');
  });

  it('switches locale instantly via setMainLocale (drives the app menu rebuild)', () => {
    setMainLocale('tr');
    expect(tMain('file')).toBe('Dosya');
    expect(tMain('openChat')).toBe('Sohbeti Aç');

    setMainLocale('de');
    expect(tMain('file')).toBe('Datei');

    setMainLocale('fr');
    expect(tMain('openProject')).toBe('Ouvrir un projet');
  });

  it('returns the raw key for unknown keys (graceful fallback)', () => {
    expect(tMain('nonexistent_key_xyz')).toBe('nonexistent_key_xyz');
  });

  it('every locale translates a known key distinctly', () => {
    const expected: Record<string, string> = {
      en: 'Settings',
      tr: 'Ayarlar',
      de: 'Einstellungen',
      fr: 'Paramètres',
      it: 'Impostazioni',
      es: 'Ajustes',
      'pt-BR': 'Configurações',
    };
    for (const lang of LOCALES) {
      setMainLocale(lang);
      expect(tMain('settings')).toBe(expected[lang]);
    }
  });

  it('every locale has a real value for every representative key (parity guard)', () => {
    for (const lang of LOCALES) {
      setMainLocale(lang);
      for (const key of REPRESENTATIVE_KEYS) {
        const value = tMain(key);
        // A real translation is never the raw camelCase key.
        expect(value, `${lang}:${key} should be translated`).not.toBe(key);
        expect(value.length, `${lang}:${key} should be non-empty`).toBeGreaterThan(0);
      }
    }
  });

  it('ignores an invalid locale (stays on the previous value)', () => {
    setMainLocale('de');
    setMainLocale('klingon' as unknown as 'de');
    expect(tMain('file')).toBe('Datei'); // unchanged — invalid locale rejected
  });
});

describe('renderer locale IPC', () => {
  // The renderer runs in a browser context; in this node test env there's no
  // `window`/`localStorage`, so mock the desktop bridge the preload exposes.
  // resetModules: the i18n module registers its onLocaleChanged listener at
  // load time against the current `window`, so each test needs a fresh load.
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it('setLocale (user change) pushes to main so it lands in the shared config', async () => {
    const setLocaleMock = vi.fn();
    (globalThis as { window?: unknown }).window = {
      wrongstackDesktop: { setLocale: setLocaleMock },
    };

    const { setLocale } = await import('../src/renderer/src/i18n.js');
    // NOTE: no boot push — the renderer ADOPTS the config locale from main via
    // onLocaleChanged, it no longer asserts its localStorage value on boot.
    expect(setLocaleMock).not.toHaveBeenCalled();

    setLocale('tr');
    expect(setLocaleMock).toHaveBeenCalledWith('tr');

    setLocale('pt-BR');
    expect(setLocaleMock).toHaveBeenCalledWith('pt-BR');
  });

  it('adopts a main-originated locale via onLocaleChanged without echoing back (no loop)', async () => {
    let listener: ((locale: string) => void) | undefined;
    const setLocaleMock = vi.fn();
    (globalThis as { window?: unknown }).window = {
      wrongstackDesktop: {
        setLocale: setLocaleMock,
        onLocaleChanged: (cb: (locale: string) => void) => {
          listener = cb;
          return () => undefined;
        },
      },
    };

    await import('../src/renderer/src/i18n.js'); // registers onLocaleChanged
    expect(listener).toBeDefined();

    // Simulate main pushing a config-backed locale change.
    listener!('de');
    // setLocale was NOT called with propagate — main-originated, so no echo.
    expect(setLocaleMock).not.toHaveBeenCalled();
  });

  it('onLocaleChange fires for both user and main-originated changes (drives re-render)', async () => {
    const { setLocale, getLocale, onLocaleChange } = await import('../src/renderer/src/i18n.js');
    const fired: string[] = [];
    onLocaleChange(() => fired.push(getLocale()));
    expect(fired).toHaveLength(0);

    setLocale('tr'); // user change
    expect(fired).toEqual(['tr']);

    setLocale('de', { propagate: false }); // main-originated
    expect(fired).toEqual(['tr', 'de']);
  });

  it('is a no-op when the desktop bridge is absent (e.g. unit tests)', async () => {
    // No window mock → pushLocaleToMain / onLocaleChanged swallow the absence.
    const { setLocale } = await import('../src/renderer/src/i18n.js');
    expect(() => setLocale('de')).not.toThrow();
  });
});
