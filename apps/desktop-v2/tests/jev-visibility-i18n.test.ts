// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, describe, expect, it } from 'vitest';
import { JevSettings } from '../src/JevSettings';
import { ModelVisibilitySettings } from '../src/ModelVisibilitySettings';
import { surfaceI18n } from '../src/surface-i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const jev = async () => ({
  settings: {
    enabled: true,
    status: 'ready',
    route: 'typesafe',
    keySource: 'none',
    features: { tool: true, compaction: false },
  },
});
const visibility = async (type: string) =>
  type === 'providers.saved'
    ? { providers: [{ id: 'openai' }] }
    : { provider: 'openai', models: [{ id: 'gpt-x', name: 'GPT X' }] };

async function render(element: ReturnType<typeof createElement>) {
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(async () => root.render(element));
  await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  const text = host.textContent ?? '';
  act(() => root.unmount());
  return text;
}

const both = async () =>
  (await render(createElement(JevSettings, { command: jev }))) +
  (await render(
    createElement(ModelVisibilitySettings, {
      draft: { disabledModels: ['old-model'] },
      change: () => undefined,
      command: visibility,
      defaultProvider: 'openai',
    }),
  ));

describe('Jev and model visibility settings in the display language', () => {
  afterAll(async () => {
    await surfaceI18n.changeLanguage('en');
  });

  it('keeps English and translates them in Turkish', async () => {
    await surfaceI18n.changeLanguage('en');
    const english = await both();
    for (const text of [
      'Account configured · key not set',
      'Tool-call risk',
      'Check judgments',
      '1 matching model · 0 individually disabled for this provider',
      '1 saved disabled-model rule',
      'Add favorite',
    ])
      expect(english).toContain(text);

    await surfaceI18n.changeLanguage('tr');
    const turkish = await both();
    for (const text of [
      'Hesap yapılandırılmış · anahtar ayarlanmadı',
      'Araç çağrısı riski',
      'Yargıları denetle',
      '1 eşleşen model · bu sağlayıcı için tek tek devre dışı bırakılan 0',
      '1 kayıtlı devre dışı model kuralı',
      'Sık kullanılanlara ekle',
    ])
      expect(turkish).toContain(text);
  });
});
