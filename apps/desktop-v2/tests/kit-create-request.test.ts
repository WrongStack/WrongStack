// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { KitCreateRequest } from '../src/KitCreateRequest';
import type { Session } from '../src/model';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const agent = { id: 's1', kind: 'agent', title: 'Release work', status: 'idle' } as Session;
const terminal = { id: 't1', kind: 'terminal', title: 'Shell', status: 'idle' } as Session;

function mount(sessions: Session[], onPrepare = vi.fn(async () => true)) {
  const onNewSession = vi.fn();
  const host = document.createElement('div');
  act(() =>
    createRoot(host).render(
      createElement(KitCreateRequest, {
        projectRoot: 'D:/work/app',
        sessions,
        onPrepare,
        onNewSession,
        onClose: vi.fn(),
      }),
    ),
  );
  return { host, onPrepare, onNewSession };
}

function edit(element: HTMLTextAreaElement | HTMLSelectElement, value: string) {
  act(() => {
    if (element instanceof HTMLTextAreaElement) {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
        element,
        value,
      );
      element.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      element.value = value;
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
}

describe('create a Project Kit from the kit page', () => {
  it('puts the WebUI instruction with the capability into the chosen conversation draft', async () => {
    const { host, onPrepare } = mount([agent, terminal]);
    const add = () =>
      [...host.querySelectorAll('button')].find(
        (button) => button.textContent === 'Add to conversation draft',
      ) as HTMLButtonElement;
    expect(add().disabled).toBe(true);
    const select = host.querySelector('select') as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toEqual(['', 's1']);
    edit(host.querySelector('textarea') as HTMLTextAreaElement, 'release notes from merged PRs');
    edit(select, 's1');
    await act(async () => add().click());
    expect(onPrepare).toHaveBeenCalledWith(
      's1',
      expect.stringMatching(
        /^Create a reusable Project Kit capability for this project \(D:\/work\/app\)\. First discover existing kits with project_kit.*The capability I need is: release notes from merged PRs$/,
      ),
    );
    expect(host.querySelector('[role="status"]')?.textContent).toContain('Review and send it');
  });

  it('offers to start a conversation when the project has none', () => {
    const { host, onNewSession } = mount([terminal]);
    const create = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === 'Create a project conversation',
    );
    act(() => create?.click());
    expect(onNewSession).toHaveBeenCalled();
  });
});
