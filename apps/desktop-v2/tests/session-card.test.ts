// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../src/model';
import { SessionCard } from '../src/SessionCard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const roots: Array<ReturnType<typeof createRoot>> = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
});
const session: Session = {
  id: 'session',
  projectId: 'project',
  title: 'Review the workspace 検証',
  kind: 'agent',
  workdir: 'D:/fixture',
  status: 'running',
  createdAt: 1,
  updatedAt: 1,
  exitCode: null,
  error: null,
};
async function mount(value = session, pinned = false) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  const onOpen = vi.fn(),
    onLaunch = vi.fn(),
    onTogglePin = vi.fn();
  await act(async () =>
    root.render(
      createElement(SessionCard, {
        session: value,
        name: 'Fixture project',
        selected: false,
        pinned,
        onOpen,
        onLaunch,
        onTogglePin,
      }),
    ),
  );
  return { host, onOpen, onLaunch, onTogglePin };
}

describe('compact session rows', () => {
  it('offers one open action, launches a live agent, and keeps pinning independent', async () => {
    const view = await mount();
    const buttons = Array.from(view.host.querySelectorAll('button'));
    expect(buttons).toHaveLength(2);
    expect(buttons[0]?.textContent).toContain(session.title);
    expect(buttons[0]?.title).toContain('Fixture project');
    expect(buttons[0]?.title).toContain(session.title);
    await act(async () => buttons[1]?.click());
    expect(view.onTogglePin).toHaveBeenCalledOnce();
    expect(view.onLaunch).not.toHaveBeenCalled();
    expect(view.onOpen).not.toHaveBeenCalled();
    await act(async () => buttons[0]?.click());
    expect(view.onLaunch).toHaveBeenCalledOnce();
    expect(view.onOpen).not.toHaveBeenCalled();
  });

  it.each(['stopped', 'error', 'interrupted'] as const)(
    'opens a %s transcript without launching it',
    async (status) => {
      const view = await mount({ ...session, status });
      await act(async () =>
        view.host.querySelector<HTMLButtonElement>('.session-card-main')?.click(),
      );
      expect(view.onOpen).toHaveBeenCalledOnce();
      expect(view.onLaunch).not.toHaveBeenCalled();
    },
  );

  it('attaches a live terminal and exposes the persisted pin state', async () => {
    const view = await mount({ ...session, kind: 'terminal' }, true);
    expect(view.host.querySelector('.card-pin')?.getAttribute('aria-pressed')).toBe('true');
    await act(async () =>
      view.host.querySelector<HTMLButtonElement>('.session-card-main')?.click(),
    );
    expect(view.onOpen).toHaveBeenCalledOnce();
    expect(view.onLaunch).not.toHaveBeenCalled();
  });
});
