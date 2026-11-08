// @vitest-environment jsdom

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it } from 'vitest';
import de from '../src/locales/de/desktop.json';
import en from '../src/locales/en/desktop.json';
import es from '../src/locales/es/desktop.json';
import fr from '../src/locales/fr/desktop.json';
import it_ from '../src/locales/it/desktop.json';
import ptBR from '../src/locales/pt-BR/desktop.json';
import tr from '../src/locales/tr/desktop.json';
import { PluginInstaller } from '../src/PluginInstaller';
import { surfaceI18n } from '../src/surface-i18n';

const render = () =>
  renderToStaticMarkup(
    createElement(PluginInstaller, { command: (async () => ({})) as never }),
  ).replaceAll('<!-- -->', '');

type Catalog = { pluginInstaller?: Record<string, string> };
const catalogs: Record<string, Catalog> = { de, es, fr, it: it_, 'pt-BR': ptBR, tr };
const english = (en as Catalog).pluginInstaller ?? {};

describe('plugin installer in the display language', () => {
  afterAll(async () => {
    await surfaceI18n.changeLanguage('en');
  });

  it('has every line in every language', () => {
    expect(Object.keys(english).length).toBeGreaterThan(0);
    for (const [language, catalog] of Object.entries(catalogs)) {
      const group = catalog.pluginInstaller;
      expect(group, language).toBeDefined();
      expect(Object.keys(group ?? {}).sort(), language).toEqual(Object.keys(english).sort());
      for (const [key, text] of Object.entries(group ?? {})) {
        expect(text.trim(), `${language}.${key}`).not.toBe('');
      }
    }
  });

  it('renders in English, then in Turkish', async () => {
    await surfaceI18n.changeLanguage('en');
    const inEnglish = render();
    for (const key of ['title', 'install', 'remove', 'showConfigured', 'showOfficial']) {
      expect(inEnglish).toContain(english[key]);
    }
    await surfaceI18n.changeLanguage('tr');
    const turkish = render();
    expect(turkish).toContain('Eklenti ekle veya kaldır');
    expect(turkish).not.toContain(english['title']);
  });
});
