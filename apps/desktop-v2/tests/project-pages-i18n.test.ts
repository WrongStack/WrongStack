// @vitest-environment jsdom

import type { AutomationRunRecord } from '@wrongstack/webui-protocol';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { AutomationRunComparison } from '../src/AutomationRunComparison';
import { AutomationRunInspector } from '../src/AutomationRunInspector';
import { AutomationWorkspace } from '../src/AutomationWorkspace';
import { ProjectAgentRoster } from '../src/ProjectAgentRoster';
import { ProjectRequirements } from '../src/ProjectRequirements';
import { RequirementEvidence } from '../src/RequirementResources';
import { RequirementSummary } from '../src/RequirementSummary';
import { RosterKnowledgeChecklist } from '../src/RosterKnowledgeChecklist';
import { surfaceI18n } from '../src/surface-i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no modal dialogs; opening one only has to mark it open here.
HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) {
  this.open = true;
};
HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) {
  this.open = false;
};

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

const evidence = () =>
  createElement(RequirementEvidence, {
    detail: {
      relatedResources: [{ kind: 'pr', reference: '#12' }],
      llmSuggestions: [{ id: 's1', field: 'priority', status: 'pending', value: 'high' }],
      fieldSources: { business_goal: 'llm' },
    },
    onDecision: vi.fn(),
  });

const automation = (projectId: string) =>
  createElement(AutomationWorkspace, { http: vi.fn(pending), projectId });

const automationRun = (id: string, status: AutomationRunRecord['status']): AutomationRunRecord => ({
  id,
  jobId: 'job',
  subjectKey: 'subject',
  trigger: 'manual',
  status,
  createdAt: 0,
});

const comparison = () =>
  createElement(AutomationRunComparison, {
    left: automationRun('aaaaaaaa1', 'completed'),
    right: automationRun('bbbbbbbb2', 'failed'),
    onClose: vi.fn(),
  });

const inspector = () =>
  createElement(AutomationRunInspector, {
    run: automationRun('cccccccc3', 'queued'),
    http: vi.fn(pending),
    onClose: vi.fn(),
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

  it('show the requirements page and its evidence in English, then in Turkish', async () => {
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
    page = await mount(evidence());
    for (const text of [
      'Supporting resources',
      'Pull request',
      'Recorded suggestions',
      'Priority',
      'pending',
      'Accept suggestion',
      'Model proposal',
    ])
      expect(page.text).toContain(text);
    expect(page.labels).toContain('Requirement evidence and sources');

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
    page = await mount(evidence());
    for (const text of [
      'Destekleyici kaynaklar',
      'Kaydedilen öneriler',
      'Öncelik',
      'bekliyor',
      'Öneriyi kabul et',
      'Model önerisi',
    ])
      expect(page.text).toContain(text);
    expect(page.labels).toContain('Gereksinim kanıtları ve kaynakları');
  });

  it('show the automation workspace in English, then in Turkish', async () => {
    await surfaceI18n.changeLanguage('en');
    let page = await mount(automation('automation-en'));
    for (const text of [
      'Worker offline · jobs remain editable',
      'New automation',
      'Unsaved drafts are kept per job and restored after a restart.',
      'No automations in this project.',
      'Recent runs',
      'Create automation',
      'Save automation',
      'Start with a workflow',
      'Reusable environment',
      'No saved credentials referenced.',
      'GitHub events',
    ])
      expect(page.text).toContain(text);
    expect(page.labels).toEqual(
      expect.arrayContaining([
        'Automation jobs',
        'Automation name',
        'Automation schedule',
        'Use GitHub automation trigger',
      ]),
    );

    await surfaceI18n.changeLanguage('tr');
    page = await mount(automation('automation-tr'));
    for (const text of [
      'Çalıştırıcı çevrimdışı · işler düzenlenebilir',
      'Yeni otomasyon',
      'Bu projede otomasyon yok.',
      'Son çalıştırmalar',
      'Otomasyon oluştur',
      'Otomasyonu kaydet',
      'Bir iş akışıyla başla',
      'Yeniden kullanılabilir ortam',
      'Referans verilen kayıtlı kimlik bilgisi yok.',
      'GitHub olayları',
    ])
      expect(page.text).toContain(text);
    expect(page.labels).toEqual(
      expect.arrayContaining([
        'Otomasyon işleri',
        'Otomasyon adı',
        'Otomasyon zamanlaması',
        'GitHub otomasyon tetikleyicisini kullan',
      ]),
    );
  });

  it('show automation run evidence and comparison in English, then in Turkish', async () => {
    await surfaceI18n.changeLanguage('en');
    let page = await mount(comparison());
    for (const text of ['Compare runs', 'Run aaaaaaaa', 'Status', 'completed', 'Not recorded'])
      expect(page.text).toContain(text);
    page = await mount(inspector());
    for (const text of [
      'Execution & evidence',
      'queued',
      'Execution log',
      'Recorded evidence',
      'Pull request workflow',
      'Review publication state',
    ])
      expect(page.text).toContain(text);
    expect(page.labels).toContain('Automation pull request review');

    await surfaceI18n.changeLanguage('tr');
    page = await mount(comparison());
    for (const text of [
      'Çalıştırmaları karşılaştır',
      'Çalıştırma aaaaaaaa',
      'Durum',
      'tamamlandı',
      'Kaydedilmedi',
    ])
      expect(page.text).toContain(text);
    page = await mount(inspector());
    for (const text of [
      'Yürütme ve kanıt',
      'sırada',
      'Yürütme günlüğü',
      'Kaydedilen kanıt',
      'Pull request iş akışı',
      'Yayın durumunu incele',
    ])
      expect(page.text).toContain(text);
    expect(page.labels).toContain('Otomasyon pull request incelemesi');
  });
});
