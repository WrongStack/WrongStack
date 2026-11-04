// @vitest-environment jsdom

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it } from 'vitest';
import { AtlasNodeEvidence } from '../src/AtlasDetails';
import { AtlasImpactView, AtlasMatrixView, AtlasSubsystemView } from '../src/AtlasViews';
import { DESKTOP_ATLAS } from '../src/desktop-atlas-host';
import type { VisualGraph } from '../src/graph-model';
import { surfaceI18n } from '../src/surface-i18n';

const graph: VisualGraph = {
  nodes: [
    { id: 'a', label: 'api.ts', detail: 'src/api.ts', group: 'core', weight: 1, data: {} },
    { id: 'b', label: 'db.ts', detail: 'src/db.ts', group: 'core', weight: 1, data: {} },
  ],
  edges: [{ source: 'a', target: 'b', label: 'imports', weight: 2 }],
};
const props = { graph, selected: 'b', onSelect: () => undefined, onOpen: () => undefined };

const render = () =>
  renderToStaticMarkup(
    createElement('div', null, [
      createElement(AtlasSubsystemView, { key: 's', ...props }),
      createElement(AtlasMatrixView, { key: 'm', ...props }),
      createElement(AtlasImpactView, { key: 'i', ...props }),
      createElement(AtlasNodeEvidence, {
        key: 'e',
        node: { ...graph.nodes[0]!, data: { kind: 'file', line: 4, rank: 0.5 } },
        command: (async () => ({})) as never,
      }),
    ]),
  ).replaceAll('<!-- -->', '');

describe('Desktop Code Atlas additions in the display language', () => {
  afterAll(async () => {
    await surfaceI18n.changeLanguage('en');
  });

  it('keeps English and translates them in Turkish', async () => {
    await surfaceI18n.changeLanguage('en');
    const english = render();
    for (const text of [
      'Subsystem boundaries',
      'Inferred communities',
      'Boundary map',
      'Sources 1–2',
      'Targets 1–2 / 2',
      'Dependents · what uses this',
      '2 hops',
      'Line 4',
      'Dependency centrality',
      'Drag to explore · select a node to inspect · showing',
    ])
      expect(english).toContain(text);
    expect(DESKTOP_ATLAS.views?.map((view) => view.label)).toEqual([
      'Subsystems',
      'Dependency matrix',
      'Change impact',
    ]);

    await surfaceI18n.changeLanguage('tr');
    const turkish = render();
    for (const text of [
      'Alt sistem sınırları',
      'Çıkarılan topluluklar',
      'Sınır haritası',
      'Kaynaklar 1–2',
      'Hedefler 1–2 / 2',
      'Bağımlılar · bunu ne kullanıyor',
      '2 adım',
      'Satır 4',
      'Bağımlılık merkeziliği',
      'Keşfetmek için sürükle · incelemek için bir düğüm seç',
    ])
      expect(turkish).toContain(text);
    expect(DESKTOP_ATLAS.views?.map((view) => view.label)).toEqual([
      'Alt sistemler',
      'Bağımlılık matrisi',
      'Değişiklik etkisi',
    ]);
  });
});
