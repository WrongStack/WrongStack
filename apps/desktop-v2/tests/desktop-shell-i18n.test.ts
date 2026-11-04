// @vitest-environment jsdom
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SUPPORTED_LNGS } from '@wrongstack/project-surfaces/lib/languages';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const profile = vi.hoisted(() => ({ prefs: undefined as Record<string, unknown> | undefined }));
vi.mock('../src/useEngine', () => ({
  useProfileEngine: () => ({
    state: { connected: true, results: profile.prefs ? { 'prefs.updated': profile.prefs } : {} },
    command: vi.fn(async () => ({})),
  }),
}));

const locales = resolve(import.meta.dirname, '../src/locales');
const catalog = (language: string) =>
  JSON.parse(readFileSync(join(locales, language, 'desktop.json'), 'utf8')) as Record<
    string,
    unknown
  >;
function flat(value: unknown, prefix = ''): Record<string, string> {
  if (typeof value === 'string') return { [prefix]: value };
  return Object.entries(value as Record<string, unknown>).reduce<Record<string, string>>(
    (out, [key, child]) => Object.assign(out, flat(child, prefix ? `${prefix}.${key}` : key)),
    {},
  );
}
// Word order differs between languages, so the placeholders are compared as a sorted list.
const placeholders = (text: string) =>
  [...text.matchAll(/\{\{\w+\}\}|<\/?\w+>/g)].map(String).sort();

describe('the desktop shell catalogs', () => {
  it('ship every display language with the same keys and placeholders as English', () => {
    const english = flat(catalog('en'));
    expect(readdirSync(locales).sort()).toEqual([...SUPPORTED_LNGS].sort());
    for (const language of SUPPORTED_LNGS) {
      const strings = flat(catalog(language));
      expect(Object.keys(strings).sort(), language).toEqual(Object.keys(english).sort());
      for (const [key, text] of Object.entries(strings)) {
        expect(text.trim(), `${language} ${key}`).not.toBe('');
        expect(placeholders(text), `${language} ${key}`).toEqual(placeholders(english[key]!));
      }
    }
  });
});

describe('the shell’s use of the catalog', () => {
  it('names only keys the English catalog has', () => {
    const english = flat(catalog('en'));
    const groups = [...new Set(Object.keys(english).map((key) => key.split('.')[0]!))];
    // Engine message types (`send('composer.warm')`) share the dotted shape; they are not keys.
    const keyLike = new RegExp(
      `(?<!(?:send|command|request)\\(\\s*)['"](${groups.join('|')})\\.([\\w.-]+)['"]`,
      'g',
    );
    const prefixLike = new RegExp(`\`((?:${groups.join('|')})\\.(?:[\\w-]+\\.)*)\\$\\{`, 'g');
    const source = resolve(import.meta.dirname, '../src');
    let checked = 0;
    for (const name of readdirSync(source).filter((file) => /\.tsx?$/.test(file))) {
      const text = readFileSync(join(source, name), 'utf8');
      if (!text.includes('useDesktopText') && !text.includes('ns="desktop"')) continue;
      for (const match of text.matchAll(keyLike)) {
        const key = `${match[1]}.${match[2]}`;
        expect(Object.hasOwn(english, key), `${name}: ${key}`).toBe(true);
        checked += 1;
      }
      for (const match of text.matchAll(prefixLike)) {
        const prefix = match[1]!;
        expect(
          Object.keys(english).some((key) => key.startsWith(prefix)),
          `${name}: ${prefix}…`,
        ).toBe(true);
      }
    }
    expect(checked).toBeGreaterThan(100);
  });
});

describe('the shell in the display language', () => {
  afterEach(async () => {
    localStorage.clear();
    profile.prefs = undefined;
    vi.resetModules();
  });

  it('follows a language change and shows the shell in it', async () => {
    const { surfaceI18n } = await import('../src/surface-i18n');
    const { SettingsSectionSelect } = await import('../src/SettingsSectionSelect');
    const host = document.createElement('div');
    const sections = [{ id: 'setup', title: 'Quick setup', group: 'Models' }];
    await act(async () =>
      createRoot(host).render(
        createElement(SettingsSectionSelect, { sections, section: 'x', onSelect: vi.fn() }),
      ),
    );
    expect(host.querySelector('select')?.getAttribute('aria-label')).toBe('Settings section');
    await act(async () => {
      await surfaceI18n.changeLanguage('tr');
    });
    expect(host.querySelector('select')?.getAttribute('aria-label')).toBe('Ayar bölümü');
    expect(host.textContent).toContain('Bir bölüm seç');
  });

  it('shows a setting’s label, description, options and unit in the display language', async () => {
    const { surfaceI18n } = await import('../src/surface-i18n');
    const { SettingRow } = await import('../src/SettingRow');
    const { settingsSections } = await import('../src/settings-fields');
    const field = (key: string) => {
      const found = settingsSections
        .flatMap((section) => section.fields)
        .find((f) => f.key === key);
      if (!found) throw new Error(`no field ${key}`);
      return found;
    };
    const host = document.createElement('div');
    const root = createRoot(host);
    const render = () =>
      act(async () =>
        root.render(
          createElement('div', null, [
            createElement(SettingRow, {
              key: 'a',
              field: field('autonomy'),
              value: 'auto',
              onChange: vi.fn(),
            }),
            createElement(SettingRow, {
              key: 'b',
              field: field('autonomyDelayMs'),
              value: undefined,
              onChange: vi.fn(),
            }),
          ]),
        ),
      );
    await render();
    expect(host.textContent).toContain('Continuation mode');
    expect(host.textContent).toContain('Not reported by this engine');
    await act(async () => {
      await surfaceI18n.changeLanguage('tr');
    });
    await render();
    expect(host.textContent).toContain('Devam kipi');
    expect(host.textContent).toContain('Otomatik');
    expect(host.textContent).toContain('Bu motor tarafından bildirilmedi');
    expect(host.textContent).not.toContain('Continuation mode');
  });

  it('reads the profile language once, applies it and remembers it', async () => {
    profile.prefs = { uiLocale: 'de' };
    const { surfaceI18n, cachedLanguage } = await import('../src/surface-i18n');
    const { SurfaceLanguageSync } = await import('../src/SurfaceLanguageSync');
    expect(cachedLanguage()).toBeNull();
    const onKnown = vi.fn();
    await act(async () =>
      createRoot(document.createElement('div')).render(
        createElement(SurfaceLanguageSync, { onKnown }),
      ),
    );
    expect(onKnown).toHaveBeenCalled();
    expect(cachedLanguage()).toBe('de');
    // The language switches once its catalogs have loaded.
    await vi.waitFor(() => expect(surfaceI18n.language).toBe('de'));
  });

  it('opens in the remembered language before any engine answers', async () => {
    localStorage.setItem('wrongstack.desktop.language', 'fr');
    const { surfaceI18n } = await import('../src/surface-i18n');
    expect(surfaceI18n.language).toBe('fr');
    await act(async () => {
      await surfaceI18n.loadNamespaces('desktop');
    });
    expect(surfaceI18n.t('desktop:rail.projects')).toBe('Projets');
  });

  it('keeps the remembered language while the profile has not answered yet', async () => {
    localStorage.setItem('wrongstack.desktop.language', 'it');
    const { surfaceI18n } = await import('../src/surface-i18n');
    const { SurfaceLanguageSync } = await import('../src/SurfaceLanguageSync');
    await act(async () =>
      createRoot(document.createElement('div')).render(createElement(SurfaceLanguageSync)),
    );
    expect(surfaceI18n.language).toBe('it');
  });
});
