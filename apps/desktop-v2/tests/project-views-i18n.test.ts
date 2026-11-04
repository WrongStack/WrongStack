// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { ProjectViews } from '../src/ProjectViews';
import { surfaceI18n } from '../src/surface-i18n';
import type { DesktopController } from '../src/useDesktop';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../src/useEngine', () => ({
  useProfileEngine: () => ({ state: { connected: false, results: {} }, command: vi.fn() }),
}));

const project = { id: 'p1', name: 'Shop', root: 'D:/shop' };
const session = (id: string, status: string, kind: string, exitCode: number | null) => ({
  id,
  projectId: 'p1',
  title: `Session ${id}`,
  status,
  kind,
  exitCode,
  updatedAt: 0,
});
const vmFor = (section: string) =>
  ({
    snapshot: {
      projects: [project],
      sessions: [session('a', 'running', 'agent', null), session('b', 'error', 'terminal', 2)],
    },
    section,
    run: vi.fn(),
    newSession: vi.fn(),
    jumpToSession: vi.fn(),
    openProjectPage: vi.fn(),
  }) as unknown as DesktopController;

async function render(section: string) {
  const host = document.createElement('div');
  await act(async () =>
    createRoot(host).render(createElement(ProjectViews, { vm: vmFor(section) })),
  );
  return host;
}

describe('the project list and activity in the display language', () => {
  it('counts sessions and names states in English, then in Turkish', async () => {
    let projects = await render('projects');
    expect(projects.textContent).toContain('Active: 1');
    expect(projects.textContent).toContain('Sessions: 2');
    expect(projects.textContent).toContain('Open project');
    let activity = await render('activity');
    expect(activity.textContent).toContain('Shop · terminal · error · exit 2');
    await act(async () => {
      await surfaceI18n.changeLanguage('tr');
    });
    projects = await render('projects');
    expect(projects.textContent).toContain('Etkin: 1');
    expect(projects.textContent).toContain('Oturum: 2');
    expect(projects.textContent).toContain('Projeyi aç');
    activity = await render('activity');
    expect(activity.textContent).toContain('Shop · ajan · çalışıyor');
    expect(activity.textContent).toContain('Shop · terminal · hata · çıkış 2');
    await act(async () => {
      await surfaceI18n.changeLanguage('en');
    });
  });
});
