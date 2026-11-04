// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { emptyEngineState } from '../src/engine-state';
import type { Session } from '../src/model';
import { SessionStatusBar } from '../src/SessionStatusBar';
import { SessionWorkbench } from '../src/SessionWorkbench';
import { surfaceI18n } from '../src/surface-i18n';
import type { DesktopController } from '../src/useDesktop';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const terminal: Session = {
  id: 'term-1',
  projectId: 'p1',
  title: 'Shell',
  kind: 'terminal',
  workdir: 'D:/repo',
  status: 'running',
  createdAt: 1,
  updatedAt: 1,
  exitCode: null,
  error: null,
};
const vm = {
  snapshot: {
    projects: [{ id: 'p1', name: 'Repo', root: 'D:/repo', createdAt: 1 }],
    sessions: [terminal],
  },
  currentSession: terminal,
  openSessionIds: ['term-1'],
  jumpToSession: () => undefined,
  closeSessionTab: () => undefined,
  reportError: () => undefined,
  run: () => undefined,
  getDraft: () => '',
  setDraft: () => undefined,
  newSession: () => undefined,
} as unknown as DesktopController;

async function render(element: ReturnType<typeof createElement>) {
  const host = document.createElement('div');
  document.body.append(host);
  let root: Root | undefined;
  await act(async () => {
    root = createRoot(host);
    root.render(element);
  });
  const text = host.textContent ?? '';
  const labels = [...host.querySelectorAll('[aria-label],[title]')].map(
    (node) => node.getAttribute('aria-label') ?? node.getAttribute('title'),
  );
  act(() => root?.unmount());
  host.remove();
  return { text, labels };
}

const statusBar = () =>
  createElement(SessionStatusBar, {
    state: {
      ...emptyEngineState,
      connected: true,
      running: true,
      results: { 'iteration.started': { index: 2, maxIterations: 10 } },
    },
    command: vi.fn(() => new Promise<Record<string, unknown>>(() => undefined)),
    refresh: () => undefined,
  });

describe('workbench and status bar in the display language', () => {
  afterAll(async () => {
    await surfaceI18n.changeLanguage('en');
  });

  it('keeps English and translates the tabs and the status line in Turkish', async () => {
    await surfaceI18n.changeLanguage('en');
    const english = await render(createElement(SessionWorkbench, { vm }));
    expect(english.text).toContain('Stop session');
    expect(english.labels).toEqual(
      expect.arrayContaining(['Session workbench', 'Open sessions', 'Detach Shell']),
    );
    const englishBar = await render(statusBar());
    expect(englishBar.text).toContain('Working');
    expect(englishBar.text).toContain('Iteration 3 of 10');
    expect(englishBar.labels).toEqual(
      expect.arrayContaining(['Context. Open context details', 'Refresh engine usage']),
    );

    await surfaceI18n.changeLanguage('tr');
    const turkish = await render(createElement(SessionWorkbench, { vm }));
    expect(turkish.text).toContain('Oturumu durdur');
    expect(turkish.labels).toEqual(
      expect.arrayContaining(['Oturum çalışma alanı', 'Açık oturumlar', 'Shell sekmesini ayır']),
    );
    const turkishBar = await render(statusBar());
    expect(turkishBar.text).toContain('Çalışıyor');
    expect(turkishBar.text).toContain('Yineleme 3 / 10');
    expect(turkishBar.labels).toEqual(
      expect.arrayContaining(['Bağlam. Bağlam ayrıntılarını aç', 'Motor kullanımını yenile']),
    );
  });
});
