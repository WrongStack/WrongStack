import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useAppTranslation } from '../../src/i18n';

/**
 * Regression guard for the scanner-redaction artifact that had replaced the
 * `provider.addApiKey` label in ALL seven settings catalogs
 * (`[REDACTED:json_credential_key]` was rendered literally by the
 * "Add API key" button in ProviderSection). Pins three layers of the render
 * chain: the raw catalog values, the absence of any leftover redaction
 * marker anywhere in the catalogs, and the live i18n chain
 * (useAppTranslation → t) that ProviderSection.tsx resolves the label with.
 */

const LOCALES = ['en', 'tr', 'de', 'es', 'fr', 'it', 'pt-BR'] as const;

function catalogPath(locale: string): string {
  // jsdom sets `import.meta.url` to an HTTP origin, so file URLs cannot be
  // resolved here; vitest's root is the package directory.
  return resolve(process.cwd(), `src/i18n/locales/${locale}/settings.json`);
}

describe('provider.addApiKey label (redaction-marker regression)', () => {
  it('uses a real human label in every locale — never the scanner marker', () => {
    for (const locale of LOCALES) {
      const catalog = JSON.parse(readFileSync(catalogPath(locale), 'utf8')) as {
        provider: { addApiKey: string };
      };
      const label = catalog.provider.addApiKey;
      expect(label, `${locale} still carries the redaction marker`).not.toContain('[REDACTED');
      expect(label.length).toBeGreaterThan(0);
    }
    expect(
      (JSON.parse(readFileSync(catalogPath('en'), 'utf8')) as { provider: { addApiKey: string } })
        .provider.addApiKey,
    ).toBe('Add API key');
  });
  it('leaves no redaction marker anywhere in the settings catalogs', () => {
    for (const locale of LOCALES) {
      const raw = readFileSync(catalogPath(locale), 'utf8');
      expect(raw, `${locale} contains a leftover redaction marker`).not.toContain('[REDACTED:');
    }
  });

  it('resolves the label through the live i18n chain ProviderSection renders with', () => {
    const { result } = renderHook(() => useAppTranslation());
    expect(result.current.t('settings:provider.addApiKey')).toBe('Add API key');
  });

  it('keeps ProviderSection wired to this key', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/components/SettingsPanel/ProviderSection.tsx'),
      'utf8',
    );
    expect(source).toContain("t('settings:provider.addApiKey')");
  });
});
