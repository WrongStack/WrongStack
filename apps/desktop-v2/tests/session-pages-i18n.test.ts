// @vitest-environment jsdom

import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { emptyEngineState } from '../src/engine-state';
import { SessionAgentPlan } from '../src/SessionAgentPlan';
import { SessionProcesses } from '../src/SessionProcesses';
import { SessionRecovery } from '../src/SessionRecovery';
import { surfaceI18n } from '../src/surface-i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no modal dialogs; opening one only has to mark it open here.
HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) {
  this.open = true;
};
HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) {
  this.open = false;
};

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

const recoveryReplies: Record<string, Record<string, unknown>> = {
  'session.inspect': {
    name: 'Fix login',
    provider: 'zai',
    model: 'glm',
    startedAt: '2026-11-04T10:00:00Z',
    retainedMessageCount: 4,
    events: [{ type: 'tool_call', label: 'Read file', ts: '2026-11-04T10:01:00Z' }],
    toolBreakdown: { read: 2 },
    fileEvents: [],
  },
  'session.checkpoints': {
    checkpoints: [
      { promptIndex: 1, promptPreview: 'Fix login', ts: '2026-11-04T10:00:00Z', fileCount: 2 },
    ],
    journalRevision: 'r1',
  },
};
const recovery = () =>
  createElement(SessionRecovery, {
    sessionId: 'core-1',
    sessionTitle: 'Fix login',
    running: false,
    command: vi.fn(async (type: string) => recoveryReplies[type] ?? {}),
    onBack: vi.fn(),
    onOpenFile: vi.fn(),
    onRetryPrompt: vi.fn(),
  });

const processList = {
  sessionId: 'core-1',
  processes: [
    {
      sessionId: 'core-1',
      pid: 42,
      command: 'npm run dev',
      tool: 'shell',
      startedAt: Date.parse('2026-11-04T10:00:00Z'),
      status: 'running',
      background: true,
      hasOutput: true,
    },
  ],
};
const processes = () =>
  createElement(SessionProcesses, {
    sessionId: 'core-1',
    connected: true,
    command: vi.fn(async () => processList),
    onBack: vi.fn(),
  });

// A session plan with one tier lane and one role pinned to a model.
const planPrefs = {
  subagentsAllowed: true,
  subagentCompanionsAllowed: false,
  subagentModelPlan: {
    enabled: true,
    lock: false,
    slots: [{ tier: 'fast', label: 'Research', modelRuntime: { reasoning: { effort: 'high' } } }],
    roles: { reviewer: { provider: 'zai', model: 'glm' } },
  },
  modelTiers: { fast: {} },
  fallbackProfiles: {},
};
const agentPlan = () =>
  createElement(SessionAgentPlan, {
    state: { ...emptyEngineState, provider: 'zai', model: 'glm' },
    command: vi.fn(async (type: string) => (type === 'prefs.get' ? planPrefs : {})),
    onClose: vi.fn(),
  });

