// @vitest-environment jsdom

import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { emptyEngineState } from '../src/engine-state';
import { ProjectSdd } from '../src/ProjectSdd';
import { surfaceI18n } from '../src/surface-i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The engine never answers here: each page stays on its first view.
const pending = () => new Promise<never>(() => {});

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

// A running board two minutes after its first pickup.
const state = () => ({
  ...emptyEngineState,
  results: {
    ...emptyEngineState.results,
    'sdd.board.list': {
      boards: [{ runId: 'r1', title: 'Ship', status: 'running', completed: 1, total: 3 }],
    },
    'sdd.board.snapshot': {
      runId: 'r1',
      title: 'Ship',
      status: 'running',
      progress: { completed: 1, total: 3, percentComplete: 33 },
      tasks: [{ id: 't1', title: 'Write tests', status: 'in_progress' }],
      feed: [{ ts: Date.now() - 120_000, kind: 'started', text: 'Picked up' }],
    },
  },
});
const sdd = () =>
  createElement(ProjectSdd, {
    state: state(),
    send: vi.fn(async () => {}),
    http: vi.fn(pending),
  });
const runs = '.sdd-navigation button:nth-child(4)';

describe('project SDD in the display language', () => {
  afterAll(() => surfaceI18n.changeLanguage('en'));

  it('shows the interview and a running board in English, then in Turkish', async () => {
    await surfaceI18n.changeLanguage('en');
    let page = await mount(sdd());
    for (const text of [
      'Shape requirements, inspect specifications and follow project execution.',
      'Specifications',
      'Start with the outcome',
      'Start interview',
      'PROJECT CONTEXT',
      'Requirements appear here as the interview develops.',
    ])
      expect(page.text).toContain(text);
    expect(page.labels).toEqual(
      expect.arrayContaining(['Project SDD', 'SDD workspace', 'Project outcome']),
    );
    page = await mount(sdd(), runs);
    for (const text of [
      'Project runs',
      'running · 1 / 3 tasks',
      'Current board shown',
      'CURRENT BOARD',
      'Pause',
      'tasks completed',
      'in progress',
      'Started',
      '2m ago',
      'Project maintenance',
      'Clean managed worktrees',
    ])
      expect(page.text).toContain(text);
    expect(page.labels).toEqual(
      expect.arrayContaining(['Board activity', 'SDD project maintenance']),
    );

    await surfaceI18n.changeLanguage('tr');
    page = await mount(sdd());
    for (const text of [
      'Gereksinimleri şekillendir, şartnameleri incele ve proje yürütmesini takip et.',
      'Şartnameler',
      'Sonuçla başla',
      'Görüşmeyi başlat',
      'PROJE BAĞLAMI',
      'Görüşme ilerledikçe gereksinimler burada görünür.',
    ])
      expect(page.text).toContain(text);
    expect(page.labels).toEqual(
      expect.arrayContaining(['Proje SDD', 'SDD çalışma alanı', 'Proje sonucu']),
    );
    page = await mount(sdd(), runs);
    for (const text of [
      'Proje çalıştırmaları',
      'çalışıyor · 1 / 3 görev',
      'Geçerli pano gösteriliyor',
      'GEÇERLİ PANO',
      'Duraklat',
      'görev tamamlandı',
      'sürüyor',
      'Başladı',
      '2 dk önce',
      'Proje bakımı',
      'Yönetilen çalışma ağaçlarını temizle',
    ])
      expect(page.text).toContain(text);
    expect(page.labels).toEqual(expect.arrayContaining(['Pano etkinliği', 'SDD proje bakımı']));
  });
});
