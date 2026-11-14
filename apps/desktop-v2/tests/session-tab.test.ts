// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { Session } from '../src/model';
import { sessionTitle } from '../src/model';
import { SessionTab } from '../src/SessionTab';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const base: Session = {
  id: 's1',
  projectId: 'p1',
  title: 'Refactor the session registry so every conversation has a meaningful name',
  kind: 'agent',
  workdir: '/repo',
  status: 'running',
  createdAt: 0,
  updatedAt: 0,
  exitCode: null,
  error: null,
};

function mount(session: Session, props: Partial<Parameters<typeof SessionTab>[0]> = {}) {
  const host = document.createElement('div');
  document.body.append(host);
  const onRename = vi.fn();
  const onOpen = vi.fn();
  act(() =>
    createRoot(host).render(
      createElement(SessionTab, {
        session,
        active: true,
        onOpen,
        onClose: vi.fn(),
        onRename,
        ...props,
      }),
    ),
  );
  return { host, onRename, onOpen };
}

describe('a session tab', () => {
  it('shows the session name, whole in its tooltip', () => {
    const { host } = mount(base);
    expect(host.querySelector('.session-tab-title')?.textContent).toBe(base.title);
    expect(host.querySelector('.session-tab-label')?.getAttribute('title')).toContain(base.title);
  });

  it('shows a placeholder until the first prompt names the conversation', () => {
    const { host } = mount({ ...base, title: 'New conversation', untitled: true });
    const title = host.querySelector('.session-tab-title');
    expect(title?.textContent).toBe('New conversation');
    expect(title?.classList.contains('untitled')).toBe(true);
    expect(sessionTitle({ title: 'Agent session', untitled: true }, 'Yeni konuşma')).toBe(
      'Yeni konuşma',
    );
    expect(sessionTitle({ title: 'Named' }, 'Yeni konuşma')).toBe('Named');
  });

  it('names a session from another project in its tooltip', () => {
    const { host } = mount(base, { projectName: 'other-repo' });
    expect(host.querySelector('small')?.textContent).toBe('other-repo');
    expect(host.querySelector('.session-tab-label')?.getAttribute('title')).toContain(
      `other-repo / ${base.title}`,
    );
  });

  it('renames in place on double-click; Enter saves, Escape cancels', () => {
    const { host, onRename } = mount(base);
    const label = host.querySelector<HTMLButtonElement>('.session-tab-label')!;
    act(() => label.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    const input = host.querySelector<HTMLInputElement>('.session-tab-rename')!;
    expect(input.value).toBe(base.title);
    const type = (value: string) =>
      act(() => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    type('  Short name  ');
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(onRename).toHaveBeenCalledWith('Short name');
    expect(host.querySelector('.session-tab-rename')).toBeNull();

    // Editing replaced the label: find the new one.
    const shown = host.querySelector<HTMLButtonElement>('.session-tab-label')!;
    act(() => shown.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    const again = host.querySelector<HTMLInputElement>('.session-tab-rename')!;
    act(() => again.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(host.querySelector('.session-tab-rename')).toBeNull();
    expect(onRename).toHaveBeenCalledTimes(1);
  });

  it('does not rename to an empty or unchanged name', () => {
    const { host, onRename } = mount(base);
    const label = host.querySelector<HTMLButtonElement>('.session-tab-label')!;
    act(() => label.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true })));
    const input = host.querySelector<HTMLInputElement>('.session-tab-rename')!;
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(onRename).not.toHaveBeenCalled();
  });
});
