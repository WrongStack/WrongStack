// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it } from 'vitest';
import { surfaceI18n } from '../src/surface-i18n';
import { TechDependencyDetail } from '../src/TechStackEvidence';
import { TechStackRemediation } from '../src/TechStackRemediation';
import { TechStackTrends } from '../src/TechStackTrends';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const detail = () =>
  renderToStaticMarkup(
    createElement(TechDependencyDetail, {
      dependency: {
        id: 'd1',
        name: 'left-pad',
        ecosystem: 'npm',
        direct: false,
        scope: 'development',
        status: 'vulnerable',
        locked: '1.0.0',
        deprecated: false,
      },
      findings: [
        {
          id: 'f1',
          type: 'vulnerability',
          severity: 'high',
          action: 'upgrade_minor',
          confidence: 0.5,
          evidence: [{ kind: 'osv', source: 'GHSA-1' }],
        },
      ],
      canResearch: false,
      researching: false,
      researchNote: '',
      onResearch: () => undefined,
      onOpenFile: () => undefined,
    }),
  ).replaceAll('<!-- -->', '');

const http = (async (path: string) =>
  path.endsWith('/trends')
    ? { trend: { snapshots: 2, points: [], dependencies: [] } }
    : {
        plan: {
          generatedAt: 'now',
          items: [
            {
              dependencyName: 'left-pad',
              workspaceId: 'w1',
              ecosystem: 'npm',
              severity: 'high',
              action: 'upgrade_minor',
            },
          ],
        },
      }) as never;

async function panels() {
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(async () =>
    root.render(
      createElement('div', null, [
        createElement(TechStackTrends, { key: 't', http, snapshotId: 's1' }),
        createElement(TechStackRemediation, {
          key: 'r',
          http,
          snapshotId: 's1',
          onChanged: () => undefined,
        }),
      ]),
    ),
  );
  await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  const text = host.textContent ?? '';
  act(() => root.unmount());
  return text;
}

describe('TechStack detail, trends and remediation in the display language', () => {
  afterAll(async () => {
    await surfaceI18n.changeLanguage('en');
  });

  it('keeps English and translates them in Turkish', async () => {
    await surfaceI18n.changeLanguage('en');
    const english = detail();
    for (const text of [
      'npm · Transitive · development',
      'Locked version',
      'No flags reported',
      'high · upgrade minor',
      'Model interpretation · 50% confidence',
    ])
      expect(english).toContain(text);
    const englishPanels = await panels();
    expect(englishPanels).toContain('2 recorded snapshots');
    expect(englishPanels).toContain('npm · workspace w1');
    expect(englishPanels).toContain('Review 0 selected operations');

    await surfaceI18n.changeLanguage('tr');
    const turkish = detail();
    for (const text of [
      'npm · Dolaylı · geliştirme',
      'Kilitli sürüm',
      'İşaret bildirilmedi',
      'yüksek · küçük sürüm yükseltmesi',
      'Model yorumu · %50 güven',
    ])
      expect(turkish).toContain(text);
    const turkishPanels = await panels();
    expect(turkishPanels).toContain('2 kayıtlı anlık görüntü');
    expect(turkishPanels).toContain('npm · çalışma alanı w1');
    expect(turkishPanels).toContain('Seçili 0 işlemi incele');
  });
});
