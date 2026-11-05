// @vitest-environment jsdom

import type { AutomationRunRecord } from '@wrongstack/webui-protocol';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { AutomationEnvironmentEditor } from '../src/AutomationEnvironmentEditor';
import { AutomationRunComparison } from '../src/AutomationRunComparison';
import { AutomationRunInspector } from '../src/AutomationRunInspector';
import { AutomationWorkspace } from '../src/AutomationWorkspace';
import { CatalogModelSearch } from '../src/CatalogModelSearch';
import { ChimeraFinding } from '../src/ChimeraFinding';
import { emptyEngineState } from '../src/engine-state';
import { GoalPhaseVerification } from '../src/GoalPhaseVerification';
import { GoalRevert } from '../src/GoalRevert';
import { ModelAdvancedFields } from '../src/ModelAdvancedFields';
import { ModelCatalogSettings } from '../src/ModelCatalogSettings';
import { ModelDraftAdministration } from '../src/ModelDraftAdministration';
import { ModelDraftSummary } from '../src/ModelDraftNotice';
import { ModelPriceTiers } from '../src/ModelPriceTiers';
import { modelAdvancedDraft } from '../src/model-advanced-editor';
import { modelEditorDraft } from '../src/model-catalog-editor';
import { priceTierDraft } from '../src/model-price-tiers';
import { ProjectAgentRoster } from '../src/ProjectAgentRoster';
import { ProjectChimera } from '../src/ProjectChimera';
import { ProjectDesignStudio } from '../src/ProjectDesignStudio';
import { ProjectGoals } from '../src/ProjectGoals';
import { ProjectRequirements } from '../src/ProjectRequirements';
import { RequirementEvidence } from '../src/RequirementResources';
import { RequirementSummary } from '../src/RequirementSummary';
import { RosterKnowledgeChecklist } from '../src/RosterKnowledgeChecklist';
import { SkillLibrary } from '../src/SkillLibrary';
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
  // Lets replies that resolved during the first render reach their state.
  await act(async () => {});
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

const environmentEditor = (projectId: string) =>
  createElement(AutomationEnvironmentEditor, {
    image: 'wrongstack:latest',
    projectId,
    jobId: undefined,
    onApply: vi.fn(),
    onClose: vi.fn(),
  });

const goalsPage = () =>
  createElement(ProjectGoals, { state: emptyEngineState, send: vi.fn(pending), onKanban: vi.fn() });

const goalParts = () =>
  createElement(
    'div',
    null,
    createElement(GoalPhaseVerification, {
      phase: { verificationAttempts: [{ attempt: 0, ok: true }], integrationStatus: 'merged' },
    }),
    createElement(GoalRevert, {
      goalId: 'g1',
      goal: { revert: { branch: 'main', sha: 'abc1234def' } },
      state: emptyEngineState,
      send: vi.fn(pending),
      readOnly: false,
    }),
  );

// The profile engine identifies itself; the provider list never arrives.
const modelCatalog = () =>
  createElement(ModelCatalogSettings, {
    command: vi.fn((type: string) =>
      type === 'prefs.get'
        ? Promise.resolve({ profileIdentity: { id: 'a'.repeat(64), name: 'Default' } })
        : pending(),
    ),
  });

const modelEditorParts = () =>
  createElement(
    'div',
    null,
    createElement(ModelAdvancedFields, { value: modelAdvancedDraft({}), onChange: vi.fn() }),
    createElement(ModelPriceTiers, {
      value: { changed: false, unsupported: false, rows: [priceTierDraft()] },
      onChange: vi.fn(),
    }),
    createElement(CatalogModelSearch, {
      command: vi.fn(pending),
      providerId: 'openai',
      existing: [],
      onSelect: vi.fn(),
      onClose: vi.fn(),
    }),
    createElement(ModelDraftAdministration, {
      profile: { id: 'a'.repeat(64), name: 'Default' },
      savedProviders: [],
      disabled: false,
      onOpenProvider: vi.fn(),
      storage: { list: vi.fn(pending), save: vi.fn(pending) },
    }),
    createElement(ModelDraftSummary, {
      value: (() => {
        const draft = modelEditorDraft('m1', { name: 'Model one' });
        return { originalId: 'm1', initial: undefined, draft, baseline: draft };
      })(),
    }),
  );

const chimera = () =>
  createElement(
    'div',
    null,
    createElement(ProjectChimera, {
      command: vi.fn(pending),
      projectId: 'chimera',
      events: {},
      sessions: [],
      onPrepare: vi.fn(),
      onNewSession: vi.fn(),
      onOpenFile: vi.fn(),
    }),
    createElement(ChimeraFinding, {
      row: {
        finding: {
          id: 'f1',
          title: 'Unchecked input',
          severity: 'high',
          status: 'in_progress',
          verification: { status: 'verified' },
        },
        events: [],
      },
      busy: false,
      onTransition: vi.fn(),
      onOpenFile: vi.fn(),
    }),
  );

