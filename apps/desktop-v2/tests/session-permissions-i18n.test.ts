// @vitest-environment jsdom

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it } from 'vitest';
import type { EngineState } from '../src/engine-state';
import de from '../src/locales/de/desktop.json';
import en from '../src/locales/en/desktop.json';
import es from '../src/locales/es/desktop.json';
import fr from '../src/locales/fr/desktop.json';
import it_ from '../src/locales/it/desktop.json';
import ptBR from '../src/locales/pt-BR/desktop.json';
import tr from '../src/locales/tr/desktop.json';
import { SessionPermissionRules } from '../src/SessionPermissionRules';
import { SessionPermissionsOption } from '../src/SessionPermissionsOption';
import { surfaceI18n } from '../src/surface-i18n';

const command = (async () => ({})) as never;
const dialog = () =>
  renderToStaticMarkup(
    createElement(SessionPermissionRules, { command, sessionId: 'sess_1', onClose: () => {} }),
  ).replaceAll('<!-- -->', '');
const entry = (state: Partial<EngineState>) =>
  renderToStaticMarkup(
    createElement(SessionPermissionsOption, { state: state as EngineState, command }),
  ).replaceAll('<!-- -->', '');

type Catalog = { sessionPermissions?: Record<string, string> };
const catalogs: Record<string, Catalog> = { de, es, fr, it: it_, 'pt-BR': ptBR, tr };
const english = (en as Catalog).sessionPermissions ?? {};
const placeholders = (text: string) => [...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();

describe('session permission rules in the display language', () => {
  afterAll(async () => {
    await surfaceI18n.changeLanguage('en');
  });

  it('has every line in every language with the same placeholders', () => {
    expect(Object.keys(english).length).toBeGreaterThan(0);
    for (const [language, catalog] of Object.entries(catalogs)) {
      const group = catalog.sessionPermissions;
      expect(group, language).toBeDefined();
      expect(Object.keys(group ?? {}).sort(), language).toEqual(Object.keys(english).sort());
      for (const [key, text] of Object.entries(group ?? {})) {
        expect(text.trim(), `${language}.${key}`).not.toBe('');
        expect(placeholders(text), `${language}.${key}`).toEqual(placeholders(english[key] ?? ''));
      }
    }
  });

  it('renders the dialog in English, then in Turkish', async () => {
    await surfaceI18n.changeLanguage('en');
    const inEnglish = dialog();
    for (const key of ['title', 'intro', 'empty', 'add', 'showRules']) {
      expect(inEnglish).toContain(english[key]);
    }
    await surfaceI18n.changeLanguage('tr');
    const turkish = dialog();
    expect(turkish).toContain('Bu konuşmanın izin kuralları');
    expect(turkish).toContain('Bu konuşma için kural yok.');
    expect(turkish).not.toContain(english['title']);
  });

  it('offers the menu entry only for a connected conversation', async () => {
    await surfaceI18n.changeLanguage('en');
    const label = english['menu'] ?? '';
    expect(entry({ connected: true, sessionId: 'sess_1' })).toContain(label);
    expect(entry({ connected: true, sessionId: 'sess_1' })).not.toContain('disabled');
    expect(entry({ connected: true, sessionId: '' })).toContain('disabled');
    expect(entry({ connected: false, sessionId: 'sess_1' })).toContain('disabled');
  });
});
