// @vitest-environment jsdom

import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { ProjectHistorySearch } from '../src/ProjectHistorySearch';
import { ProjectSessionHistory } from '../src/ProjectSessionHistory';
import { ProjectUsageSummary } from '../src/ProjectUsageSummary';
import { SessionInspectSummary } from '../src/SessionInspectSummary';
import { SessionTranscript } from '../src/SessionTranscript';
import { surfaceI18n } from '../src/surface-i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A selector whose first match is clicked, or an action on the rendered page. */
type Step = string | ((host: HTMLElement) => void);

/** Renders a page, takes each step in turn, then reads its text and accessible names. */
async function mount(page: ReactElement, ...steps: Step[]) {
  const host = document.createElement('div');
  document.body.append(host);
  let root: Root | undefined;
  await act(async () => {
    root = createRoot(host);
    root.render(page);
  });
  await act(async () => {});
  for (const step of steps) {
    await act(async () => {
      if (typeof step === 'string') (host.querySelector(step) as HTMLElement | null)?.click();
      else step(host);
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

// One named, finished conversation and one untitled journal without an outcome.
const sessions = [
  {
    id: 'h1',
    title: 'Fix login',
    provider: 'zai',
    model: 'glm',
    outcome: 'completed',
    lastUserMessage: 'Fix the login form',
    startedAt: '2026-11-04T10:00:00Z',
  },
  { id: 'h2', provider: 'zai', model: 'glm', startedAt: '2026-11-04T09:00:00Z' },
];
/** Answers a catalog read with the page size the page asked for. */
const reply = async (type: string, payload: Record<string, unknown> = {}) => {
  if (type !== 'sessions.list') return {};
  const asked = payload['catalogPage'] as { limit?: number } | undefined;
  return {
    sessions,
    catalogPage: {
      offset: 0,
      limit: asked?.limit ?? 100,
      total: 2,
      nextOffset: null,
      revision: 'a'.repeat(64),
      truncated: false,
    },
  };
};
const history = (projectId: string) =>
  createElement(ProjectSessionHistory, {
    projectId,
    carrierId: 'carrier',
    command: vi.fn(reply),
    sessions: [],
    onOpen: vi.fn(),
    onPrepare: vi.fn(async () => true),
    onNewSession: vi.fn(),
    onOpenFile: vi.fn(),
  });
const firstRow = '.history-catalog button';

// Summaries the engine reads on request, and a content search with one hit for "login".
const summaryReply = async (_type: string, payload: Record<string, unknown> = {}) => {
  if (payload['usageSummary'])
    return {
      usageSummary: {
        sessions: 3,
        sessionsWithTokens: 2,
        tokenTotal: 900,
        capped: false,
        byModel: [{ provider: 'zai', model: 'glm', sessions: 2, tokenTotal: 900 }],
      },
    };
  if (payload['sideEffectsSummary'])
    return {
      sideEffectsSummary: {
        sessionsScanned: 5,
        total: 4,
        sessionsWithEffects: 2,
        unreadable: 1,
        byRisk: { shell: 3, 'fs.write': 1 },
        byTool: { bash: 3 },
        records: [
          {
            sessionId: 'h1',
            sessionTitle: 'Fix login',
            toolName: 'bash',
            ts: '2026-11-04T10:00:00Z',
            risk: 'shell',
            outcome: 'ok',
            input: 'npm test',
          },
        ],
      },
    };
  const query = (payload['contentSearch'] as { query?: string } | undefined)?.query;
  return {
    contentSearch: {
      revision: 'r1',
      catalogRevision: 'c1',
      scanned: 3,
      total: 3,
      nextCursor: null,
      errors: [],
      results:
        query === 'login'
          ? [
              {
                id: 'h1',
                title: 'Fix login',
                matching: 1,
                provider: 'zai',
                model: 'glm',
                revision: 'r1',
                hits: [{ messageIndex: 1, role: 'user', excerpt: 'Fix the login form' }],
              },
            ]
          : [],
    },
  };
};
const summaries = () => createElement(ProjectUsageSummary, { command: vi.fn(summaryReply) });
const search = () =>
  createElement(ProjectHistorySearch, { command: vi.fn(summaryReply), onSelect: vi.fn() });
const usageButton = 'details:nth-child(2) > button';
const effectsButton = '.project-side-effect-controls button';
const submit = 'button[type="submit"]';
/** Types into the search field the way a person would, so React sees the change. */
const typeQuery = (value: string) => (host: HTMLElement) => {
  const input = host.querySelector('input') as HTMLInputElement;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

// A recorded exchange whose blocks cover every kind the reader draws, and its session summary.
const readerReply = async (_type: string, payload: Record<string, unknown> = {}) =>
  payload['transcript']
    ? {
        transcript: {
          revision: 'r1',
          matching: 2,
          total: 2,
          nextOffset: null,
          messages: [
            {
              index: 0,
              role: 'user',
              ts: '2026-11-04T10:00:00Z',
              blocks: [{ index: 0, type: 'text', text: 'Fix the login form' }],
            },
            {
              index: 1,
              role: 'assistant',
              ts: '2026-11-04T10:01:00Z',
              blocks: [
                { index: 0, type: 'thinking', text: 'Look at the form first.' },
                { index: 1, type: 'tool_use', name: 'read', input: { path: 'login.ts' } },
                { index: 2, type: 'tool_result', name: 'read', isError: true, text: 'Missing' },
                { index: 3, type: 'image', mediaType: 'image/png' },
                { index: 4, type: 'document', pages: 3, text: 'Terms', nextTextOffset: 5 },
              ],
            },
          ],
        },
      }
    : {
        tokenTotal: 900,
        messageCount: 4,
        iterationCount: 2,
        toolCallCount: 3,
        toolErrorCount: 1,
        fileChangeCount: 1,
        compactionCount: 0,
        outcome: 'completed',
        events: [{ type: 'tool_call', label: 'Read file', ts: '2026-11-04T10:01:00Z' }],
        toolBreakdown: { read: 3 },
        fileEvents: [{ filePath: 'src/login.ts', toolName: 'edit', operation: 'modify' }],
      };
const reader = () =>
  createElement(SessionTranscript, {
    id: 'h1',
    command: vi.fn(readerReply),
    onLink: vi.fn(),
    onReuse: vi.fn(),
  });
const inspector = () =>
  createElement(SessionInspectSummary, { id: 'h1', command: vi.fn(readerReply) });
/** Opens the session summary the way a click on its disclosure does. */
const openSummary = (host: HTMLElement) => {
  const details = host.querySelector('details') as HTMLDetailsElement;
  details.open = true;
  details.dispatchEvent(new Event('toggle'));
};

describe('project session history in the display language', () => {
  afterAll(() => surfaceI18n.changeLanguage('en'));

  it('shows the catalog and a selected conversation in English, then in Turkish', async () => {
    await surfaceI18n.changeLanguage('en');
    let page = await mount(history('history-en'));
    for (const text of [
      'Session history',
      'Refresh session history',
      'Retry history view storage',
      'History view changes are not saved.',
      'All providers',
      'Error recorded',
      '100 per page',
      '2 matching summaries on this page · 1–2 of 2 records. Summary filters apply to this page.',
      'Include empty journals',
      'Previous history page',
      'Search across conversations',
      'Fix login',
      'Untitled conversation',
      'completed',
      'Recorded',
      'Return to the work.',
    ])
      expect(page.text).toContain(text);
    expect(page.labels).toEqual(
      expect.arrayContaining([
        'Project session history',
        'History provider',
        'Recorded project sessions',
        'Open history h1',
      ]),
    );
    page = await mount(history('history-en'), firstRow);
    for (const text of [
      'RECORDED CONVERSATION',
      'zai / glm · Started',
      'Rename recorded session',
      'Resume recorded conversation',
      'Continue a copy',
      'Read-only history. Reading does not resume or run the agent. File links open',
    ])
      expect(page.text).toContain(text);
    expect(page.labels).toContain('Copy recorded session ID');

    await surfaceI18n.changeLanguage('tr');
    page = await mount(history('history-tr'));
    for (const text of [
      'Oturum geçmişi',
      'Oturum geçmişini yenile',
      'Geçmiş görünümü kaydını yeniden dene',
      'Geçmiş görünümü değişiklikleri kaydedilmedi.',
      'Tüm sağlayıcılar',
      'Hata kaydedildi',
      'Sayfa başına 100',
      'Bu sayfada 2 eşleşen özet · 2 kaydın 1–2 arası.',
      'Boş günlükleri dahil et',
      'Adsız konuşma',
      'tamamlandı',
      'Kaydedildi',
      'İşe geri dön.',
    ])
      expect(page.text).toContain(text);
    expect(page.labels).toEqual(
      expect.arrayContaining(['Proje oturum geçmişi', 'Geçmiş sağlayıcısı', 'h1 geçmişini aç']),
    );
    page = await mount(history('history-tr'), firstRow);
    for (const text of [
      'KAYITLI KONUŞMA',
      'zai / glm · Başlangıç',
      'Kayıtlı oturumu yeniden adlandır',
      'Kayıtlı konuşmayı sürdür',
      'Kopyayla devam et',
      'Salt okunur geçmiş.',
    ])
      expect(page.text).toContain(text);
    expect(page.labels).toContain('Kayıtlı oturum kimliğini kopyala');
  });

  it('shows usage, side effects and search results in English, then in Turkish', async () => {
    await surfaceI18n.changeLanguage('en');
    let page = await mount(summaries(), usageButton, effectsButton);
    for (const text of [
      'Recorded usage',
      'Conversations to count',
      'All projects in this profile',
      '900 tokens across 3 conversations (1 without a recorded total).',
      'Conversations',
      'Recorded side effects',
      '4 recorded in 2 of 5 conversations; 1 journals could not be read.',
      'Input / outcome',
    ])
      expect(page.text).toContain(text);
    expect(page.labels).toEqual(
      expect.arrayContaining(['Recorded tokens by model', 'Recorded side effects']),
    );
    page = await mount(search(), typeQuery('login'), submit);
    for (const text of [
      'Search complete. 3 of 3 records checked · 1 matching conversations.',
      '1 matching messages · zai / glm',
      'USER · Message 2',
      'Read matching message →',
    ])
      expect(page.text).toContain(text);
    expect(page.labels).toEqual(
      expect.arrayContaining([
        'Search across project conversations',
        'Read search match h1 message 2',
      ]),
    );
    page = await mount(search(), typeQuery('nothing'), submit);
    expect(page.text).toContain('No retained conversation text matches this search.');

    await surfaceI18n.changeLanguage('tr');
    page = await mount(summaries(), usageButton, effectsButton);
    for (const text of [
      'Kayıtlı kullanım',
      'Sayılacak konuşmalar',
      'Bu profildeki tüm projeler',
      '3 konuşmada 900 token (1 tanesinin kayıtlı toplamı yok).',
      'Konuşmalar',
      'Kayıtlı yan etkiler',
      '5 konuşmanın 2 tanesinde 4 kayıt; 1 günlük okunamadı.',
      'Girdi / sonuç',
    ])
      expect(page.text).toContain(text);
    expect(page.labels).toEqual(
      expect.arrayContaining(['Modele göre kayıtlı tokenlar', 'Kayıtlı yan etkiler']),
    );
    page = await mount(search(), typeQuery('login'), submit);
    for (const text of [
      'Arama tamamlandı. 3 kaydın 3 tanesi kontrol edildi · 1 eşleşen konuşma.',
      '1 eşleşen ileti · zai / glm',
      'KULLANICI · İleti 2',
      'Eşleşen iletiyi oku →',
    ])
      expect(page.text).toContain(text);
    expect(page.labels).toContain('h1 arama eşleşmesinin 2. iletisini oku');
    page = await mount(search(), typeQuery('nothing'), submit);
    expect(page.text).toContain('Bu aramayla eşleşen saklı konuşma metni yok.');
  });

  it('shows the conversation reader and session summary in English, then in Turkish', async () => {
    await surfaceI18n.changeLanguage('en');
    let page = await mount(reader());
    for (const text of [
      'Refresh transcript',
      'Search transcript',
      '2 matching messages · 2 retained messages.',
      'USER',
      'ASSISTANT',
      'Add visible text to draft',
      'Recorded reasoning',
      'Tool request · read',
      'Bounded input preview from the journal.',
      'Show complete input',
      'Tool result · read · error',
      'Image attachment',
      'Show image',
      'PDF attachment',
      '3 pages · Extracted text; binary PDF not loaded.',
      'Read next text part',
      'Showing a bounded text excerpt. More text is available.',
      'Session summary',
    ])
      expect(page.text).toContain(text);
    expect(page.labels).toEqual(
      expect.arrayContaining([
        'Recorded session transcript',
        'Recorded message 1',
        'Copy visible recorded text',
      ]),
    );
    page = await mount(inspector(), openSummary);
    for (const text of [
      'Tool calls',
      '3 · 1 failed',
      'Outcome: completed',
      'Event timeline · 1 / 1',
      'Tool breakdown',
      'File changes · 1',
      'Modified',
    ])
      expect(page.text).toContain(text);
    expect(page.labels).toContain('Filter session events');

    await surfaceI18n.changeLanguage('tr');
    page = await mount(reader());
    for (const text of [
      'Dökümü yenile',
      'Dökümde ara',
      '2 eşleşen ileti · 2 saklı ileti.',
      'KULLANICI',
      'ASİSTAN',
      'Görünen metni taslağa ekle',
      'Kayıtlı akıl yürütme',
      'Araç isteği · read',
      'Günlükten sınırlı girdi önizlemesi.',
      'Girdinin tamamını göster',
      'Araç sonucu · read · hata',
      'Görsel eki',
      'Görseli göster',
      'PDF eki',
      '3 sayfa · Çıkarılan metin; ikili PDF yüklenmedi.',
      'Sonraki metin parçasını oku',
      'Sınırlı bir metin alıntısı gösteriliyor.',
      'Oturum özeti',
    ])
      expect(page.text).toContain(text);
    expect(page.labels).toEqual(
      expect.arrayContaining([
        'Kayıtlı oturum dökümü',
        'Kayıtlı ileti 1',
        'Görünen kayıtlı metni kopyala',
      ]),
    );
    page = await mount(inspector(), openSummary);
    for (const text of [
      'Araç çağrıları',
      '3 · 1 başarısız',
      'Sonuç: tamamlandı',
      'Olay zaman çizelgesi · 1 / 1',
      'Araç dağılımı',
      'Dosya değişiklikleri · 1',
      'Değiştirildi',
    ])
      expect(page.text).toContain(text);
    expect(page.labels).toContain('Oturum olaylarını filtrele');
  });
});