const skills = () =>
  createElement(SkillLibrary, { command: vi.fn(pending), scope: 'project', projectId: 'skills' });

// One kit and no active kit: the gallery and the kit details render, and no draft is read.
const studio = () =>
  createElement(ProjectDesignStudio, {
    projectId: 'design',
    onOpenFile: vi.fn(),
    command: vi.fn(async (type: string) =>
      type === 'design.list'
        ? {
            kits: [
              {
                id: 'calm',
                name: 'Calm',
                aesthetic: 'Quiet',
                bestFor: 'Docs',
                tags: ['minimal'],
                stacks: ['web'],
                light: {},
                dark: {},
              },
            ],
          }
        : pending(),
    ),
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
    for (const text of ['Original request', 'Business goal', 'Not recorded', 'High', 'Standard'])
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
    for (const text of ['Özgün istek', 'İş hedefi', 'Kaydedilmedi', 'Yüksek', 'Standart'])
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

  it('show the automation environment editor in English, then in Turkish', async () => {
    await surfaceI18n.changeLanguage('en');
    let page = await mount(environmentEditor('environment-en'));
    for (const text of [
      'Prepare the workspace.',
      'Setup commands',
      'No supporting services.',
      'Apply environment to draft',
    ])
      expect(page.text).toContain(text);
    expect(page.labels).toEqual(
      expect.arrayContaining(['Environment profile name', 'Close automation environment']),
    );

    await surfaceI18n.changeLanguage('tr');
    page = await mount(environmentEditor('environment-tr'));
    for (const text of [
      'Çalışma alanını hazırla.',
      'Kurulum komutları',
      'Destek servisi yok.',
      'Ortamı taslağa uygula',
    ])
      expect(page.text).toContain(text);
    expect(page.labels).toEqual(
      expect.arrayContaining(['Ortam profili adı', 'Otomasyon ortamını kapat']),
    );
  });

  it('show the goals page in English, then in Turkish', async () => {
    await surfaceI18n.changeLanguage('en');
    let page = await mount(goalsPage());
    for (const text of [
      'Goals',
      'New goal',
      'Execution goals',
      '0 recorded goal runs',
      'Reading the project goal catalog…',
      'Persistent mission',
      'Loading the project mission…',
    ])
      expect(page.text).toContain(text);
    expect(page.labels).toEqual(
      expect.arrayContaining(['Project Goals', 'Search goals', 'Persistent project mission']),
    );
    page = await mount(goalParts());
    for (const text of [
      'Verification passed · 1 attempt · Merged into the project',
      'First check · passed',
      'Revert run',
    ])
      expect(page.text).toContain(text);

    await surfaceI18n.changeLanguage('tr');
    page = await mount(goalsPage());
    for (const text of [
      'Hedefler',
      'Yeni hedef',
      'Yürütme hedefleri',
      '0 kayıtlı hedef çalıştırması',
      'Proje hedef kataloğu okunuyor…',
      'Kalıcı görev',
      'Proje görevi yükleniyor…',
    ])
      expect(page.text).toContain(text);
    expect(page.labels).toEqual(
      expect.arrayContaining(['Proje Hedefleri', 'Hedeflerde ara', 'Kalıcı proje görevi']),
    );
    page = await mount(goalParts());
    for (const text of [
      'Doğrulama geçti · 1 deneme · Projeye birleştirildi',
      'İlk kontrol · geçti',
      'Çalıştırmayı geri al',
    ])
      expect(page.text).toContain(text);
  });

  it('show the model catalog in English, then in Turkish', async () => {
    await surfaceI18n.changeLanguage('en');
    let page = await mount(modelCatalog());
    for (const text of [
      'Model catalog',
      'Add a provider connection to manage its model catalog.',
      'Refresh catalog',
      'Find in model registry',
    ])
      expect(page.text).toContain(text);
    expect(page.labels).toEqual(
      expect.arrayContaining(['Model catalog settings', 'Catalog provider']),
    );
    page = await mount(modelEditorParts());
    for (const text of [
      'Advanced model behavior',
      'Add reasoning control',
      'Context price tiers',
      'Price tier 1',
      'Input USD / million tokens',
      'Add from the model registry',
      'Search registry',
      'Saved drafts',
      'Model one · review form values',
    ])
      expect(page.text).toContain(text);
    expect(page.labels).toEqual(
      expect.arrayContaining(['Model reasoning policy source', 'Price tier 1 input price']),
    );

    await surfaceI18n.changeLanguage('tr');
    page = await mount(modelCatalog());
    for (const text of [
      'Model kataloğu',
      'Model kataloğunu yönetmek için bir sağlayıcı bağlantısı ekle.',
      'Kataloğu yenile',
      'Model kayıt defterinde bul',
    ])
      expect(page.text).toContain(text);
    expect(page.labels).toEqual(
      expect.arrayContaining(['Model kataloğu ayarları', 'Katalog sağlayıcısı']),
    );
    page = await mount(modelEditorParts());
    for (const text of [
      'Gelişmiş model davranışı',
      'Akıl yürütme denetimi ekle',
      'Bağlam fiyat kademeleri',
      'Fiyat kademesi 1',
      'Girdi USD / milyon token',
      'Model kayıt defterinden ekle',
      'Kayıt defterinde ara',
      'Kayıtlı taslaklar',
      'Model one · form değerlerini incele',
    ])
      expect(page.text).toContain(text);
    expect(page.labels).toEqual(
      expect.arrayContaining([
        'Model akıl yürütme politikası kaynağı',
        'Fiyat kademesi 1 girdi fiyatı',
      ]),
    );
  });

  it('show Chimera reviews in English, then in Turkish', async () => {
    await surfaceI18n.changeLanguage('en');
    let page = await mount(chimera());
    for (const text of [
      'Chimera Reviews',
      'Reading review reports…',
      'Inspect the evidence behind a review.',
      'high',
      'in progress',
      'Disk citation: verified',
      'Record resolution',
    ])
      expect(page.text).toContain(text);
    expect(page.labels).toEqual(
      expect.arrayContaining(['Project Chimera reviews', 'Search Chimera reports']),
    );

    await surfaceI18n.changeLanguage('tr');
    page = await mount(chimera());
    for (const text of [
      'Chimera İncelemeleri',
      'İnceleme raporları okunuyor…',
      'Bir incelemenin arkasındaki kanıtı incele.',
      'yüksek',
      'sürüyor',
      'Disk alıntısı: doğrulandı',
      'Çözümü kaydet',
    ])
      expect(page.text).toContain(text);
    expect(page.labels).toEqual(
      expect.arrayContaining(['Proje Chimera incelemeleri', 'Chimera raporlarında ara']),
    );
  });

  it('show the skill library in English, then in Turkish', async () => {
    await surfaceI18n.changeLanguage('en');
    let page = await mount(skills());
    for (const text of [
      'PROJECT CAPABILITIES',
      'Skills',
      'Install from Git',
      'Bundled',
      'Discovering skills…',
      '0 of 0 skills',
      'Instructions with a purpose.',
    ])
      expect(page.text).toContain(text);
    expect(page.labels).toEqual(
      expect.arrayContaining(['Project skill library', 'Search skills', 'Filter skill source']),
    );

    await surfaceI18n.changeLanguage('tr');
    page = await mount(skills());
    for (const text of [
      'PROJE YETENEKLERİ',
      'Beceriler',
      "Git'ten kur",
      'Yerleşik',
      'Beceriler keşfediliyor…',
      'Amacı olan talimatlar.',
    ])
      expect(page.text).toContain(text);
    expect(page.labels).toEqual(
      expect.arrayContaining([
        'Proje beceri kütüphanesi',
        'Becerilerde ara',
        'Beceri kaynağını filtrele',
      ]),
    );
  });

  it('show the design studio in English, then in Turkish', async () => {
    await surfaceI18n.changeLanguage('en');
    let page = await mount(studio());
    for (const text of [
      'Design Studio',
      'Refresh design gallery',
      '1 of 1 kits',
      'EXPLORE THIS DESIGN',
      'Use kit for project',
      'Target stack',
      'YOUR NEXT IDEA',
      'THEME SAMPLE',
      'Scan project design',
    ])
      expect(page.text).toContain(text);
    expect(page.labels).toEqual(
      expect.arrayContaining([
        'Project Design Studio',
        'Search design kits',
        'Preview Calm',
        'Light theme sample',
        'Design target stack',
      ]),
    );

    await surfaceI18n.changeLanguage('tr');
    page = await mount(studio());
    for (const text of [
      'Tasarım Stüdyosu',
      'Tasarım galerisini yenile',
      '1 kitten 1 tanesi',
      'BU TASARIMI KEŞFET',
      'Kiti projede kullan',
      'Hedef yığın',
      'SIRADAKİ FİKRİN',
      'TEMA ÖRNEĞİ',
      'Proje tasarımını tara',
    ])
      expect(page.text).toContain(text);
    expect(page.labels).toEqual(
      expect.arrayContaining([
        'Proje Tasarım Stüdyosu',
        'Tasarım kitlerinde ara',
        'Calm önizlemesi',
        'Açık tema örneği',
        'Tasarım hedef yığını',
      ]),
    );
  });
});
