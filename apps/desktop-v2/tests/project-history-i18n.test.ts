// @vitest-environment jsdom

import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { ProjectSessionHistory } from '../src/ProjectSessionHistory';
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
  if (click)
    await act(async () => {
      (host.querySelector(click) as HTMLElement | null)?.click();
    });
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
});
