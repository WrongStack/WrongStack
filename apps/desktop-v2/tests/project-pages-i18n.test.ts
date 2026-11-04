// @vitest-environment jsdom
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { ProjectAgentRoster } from '../src/ProjectAgentRoster';
import { ProjectRequirements } from '../src/ProjectRequirements';
import { RequirementSummary } from '../src/RequirementSummary';
import { RosterKnowledgeChecklist } from '../src/RosterKnowledgeChecklist';
import { surfaceI18n } from '../src/surface-i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The engine never answers here: each page stays on its first, loading view.
const pending = () => new Promise<never>(() => {});

async function mount(page: ReactElement) {
  const host = document.createElement('div');
  let root: Root | undefined;
  await act(async () => {
    root = createRoot(host);
    root.render(page);
  });
  const text = host.textContent ?? '';
  const labels = [...host.querySelectorAll('[aria-label]')].map((node) =>
    node.getAttribute('aria-label'),
  );
  act(() => root?.unmount());
  return { text, labels };
}

const roster = (projectId: string) =>
  createElement(ProjectAgentRoster, {
    command: vi.fn(pending),
    projectId,
    projectName: 'Shop',
    events: {},
    sessions: [],
    onPrepare: vi.fn(),
    onNewSession: vi.fn(),
    onOpenFile: vi.fn(),
  });

const checklist = () =>
  createElement(RosterKnowledgeChecklist, {
    role: 'reviewer',
    command: vi.fn(pending),
    disabled: false,
  });

const requirements = () =>
  createElement(ProjectRequirements, { http: vi.fn(pending), onStartSdd: vi.fn() });

const summary = () =>
  createElement(RequirementSummary, {
    detail: { originalRequest: 'Add a login page', priority: 'high' },
  });

describe('the project pages in the display language', () => {
  afterAll(async () => {
    await surfaceI18n.changeLanguage('en');
  });

  it('show the agent roster in English, then in Turkish', async () => {
    await surfaceI18n.changeLanguage('en');
    let page = await mount(roster('roster-en'));
    for (const text of [
      'Agent roster',
      'Refresh roster',
      'Loading actual roster…',
      'Choose a role',
    ])
      expect(page.text).toContain(text);
    expect(page.labels).toContain('Search project agent roles');
    page = await mount(checklist());
    expect(page.text).toContain('Loading checklist…');
    expect(page.labels).toContain('Knowledge checklist for reviewer');

    await surfaceI18n.changeLanguage('tr');
    page = await mount(roster('roster-tr'));
    for (const text of [
      'Ajan kadrosu',
      'Kadroyu yenile',
      'Gerçek kadro yükleniyor…',
      'bir rol seç',
    ])
      expect(page.text).toContain(text);
    expect(page.labels).toContain('Proje ajan rollerinde ara');
    page = await mount(checklist());
    expect(page.text).toContain('Kontrol listesi yükleniyor…');
    expect(page.labels).toContain('reviewer için bilgi kontrol listesi');
  });

  it('show the requirements page in English, then in Turkish', async () => {
    await surfaceI18n.changeLanguage('en');
    let page = await mount(requirements());
    for (const text of ['Requirements', 'New requirement', 'Loading requirements…'])
      expect(page.text).toContain(text);
    expect(page.labels).toEqual(
      expect.arrayContaining(['Project requirements', 'Search requirements']),
    );
    page = await mount(summary());
    for (const text of ['Original request', 'Business goal', 'Not recorded', 'high', 'Standard'])
      expect(page.text).toContain(text);

    await surfaceI18n.changeLanguage('tr');
    page = await mount(requirements());
    for (const text of ['Gereksinimler', 'Yeni gereksinim', 'Gereksinimler yükleniyor…'])
      expect(page.text).toContain(text);
    expect(page.labels).toEqual(
      expect.arrayContaining(['Proje gereksinimleri', 'Gereksinimlerde ara']),
    );
    page = await mount(summary());
    for (const text of ['Özgün istek', 'İş hedefi', 'Kaydedilmedi', 'yüksek', 'Standart'])
      expect(page.text).toContain(text);
  });
});
