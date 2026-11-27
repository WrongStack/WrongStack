// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../src/model';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const calls = vi.hoisted(() => ({ requests: [] as Array<[string, unknown]>, fail: '' }));
const removal = vi.hoisted(() => ({ gate: undefined as Promise<void> | undefined }));
vi.mock('../src/platform', () => ({
  request: async (method: string, params: unknown) => {
    calls.requests.push([method, params]);
    if (calls.fail) throw new Error(calls.fail);
    if (method === 'session.remove') await removal.gate;
    return null;
  },
}));
// jsdom has no <dialog>; the row's question renders inline here.
vi.mock('../src/Modal', async () => {
  const { createElement: h } = await import('react');
  return {
    Modal: ({ children, title }: { children: unknown; title?: string }) =>
      h('div', { role: 'dialog', 'aria-label': title }, children as never),
  };
});

const { SidebarSessionRow } = await import('../src/SidebarSessionRow');

const session = (status: Session['status']): Session => ({
  id: 's1',
  projectId: 'p1',
  title: 'Refactor',
  kind: 'agent',
  workdir: '/p',
  status,
  createdAt: 1,
  updatedAt: 1,
  exitCode: null,
  error: null,
});

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
const click = (element: Element | null | undefined) =>
  act(async () => (element as HTMLElement).click());

async function mount(status: Session['status']) {
  const errors: unknown[] = [];
  const removed: string[] = [];
  const modes: boolean[] = [];
  const run = async (action: () => Promise<unknown>, options?: { background?: boolean }) => {
    modes.push(options?.background === true);
    try {
      await action();
    } catch (error) {
      errors.push(error);
    }
  };
  const host = document.createElement('div');
  document.body.append(host);
  await act(async () =>
    createRoot(host).render(
      createElement(SidebarSessionRow, {
        session: session(status),
        chosen: false,
        disabled: false,
        onOpen: () => undefined,
        run,
        onRemoved: (id: string) => removed.push(id),
      }),
    ),
  );
  const button = (name: string) => host.querySelector(`button[aria-label="${name}"]`);
  return { host, button, errors, removed, modes };
}

afterEach(() => {
  document.body.innerHTML = '';
  calls.requests = [];
  calls.fail = '';
  removal.gate = undefined;
});

describe('a session row in the sidebar', () => {
  it('marks only the target row busy until the host confirms removal', async () => {
    let finish!: () => void;
    removal.gate = new Promise((resolve) => {
      finish = resolve;
    });
    const { host, button, removed, modes } = await mount('running');
    await click(button('Remove Refactor'));
    await click(host.querySelector('[role="dialog"] .button.danger'));
    expect(modes).toEqual([true]);
    expect(removed).toEqual([]);
    expect(host.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect((button('Stop Refactor') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => finish());
    expect(removed).toEqual(['s1']);
    expect(host.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it('stops a running session', async () => {
    const { button } = await mount('running');
    await click(button('Stop Refactor'));
    await settle();
    expect(calls.requests).toEqual([['session.kill', { id: 's1' }]]);
  });

  it('offers no stop for a stopped session and removes one only after asking', async () => {
    const { host, button, removed } = await mount('stopped');
    expect(button('Stop Refactor')).toBeNull();
    await click(button('Remove Refactor'));
    expect(calls.requests).toEqual([]);
    const dialog = host.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute('aria-label')).toBe('Remove Refactor?');
    await click(dialog?.querySelector('.button.danger'));
    await settle();
    expect(calls.requests).toEqual([['session.remove', { id: 's1' }]]);
    expect(removed).toEqual(['s1']);
  });

  it('explains an older session host instead of its raw error', async () => {
    calls.fail = 'Unknown method: session.remove';
    const { host, button, errors, removed } = await mount('stopped');
    await click(button('Remove Refactor'));
    await click(host.querySelector('[role="dialog"] .button.danger'));
    await settle();
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain('older than this desktop');
    expect(removed).toEqual([]);
  });
});
