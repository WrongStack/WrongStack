// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { HistoryEmptyCleanup, HistorySelection } from '../src/HistorySelection';
import type { Session } from '../src/model';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const row = { id: 'core-1', name: 'Release notes', provider: 'zai', model: 'glm-5', startedAt: 1 };
const owner = { id: 'desk-1', kind: 'agent', title: 'Release notes', status: 'running' } as Session;

function selection(open?: Session) {
  const onDelete = vi.fn(async () => undefined);
  const onRestore = vi.fn();
  const host = document.createElement('div');
  act(() =>
    createRoot(host).render(
      createElement(HistorySelection, {
        row,
        selected: 'core-1',
        owner: open,
        busy: false,
        saving: false,
        onRename: vi.fn(),
        onOpen: vi.fn(),
        onRestore,
        onDelete,
      }),
    ),
  );
  const button = (text: string) =>
    [...host.querySelectorAll('button')].find((item) => item.textContent?.includes(text));
  return { host, onDelete, onRestore, button };
}

describe('deleting recorded sessions', () => {
  it('asks before deleting the selected recorded session', async () => {
    const { host, onDelete, button } = selection();
    act(() => button('Delete…')?.click());
    expect(host.textContent).toContain('This cannot be undone.');
    expect(onDelete).not.toHaveBeenCalled();
    await act(async () => button('Delete recorded session')?.click());
    expect(onDelete).toHaveBeenCalledWith(['core-1']);
  });

  it('can be kept after asking', () => {
    const { host, onDelete, button } = selection();
    act(() => button('Delete…')?.click());
    act(() => button('Keep')?.click());
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('offers no delete while an open desktop conversation owns the session', () => {
    const { button } = selection(owner);
    expect(button('Delete')).toBeUndefined();
    expect(button('Open desktop conversation')).toBeDefined();
  });

  it('keeps resume and copy as before', () => {
    const { onRestore, button } = selection();
    act(() => button('Resume recorded conversation')?.click());
    expect(onRestore).toHaveBeenCalledWith({
      id: 'core-1',
      title: 'Release notes',
      mode: 'resume',
    });
  });

  it('deletes the empty journals on the page after asking, and hides when there are none', async () => {
    const onDelete = vi.fn(async () => undefined);
    const host = document.createElement('div');
    const root = createRoot(host);
    act(() =>
      root.render(createElement(HistoryEmptyCleanup, { ids: ['a', 'b'], saving: false, onDelete })),
    );
    act(() => host.querySelector('button')?.click());
    expect(host.textContent).toContain('Delete 2 empty recorded sessions on this page?');
    await act(async () =>
      [...host.querySelectorAll('button')]
        .find((item) => item.textContent === 'Delete empty')
        ?.click(),
    );
    expect(onDelete).toHaveBeenCalledWith(['a', 'b']);
    act(() =>
      root.render(createElement(HistoryEmptyCleanup, { ids: [], saving: false, onDelete })),
    );
    expect(host.textContent).toBe('');
  });
});
