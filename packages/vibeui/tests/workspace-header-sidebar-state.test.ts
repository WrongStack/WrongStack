// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceHeader } from '../src/components/workspace-header';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const controller = {
  state: { id: 'session-1', messages: [], cwd: '/demo', agents: [] },
  connection: 'open',
  notice: () => {},
  hasActiveWork: false,
  sessionLocked: false,
  send: () => true,
  subscribe: () => () => {},
  renameSession: () => true,
  clearContext: () => true,
  switchSession: () => true,
} as never;

const roots: Root[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.innerHTML = '';
});

async function renderHeader(sidebarOpen: boolean, setSidebar = () => {}) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(
      createElement(WorkspaceHeader, {
        view: 'studio',
        controller,
        connection: 'open',
        state: { runOutcome: null, agents: [], project: 'Demo' },
        sessionTitle: 'Demo session',
        locked: false,
        panel: false,
        sidebarOpen,
        setSidebar,
        setPanel: () => {},
        setFilesOpen: () => {},
        setResources: () => {},
        switchSession: () => {},
      } as never),
    );
  });
  const toggle = host.querySelector<HTMLButtonElement>('button.mobile-menu');
  expect(toggle, 'mobile sidebar toggle renders').not.toBeNull();
  return toggle!;
}

describe('sidebar toggle state (WCAG 4.1.2)', () => {
  it('exposes whether the sessions sidebar is closed or open', async () => {
    const closed = await renderHeader(false);
    expect(closed.getAttribute('aria-label')).toBe('Open sessions');
    expect(closed.getAttribute('aria-expanded')).toBe('false');
    expect(closed.disabled).toBe(false);

    const open = await renderHeader(true);
    expect(open.getAttribute('aria-expanded')).toBe('true');
  });

  it('still toggles the sidebar when activated', async () => {
    const setSidebar = vi.fn();
    const toggle = await renderHeader(false, setSidebar);
    await act(async () => toggle.click());
    expect(setSidebar).toHaveBeenCalledTimes(1);
  });
});
