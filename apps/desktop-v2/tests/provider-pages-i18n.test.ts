import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it } from 'vitest';
import { emptyEngineState } from '../src/engine-state';
import { ProviderDiagnostics } from '../src/ProviderDiagnostics';
import { ProviderHealth, QuotaReading } from '../src/ProviderHealth';
import { surfaceI18n } from '../src/surface-i18n';

const command = () => new Promise<Record<string, unknown>>(() => undefined);
const send = async () => undefined;
const snapshot = {
  providerId: 'openai',
  meterId: 'weekly',
  windows: [{ id: 'week', label: 'Week', usedPercent: 40 }],
  credits: { unlimited: true },
};

const html = () =>
  renderToStaticMarkup(
    createElement('div', null, [
      createElement(QuotaReading, { key: 'q', snapshot }),
      createElement(ProviderHealth, { key: 'h', state: emptyEngineState, command }),
      createElement(ProviderDiagnostics, {
        key: 'd',
        state: emptyEngineState,
        send: send as never,
      }),
    ]),
  ).replaceAll('<!-- -->', '');

describe('provider health, quota and model tests in the display language', () => {
  afterAll(async () => {
    await surfaceI18n.changeLanguage('en');
  });

  it('keeps English and translates them in Turkish', async () => {
    await surfaceI18n.changeLanguage('en');
    const english = html();
    for (const text of [
      'aria-label="Quota openai weekly"',
      '40% used',
      'Reset: Not reported',
      'Unlimited',
      'Provider diagnostics',
      'Model access tests',
      'Choose a saved provider',
    ])
      expect(english).toContain(text);

    await surfaceI18n.changeLanguage('tr');
    const turkish = html();
    for (const text of [
      'aria-label="Kota openai weekly"',
      '40% kullanıldı',
      'Sıfırlanma: Bildirilmedi',
      'Sınırsız',
      'Sağlayıcı tanılama',
      'Model erişim testleri',
      'Kayıtlı bir sağlayıcı seç',
    ])
      expect(turkish).toContain(text);
  });
});
