// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { companionEnabled, KanbanCompanionSettings } from '../src/KanbanCompanionSettings';

const { journalTail, projectRequest } = vi.hoisted(() => ({
  journalTail: vi.fn(() => ({
    listen: vi.fn((_listener: (frame: StatusFrame) => void) => () => undefined),
  })),
  projectRequest: vi.fn(),
}));
vi.mock('../src/journal-tail', () => ({ journalTail, projectRequest }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type StatusReply = Record<string, unknown>;
type StatusFrame = { type: string; payload: StatusReply };

const deferred = () => {
  let resolve!: (value: StatusReply) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<StatusReply>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

async function boot(): Promise<{ host: HTMLDivElement; root: Root; close: () => void }> {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  return {
    host,
    root,
    close: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

const open = async (root: Root, projectId: string) => {
  await act(async () => {
    root.render(createElement(KanbanCompanionSettings, { projectId }));
  });
  await flush();
};

const checkbox = (host: HTMLDivElement) =>
  host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;

describe('the project-wide Kanban Companion switch', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('reads only replies that confirm a value', () => {
    expect(companionEnabled({ success: true, data: { enabled: true } })).toBe(true);
    expect(companionEnabled({ success: true, data: { enabled: false } })).toBe(false);
    expect(companionEnabled({ success: false, error: 'nope' })).toBeNull();
    expect(companionEnabled({ success: true })).toBeNull();
    expect(companionEnabled({ success: true, data: { enabled: 'yes' } })).toBeNull();
  });

  it('asks the project Kanban host and shows only the confirmed switch', async () => {
    projectRequest.mockReturnValueOnce(Promise.resolve({ success: true, data: { enabled: true } }));
    const { host, root, close } = await boot();
    try {
      await open(root, 'p1');
      expect(projectRequest).toHaveBeenCalledWith('p1', 'kanban.companion.get', {}, [
        'kanban.companion.status',
      ]);
      expect(journalTail).toHaveBeenCalledWith('p1');
      expect(checkbox(host).checked).toBe(true);
      expect(checkbox(host).disabled).toBe(false);
      expect(host.textContent).toContain('Enabled for this project');
    } finally {
      close();
    }
  });

  it('sends enabled and applies the server-confirmed value', async () => {
    projectRequest.mockReturnValueOnce(Promise.resolve({ success: true, data: { enabled: true } }));
    const { host, root, close } = await boot();
    try {
      await open(root, 'p1');
      projectRequest.mockReturnValueOnce(
        Promise.resolve({ success: true, data: { enabled: false } }),
      );
      await act(async () => checkbox(host).click());
      await flush();
      expect(projectRequest).toHaveBeenLastCalledWith(
        'p1',
        'kanban.companion.set',
        { enabled: false },
        ['kanban.companion.status'],
      );
      expect(checkbox(host).checked).toBe(false);
      expect(host.textContent).toContain('Disabled for this project');
    } finally {
      close();
    }
  });

  it('keeps the confirmed value on a failed switch and retries the read', async () => {
    projectRequest.mockReturnValueOnce(Promise.resolve({ success: true, data: { enabled: true } }));
    const { host, root, close } = await boot();
    try {
      await open(root, 'p1');
      projectRequest.mockReturnValueOnce(
        Promise.reject(new Error('The Kanban host refused the switch.')),
      );
      await act(async () => checkbox(host).click());
      await flush();
      expect(checkbox(host).checked).toBe(true);
      const alert = host.querySelector('[role="alert"]')!;
      expect(alert.textContent).toContain('The Kanban host refused the switch.');
      projectRequest.mockReturnValueOnce(
        Promise.resolve({ success: true, data: { enabled: false } }),
      );
      await act(async () => alert.querySelector<HTMLButtonElement>('button')!.click());
      await flush();
      expect(host.querySelector('[role="alert"]')).toBeNull();
      expect(checkbox(host).checked).toBe(false);
    } finally {
      close();
    }
  });

  it('asks nothing and stays off without a project', async () => {
    const { host, root, close } = await boot();
    try {
      await open(root, '');
      expect(projectRequest).not.toHaveBeenCalled();
      expect(journalTail).not.toHaveBeenCalled();
      expect(checkbox(host).disabled).toBe(true);
      expect(host.textContent).toContain('Open a project to manage its Kanban Companion.');
    } finally {
      close();
    }
  });

  it('does not land a late reply on the project the operator switched to', async () => {
    const stale = deferred();
    projectRequest.mockReturnValueOnce(stale.promise);
    const { host, root, close } = await boot();
    try {
      await open(root, 'p1');
      projectRequest.mockReturnValueOnce(
        Promise.resolve({ success: true, data: { enabled: false } }),
      );
      await open(root, 'p2');
      expect(projectRequest).toHaveBeenLastCalledWith('p2', 'kanban.companion.get', {}, [
        'kanban.companion.status',
      ]);
      expect(checkbox(host).checked).toBe(false);
      stale.resolve({ success: true, data: { enabled: true } });
      await flush();
      expect(checkbox(host).checked).toBe(false);
    } finally {
      close();
    }
  });

  it('converges on request-less broadcasts but not on other clients’ replies', async () => {
    let deliver!: (frame: StatusFrame) => void;
    journalTail.mockImplementationOnce(() => ({
      listen: vi.fn((listener: (frame: StatusFrame) => void) => {
        deliver = listener;
        return () => undefined;
      }),
    }));
    projectRequest.mockReturnValueOnce(Promise.resolve({ success: true, data: { enabled: true } }));
    const { host, root, close } = await boot();
    try {
      await open(root, 'p1');
      expect(checkbox(host).checked).toBe(true);
      act(() =>
        deliver({
          type: 'kanban.companion.status',
          payload: { success: true, data: { enabled: false } },
        }),
      );
      expect(checkbox(host).checked).toBe(false);
      act(() =>
        deliver({
          type: 'kanban.companion.status',
          payload: { success: true, data: { enabled: true }, requestId: 'other-client' },
        }),
      );
      expect(checkbox(host).checked).toBe(false);
    } finally {
      close();
    }
  });
});
