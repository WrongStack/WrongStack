import { describe, expect, it } from 'vitest';
import { displayLanguage, surfaceI18n } from '../src/surface-i18n';

describe('display language', () => {
  it('reads the shared uiLocale as a shipped language, English while none is chosen', () => {
    expect(displayLanguage(undefined)).toBe('en');
    expect(displayLanguage({})).toBe('en');
    expect(displayLanguage({ uiLocale: '  ' })).toBe('en');
    expect(displayLanguage({ uiLocale: 'tr' })).toBe('tr');
    expect(displayLanguage({ uiLocale: 'TR' })).toBe('tr');
    expect(displayLanguage({ uiLocale: 'de-AT' })).toBe('de');
    expect(displayLanguage({ uiLocale: 'pt-PT' })).toBe('pt-BR');
    expect(displayLanguage({ uiLocale: 'xx' })).toBe('en');
    expect(displayLanguage({ uiLocale: 7 })).toBe('en');
  });

  it('lets the shared surfaces switch to every language the WebUI catalogs ship', () => {
    expect(surfaceI18n.options.supportedLngs).toEqual(
      expect.arrayContaining(['en', 'tr', 'de', 'fr', 'it', 'es', 'pt-BR']),
    );
  });
});