describe('the session pages in the display language', () => {
  afterAll(() => surfaceI18n.changeLanguage('en'));

  it('show history and recovery in English, then in Turkish', async () => {
    await surfaceI18n.changeLanguage('en');
    let page = await mount(recovery());
    for (const text of [
      'THIS CONVERSATION · RECORDED HISTORY',
      'History & recovery',
      'Retained messages',
      'Return to a prompt',
      'Redo last rewind',
      'Retry last prompt',
      '2 file snapshots at this prompt index',
      'Follow the journal',
      '1 matching recorded event.',
      'Tool footprint',
      'No file activity recorded.',
    ])
      expect(page.text).toContain(text);
    expect(page.labels).toEqual(
      expect.arrayContaining([
        'Session history and recovery',
        'Review rewind to prompt 1',
        'read recorded calls',
      ]),
    );

    await surfaceI18n.changeLanguage('tr');
    page = await mount(recovery());
    for (const text of [
      'BU KONUŞMA · KAYITLI GEÇMİŞ',
      'Geçmiş ve kurtarma',
      'Korunan mesajlar',
      'Bir isteme dön',
      'Son geri sarmayı yinele',
      'Son istemi yeniden dene',
      'bu istem sırasında 2 dosya anlık görüntüsü',
      'Günlüğü takip et',
      '1 eşleşen kayıtlı olay.',
      'Araç ayak izi',
      'Kayıtlı dosya etkinliği yok.',
    ])
      expect(page.text).toContain(text);
    expect(page.labels).toEqual(
      expect.arrayContaining([
        'Oturum geçmişi ve kurtarma',
        '1. isteme geri sarmayı incele',
        'read kayıtlı çağrıları',
      ]),
    );
  });

  it('show session processes in English, then in Turkish', async () => {
    await surfaceI18n.changeLanguage('en');
    let page = await mount(processes());
    for (const text of [
      'THIS CONVERSATION',
      'Processes',
      '1 running',
      '1 background',
      'Metadata refreshes every 2 seconds',
      '0 selected',
      'Select all running',
      'running',
      'shell · Background',
      'View output',
      'Terminate process',
    ])
      expect(page.text).toContain(text);
    expect(page.labels).toEqual(
      expect.arrayContaining(['Session processes', 'Process selection', 'Select PID 42']),
    );

    await surfaceI18n.changeLanguage('tr');
    page = await mount(processes());
    for (const text of [
      'BU KONUŞMA',
      'Süreçler',
      '1 çalışıyor',
      '1 arka planda',
      'Üst veriler her 2 saniyede yenilenir',
      '0 seçili',
      'Çalışanların tümünü seç',
      'çalışıyor',
      'shell · Arka plan',
      'Çıktıyı görüntüle',
      'Süreci sonlandır',
    ])
      expect(page.text).toContain(text);
    expect(page.labels).toEqual(
      expect.arrayContaining(['Oturum süreçleri', 'Süreç seçimi', 'PID 42 seç']),
    );
  });

  it('shows the agent model plan in English, then in Turkish', async () => {
    await surfaceI18n.changeLanguage('en');
    let page = await mount(agentPlan());
    for (const text of [
      'THIS CONVERSATION',
      'Subagents: Allowed',
      'Companions: Blocked',
      'Chat model: zai/glm',
      'Enable this model plan',
      'Parallel lanes',
      'Lane 1',
      'Cost/capability tier',
      'Reasoning overrides',
      'High',
      'Role reviewer',
      'Remove role override',
      'Saved session plan',
      'Save session plan',
    ])
      expect(page.text).toContain(text);
    expect(page.labels).toEqual(
      expect.arrayContaining([
        'Close agent model plan',
        'Model lane count',
        'Lane 1 label',
        'Lane 1 tier',
        'Lane 1 reasoning effort',
        'Role reviewer choose model',
        'Remove session role reviewer',
      ]),
    );

    await surfaceI18n.changeLanguage('tr');
    page = await mount(agentPlan());
    for (const text of [
      'BU KONUŞMA',
      'Alt ajanlar: İzinli',
      'Yoldaşlar: Engelli',
      'Sohbet modeli: zai/glm',
      'Bu model planını etkinleştir',
      'Paralel şeritler',
      'Şerit 1',
      'Maliyet/yetenek kademesi',
      'Akıl yürütme geçersiz kılmaları',
      'Yüksek',
      'Rol reviewer',
      'Rol geçersiz kılmasını kaldır',
      'Kayıtlı oturum planı',
      'Oturum planını kaydet',
    ])
      expect(page.text).toContain(text);
    expect(page.labels).toEqual(
      expect.arrayContaining([
        'Ajan model planını kapat',
        'Model şeridi sayısı',
        'Şerit 1 etiketi',
        'Şerit 1 kademesi',
        'Rol reviewer için model seç',
        'reviewer oturum rolünü kaldır',
      ]),
    );
  });
});
