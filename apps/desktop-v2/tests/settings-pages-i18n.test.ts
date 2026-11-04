// @vitest-environment jsdom

import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { emptyEngineState } from '../src/engine-state';
import { ProviderSettings } from '../src/ProviderSettings';
import { surfaceI18n } from '../src/surface-i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The engine never answers here: each page stays on its first view.
const pending = () => new Promise<never>(() => {});

/** Renders a page, then reads its text and accessible names. */
async function mount(page: ReactElement) {
  const host = document.createElement('div');
  document.body.append(host);
  let root: Root | undefined;
  await act(async () => {
    root = createRoot(host);
    root.render(page);
  });
  await act(async () => {});
  const text = host.textContent ?? '';
  const labels = [...host.querySelectorAll('[aria-label], [title]')].map(
    (node) => node.getAttribute('aria-label') ?? node.getAttribute('title'),
  );
  act(() => root?.unmount());
  host.remove();
  return { text, labels };
}

const providers = () =>
  createElement(ProviderSettings, {
    state: { ...emptyEngineState, needsSetup: false },
    send: vi.fn(pending),
    command: vi.fn(pending),
    onError: vi.fn(),
    onConfigured: vi.fn(),
  });

describe('the settings pages in the display language', () => {
  afterAll(() => surfaceI18n.changeLanguage('en'));

  it('show provider settings in English, then in Turkish', async () => {
    await surfaceI18n.changeLanguage('en');
    let page = await mount(providers());
    for (const text of [
      'YOUR MODELS. YOUR CONNECTIONS.',
      'Providers & models',
      'Default model',
      'Choose a provider',
      'Saved connections and the engine catalog appear here.',
      'Use model',
      'Add a connection',
      'Custom endpoint',
      'Key label',
      'Save API key',
    ])
      expect(page.text).toContain(text);
    expect(page.labels).toEqual(
      expect.arrayContaining([
        'Provider settings',
        'Refresh providers',
        'Default provider',
        'Credential provider',
        'Provider API key',
      ]),
    );

    await surfaceI18n.changeLanguage('tr');
    page = await mount(providers());
    for (const text of [
      'MODELLERİN. BAĞLANTILARIN.',
      'Sağlayıcılar ve modeller',
      'Varsayılan model',
      'Bir sağlayıcı seç',
      'Kayıtlı bağlantılar ve motor kataloğu burada görünür.',
      'Modeli kullan',
      'Bağlantı ekle',
      'Özel uç nokta',
      'Anahtar etiketi',
      'API anahtarını kaydet',
    ])
      expect(page.text).toContain(text);
    expect(page.labels).toEqual(
      expect.arrayContaining([
        'Sağlayıcı ayarları',
        'Sağlayıcıları yenile',
        'Varsayılan sağlayıcı',
        'Kimlik bilgisi sağlayıcısı',
        'Sağlayıcı API anahtarı',
      ]),
    );
  });
});
