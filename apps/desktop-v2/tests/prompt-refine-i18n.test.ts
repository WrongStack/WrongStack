// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it } from 'vitest';
import { PromptRefinement } from '../src/PromptRefinement';
import { SystemPromptPresets } from '../src/SystemPromptPresets';
import { surfaceI18n } from '../src/surface-i18n';
import { SavedRefinementNotice } from '../src/useRefinementDraft';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const dialog = () =>
  renderToStaticMarkup(
    createElement(PromptRefinement, {
      original: 'fix it',
      mode: 'queue',
      command: (async () => ({})) as never,
      state: { results: {}, provider: 'p', model: 'm', hydrating: false } as never,
      onClose: () => undefined,
      onApply: () => undefined,
      onSend: async () => undefined,
      restored: {
        result: { refined: 'Fix the bug', refinedWith: { provider: 'acme', model: 'small' } },
        variant: 'refined',
        edited: null,
      },
    }),
  ).replaceAll('<!-- -->', '');

const notice = () =>
  renderToStaticMarkup(
    createElement(SavedRefinementNotice, {
      draft: {
        state: null,
        saved: { pending: true, savedAt: 0 },
        clear: () => undefined,
        resolve: () => undefined,
      } as never,
      onOpen: () => undefined,
    }),
  ).replaceAll('<!-- -->', '');

const command = (async () => ({
  presets: [
    { id: 'tight', name: 'Tight', baseVariant: 'default', revision: 2, sourceChanged: true },
  ],
  active: { default: 'tight' },
  projectActive: {},
})) as never;

async function presets() {
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(async () => root.render(createElement(SystemPromptPresets, { command })));
  await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  const text = host.textContent ?? '';
  act(() => root.unmount());
  return text;
}

describe('Prompt refinement and instruction presets in the display language', () => {
  afterAll(async () => {
    await surfaceI18n.changeLanguage('en');
  });

  it('keeps English and translates them in Turkish', async () => {
    await surfaceI18n.changeLanguage('en');
    const english = dialog();
    for (const text of [
      'Refine your prompt',
      'Delivery mode: <strong>Queue</strong>.',
      'Edit this version',
      'Refined with acme / small',
      'Approve &amp; send',
    ])
      expect(english).toContain(text);
    expect(notice()).toContain('was interrupted before the refiner answered.');
    const englishPresets = await presets();
    for (const text of [
      'In use here: Tight (profile)',
      'Standard',
      ' · the built-in text changed since this was based on it',
      'Create from built-in',
    ])
      expect(englishPresets).toContain(text);

    await surfaceI18n.changeLanguage('tr');
    const turkish = dialog();
    for (const text of [
      'Promptunu iyileştir',
      'Teslim modu: <strong>Kuyruk</strong>.',
      'Bu sürümü düzenle',
      'acme / small ile iyileştirildi',
      'Onayla ve gönder',
    ])
      expect(turkish).toContain(text);
    expect(notice()).toContain('iyileştirici yanıt vermeden kesildi.');
    const turkishPresets = await presets();
    for (const text of ['Burada kullanılan: Tight (profil)', 'Standart', 'Yerleşikten oluştur'])
      expect(turkishPresets).toContain(text);
  });
});
