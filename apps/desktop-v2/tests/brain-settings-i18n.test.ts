// @vitest-environment jsdom

import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { BrainTargetEditor } from '../src/BrainTargetEditor';
import { surfaceI18n } from '../src/surface-i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Renders a page after its first replies arrive, then reads its text and accessible names. */
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
  const labels = [...host.querySelectorAll('[aria-label]')].map((node) =>
    node.getAttribute('aria-label'),
  );
  act(() => root?.unmount());
  host.remove();
  return { text, labels };
}

// One pool model, one voter using a catalog lens, one empty seat default and no judge.
const targets = () =>
  createElement(BrainTargetEditor, {
    value: {
      strategy: 'fallback',
      pool: [{ provider: 'zai', model: 'glm' }],
      voters: [{ provider: '', model: '', persona: 'skeptic', weight: '', veto: 'default' }],
      seats: [{ persona: '', veto: 'default' }],
      judge: { provider: '', model: '' },
    },
    onChange: vi.fn(),
    snapshot: {
      personaCatalog: [
        { id: 'skeptic', name: 'Skeptic', description: 'Looks for flaws.', defaultVeto: true },
      ],
    },
    command: vi.fn(async (type: string) => (type === 'providers.saved' ? { providers: [] } : {})),
  });

describe('the Brain settings in the display language', () => {
  afterAll(() => surfaceI18n.changeLanguage('en'));

  it('show the models and council editor in English, then in Turkish', async () => {
    await surfaceI18n.changeLanguage('en');
    let page = await mount(targets());
    for (const text of [
      'Decision model pool',
      'Fallback in order',
      'Pool model 1',
      'Choose from saved catalogs…',
      'Add Brain pool model',
      'Council voting seats',
      'Voting seat 1',
      'Vote weight',
      'Inherit seat / lens default',
      'Looks for flaws.',
      'Seat defaults',
      'A decision lens is required.',
      'No veto default is reported for this lens; the engine resolves it.',
      'Council judge',
      'Use derived judge',
    ])
      expect(page.text).toContain(text);
    expect(page.labels).toEqual(
      expect.arrayContaining([
        'Brain models and council editor',
        'Brain pool model 1 saved model',
        'Move Brain pool model 1 up',
        'Brain voter 1 lens',
        'Remove Brain seat default 1',
        'Council judge model ID',
      ]),
    );

    await surfaceI18n.changeLanguage('tr');
    page = await mount(targets());
    for (const text of [
      'Karar modeli havuzu',
      'Sırayla yedekle',
      'Havuz modeli 1',
      'Kayıtlı kataloglardan seç…',
      'Brain havuzuna model ekle',
      'Konsey oy koltukları',
      'Oy koltuğu 1',
      'Oy ağırlığı',
      'Koltuk / mercek varsayılanını devral',
      'Koltuk varsayılanları',
      'Bir karar merceği gerekli.',
      'Bu mercek için varsayılan veto bildirilmedi; motor bunu çözer.',
      'Konsey hakemi',
      'Türetilen hakemi kullan',
    ])
      expect(page.text).toContain(text);
    expect(page.labels).toEqual(
      expect.arrayContaining([
        'Brain modelleri ve konsey düzenleyicisi',
        'Brain havuz modeli 1 kayıtlı modeli',
        'Yukarı taşı: Brain havuz modeli 1',
        'Brain oy vericisi 1 merceği',
        'Kaldır: Brain koltuk varsayılanı 1',
        'Konsey hakemi model kimliği',
      ]),
    );
  });
});
