// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, describe, expect, it } from 'vitest';
import { dateTimeText } from '../src/engine-values';
import { ProjectTechStack } from '../src/ProjectTechStack';
import { surfaceI18n } from '../src/surface-i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const snapshot = {
  id: 'snap-1',
  createdAt: '2026-11-04',
  coverage: 'partial',
  adapterVersion: '1',
  workspaces: [{ id: 'w1', relativeRoot: '', ecosystem: 'npm' }],
  dependencies: [
    {
      id: 'd1',
      name: 'left-pad',
      ecosystem: 'npm',
      direct: true,
      scope: 'runtime',
      status: 'update_available_safe',
      locked: '1.0.0',
    },
  ],
  findings: [],
};
const http = (async (path: string) =>
  path.endsWith('/snapshot') ? { snapshot } : { available: false }) as never;

async function render() {
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(async () =>
    root.render(
      createElement(ProjectTechStack, {
        http,
        projectId: 'p1',
        events: {},
        onOpenFile: () => undefined,
      }),
    ),
  );
  await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  const text = host.textContent ?? '';
  act(() => root.unmount());
  return text;
}

describe('the TechStack page in the display language', () => {
  afterAll(async () => {
    await surfaceI18n.changeLanguage('en');
  });

  it('keeps English and translates the page and the engine values in Turkish', async () => {
    await surfaceI18n.changeLanguage('en');
    const english = await render();
    for (const text of [
      'Refresh TechStack',
      // The snapshot time reads in the display language, not as an ISO string.
      `Observed ${dateTimeText('2026-11-04', 'en')} · partial coverage · adapter 1`,
      'npm · direct · runtime',
      'update available safe',
      '1 of 1 observations',
    ])
      expect(english).toContain(text);

    await surfaceI18n.changeLanguage('tr');
    const turkish = await render();
    for (const text of [
      'TechStack’i yenile',
      `Gözlendi ${dateTimeText('2026-11-04', 'tr')} · kısmi kapsam · bağdaştırıcı 1`,
      'npm · doğrudan · çalışma zamanı',
      'güvenli güncelleme var',
      '1 gözlemden 1',
    ])
      expect(turkish).toContain(text);
  });
});
