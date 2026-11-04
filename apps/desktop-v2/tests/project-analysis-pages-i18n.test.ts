// @vitest-environment jsdom

import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { ProjectChronicle } from '../src/ProjectChronicle';
import { ProjectDeadCode } from '../src/ProjectDeadCode';
import { surfaceI18n } from '../src/surface-i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Renders a page, optionally clicks the first element matching `click`, then reads it. */
async function mount(page: ReactElement, click?: string) {
  const host = document.createElement('div');
  document.body.append(host);
  let root: Root | undefined;
  await act(async () => {
    root = createRoot(host);
    root.render(page);
  });
  await act(async () => {});
  if (click) {
    await act(async () => {
      (host.querySelector(click) as HTMLElement | null)?.click();
    });
    await act(async () => {});
  }
  const text = host.textContent ?? '';
  const labels = [...host.querySelectorAll('[aria-label]')].map((node) =>
    node.getAttribute('aria-label'),
  );
  act(() => root?.unmount());
  host.remove();
  return { text, labels };
}

const report = {
  findings: [
    {
      id: 'f1',
      category: 'dead-export',
      confidence: 'high',
      file: 'src/a.ts',
      line: 3,
      name: 'unused',
      kind: 'function',
      reason: 'Nothing imports it.',
      fix: 'remove-declaration',
    },
  ],
  stats: {
    files: 10,
    entryFiles: 1,
    reachableFiles: 9,
    durationMs: 1200,
    parsedFiles: 10,
    testFiles: 2,
    cachedFiles: 0,
  },
  warnings: [],
};
const http = vi.fn(async (resource: string) =>
  resource === '/api/deadcode/scan'
    ? report
    : { backups: [{ id: 'b1', createdAt: '2026-11-04', files: 2, findingIds: ['f1'] }] },
);
// The scan result is kept per project, so each language scans its own project.
const deadCode = (projectId: string) =>
  createElement(ProjectDeadCode, {
    http,
    projectId,
    sessions: [],
    onPrepare: vi.fn(),
    onNewSession: vi.fn(),
    onOpenFile: vi.fn(),
  });

const chronicleReplies: Record<string, Record<string, unknown>> = {
  'chronicle.query': {
    events: [
      {
        eventId: 'e1',
        eventType: 'tool.call',
        outcome: 'success',
        occurredAt: '2026-11-04T10:00:00Z',
        attributes: { summary: 'Ran tests' },
        resource: { path: 'src/a.ts' },
      },
    ],
    total: 1,
    summary: { modelAttempts: 2, toolCalls: 1, uniqueFiles: 1, failures: 0 },
    sourceFiles: 1,
    scannedEvents: 1,
    invalidLines: 0,
  },
  'chronicle.status': { mode: 'server', pipeline: {}, journal: {}, watcher: { active: true } },
  'chronicle.facets': { values: {} },
};
const chronicle = () =>
  createElement(ProjectChronicle, {
    command: vi.fn(async (type: string) => chronicleReplies[type] ?? {}),
    onOpenFile: vi.fn(),
  });

describe('the analysis pages in the display language', () => {
  afterAll(() => surfaceI18n.changeLanguage('en'));

  it('show a dead-code scan in English, then in Turkish', async () => {
    await surfaceI18n.changeLanguage('en');
    let page = await mount(deadCode('dead-en'), '.dead-code-scan-controls .button.primary');
    for (const text of [
      'Dead Code',
      'Rescan dead code',
      'Entry points',
      'Showing the entire project. 1.2 seconds · 10 parsed · 2 test files',
      'dead export',
      'high confidence',
      'Mechanical action: remove declaration',
      '1 visible findings · 0 selected · 0 mechanically fixable',
      'Recovery backups (1)',
      '2 files · 1 findings',
    ])
      expect(page.text).toContain(text);
    expect(page.labels).toEqual(
      expect.arrayContaining(['Project dead-code workspace', 'Select finding f1']),
    );

    await surfaceI18n.changeLanguage('tr');
    page = await mount(deadCode('dead-tr'), '.dead-code-scan-controls .button.primary');
    for (const text of [
      'Ölü Kod',
      'Ölü kodu yeniden tara',
      'Giriş noktaları',
      'projenin tamamı gösteriliyor. 1.2 saniye · 10 ayrıştırıldı · 2 test dosyası',
      'ölü dışa aktarım',
      'yüksek güven',
      'Mekanik eylem: bildirimi kaldır',
      'Kurtarma yedekleri (1)',
      '2 dosya · 1 bulgu',
    ])
      expect(page.text).toContain(text);
    expect(page.labels).toEqual(
      expect.arrayContaining(['Proje ölü kod çalışma alanı', 'f1 bulgusunu seç']),
    );
  });

  it('show the Chronicle timeline and an event in English, then in Turkish', async () => {
    await surfaceI18n.changeLanguage('en');
    let page = await mount(chronicle(), '.chronicle-events button');
    for (const text of [
      'Refresh journal',
      'Matching events',
      'Event type',
      'Project timeline',
      '1 of 1 loaded',
      'success',
      'EVENT EVIDENCE',
      'Trace related events',
      'Occurred',
      'Journal health',
      'server · watching files',
      'Project insights',
    ])
      expect(page.text).toContain(text);
    expect(page.labels).toEqual(
      expect.arrayContaining([
        'Project Chronicle',
        'Chronicle eventType',
        'Inspect Ran tests',
        'Chronicle event details',
      ]),
    );

    await surfaceI18n.changeLanguage('tr');
    page = await mount(chronicle(), '.chronicle-events button');
    for (const text of [
      'Günlüğü yenile',
      'Eşleşen olaylar',
      'Olay türü',
      'Proje zaman çizelgesi',
      '1 olaydan 1 tanesi yüklendi',
      'başarılı',
      'OLAY KANITI',
      'İlgili olayları izle',
      'Gerçekleşme',
      'Günlük sağlığı',
      'server · dosyalar izleniyor',
      'Proje içgörüleri',
    ])
      expect(page.text).toContain(text);
    expect(page.labels).toEqual(
      expect.arrayContaining([
        'Proje Kroniği',
        'Kronik olay türü',
        'Ran tests olayını incele',
        'Kronik olay ayrıntıları',
      ]),
    );
  });
});
