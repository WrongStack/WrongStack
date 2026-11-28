// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ProjectMenuController, SidebarProjects } from '../src/SidebarProjects';
import { surfaceI18n } from '../src/surface-i18n';

const bridge = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../src/platform', () => ({ native: true, request: bridge.request }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
let vm: ProjectMenuController;
let errors: unknown[];
const project = (id: string) => ({ id, name: id, root: `D:/projects/${id}`, createdAt: 1 });
const button = (label: string) => {
  const found = Array.from(host.querySelectorAll('button')).find(
    (b) =>
      b.getAttribute('aria-label') === label ||
      b.textContent === label ||
      (b.matches('.project-item') && b.lastElementChild?.textContent === label),
  );
  if (!found) throw Error(`Missing button ${label}`);
  return found;
};
const click = async (label: string) => act(async () => button(label).click());
const render = async () => act(async () => root.render(createElement(SidebarProjects, { vm })));
const transfer = () => {
  const values = new Map<string, string>();
  return {
    types: ['application/x-wrongstack-project'],
    setData: (type: string, value: string) => values.set(type, value),
    getData: (type: string) => values.get(type) ?? '',
    effectAllowed: '',
    dropEffect: '',
  };
};
async function drag(
  element: Element,
  type: string,
  dataTransfer: ReturnType<typeof transfer>,
  clientY = -1,
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    dataTransfer: { value: dataTransfer },
    clientY: { value: clientY },
  });
  await act(async () => {
    element.dispatchEvent(event);
  });
  return event;
}

beforeEach(async () => {
  await surfaceI18n.changeLanguage('en');
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.setAttribute('open', '');
      },
    },
    close: {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.removeAttribute('open');
      },
    },
  });
  bridge.request.mockReset().mockResolvedValue(null);
  errors = [];
  vm = {
    snapshot: {
      projects: ['Alpha', 'Beta', 'Gamma'].map(project),
      sessions: [],
      hostPid: 1,
      layout: null,
    },
    project: 'Alpha',
    selected: null,
    pending: false,
    openSessionIds: [],
    run: async (action) => {
      try {
        await action();
      } catch (error) {
        errors.push(error);
      }
    },
    openProjectPage: vi.fn(),
    newSession: vi.fn(),
    jumpToSession: vi.fn(),
    closeSessionTab: vi.fn(),
  };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await render();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe('sidebar project management', () => {
  it('keeps opening projects and starting sessions independent of management actions', async () => {
    await click('Beta');
    expect(vm.openProjectPage).toHaveBeenCalledWith('Beta');
    await click('New session in Alpha');
    expect(vm.newSession).toHaveBeenCalledWith('Alpha');
    expect(bridge.request).not.toHaveBeenCalled();
  });
  it('requires confirmation and cancel does not remove anything', async () => {
    await click('Remove project Alpha');
    expect(host.querySelector('dialog')?.textContent).toContain(
      'Files, history and drafts are kept',
    );
    expect(host.querySelector('dialog')?.textContent).toContain('Running sessions keep working');
    expect(bridge.request).not.toHaveBeenCalled();
    await click('Cancel');
    expect(host.querySelector('dialog')).toBeNull();
    expect(bridge.request).not.toHaveBeenCalled();
    await click('Remove project Beta');
    await click('Remove');
    expect(bridge.request).toHaveBeenCalledExactlyOnceWith('project-menu.remove', { id: 'Beta' });
    expect(host.querySelector('dialog')).toBeNull();
  });
  it('retains the confirmation and project on a storage error so removal can be retried', async () => {
    bridge.request.mockRejectedValueOnce(Error('Disk full'));
    await click('Remove project Alpha');
    await click('Remove');
    expect(errors.map(String)).toEqual(['Error: Disk full']);
    expect(host.querySelector('dialog')).not.toBeNull();
    expect(button('Alpha')).toBeDefined();
    await click('Remove');
    expect(host.querySelector('dialog')).toBeNull();
  });
  it('saves a drag only on drop, supports both insertion directions, and clears its cue', async () => {
    const data = transfer();
    await drag(button('Reorder Gamma'), 'dragstart', data);
    const hover = await drag(button('Alpha'), 'dragover', data);
    expect(hover.defaultPrevented).toBe(true);
    expect(button('Alpha').closest('.project-branch-heading')?.getAttribute('data-drop')).toBe(
      'before',
    );
    expect(bridge.request).not.toHaveBeenCalled();
    await drag(button('Alpha'), 'drop', data);
    expect(bridge.request).toHaveBeenLastCalledWith('project-menu.move', {
      id: 'Gamma',
      target: 'Alpha',
      after: false,
    });
    expect(
      button('Alpha').closest('.project-branch-heading')?.getAttribute('data-drop'),
    ).toBeNull();
    await drag(button('Reorder Alpha'), 'dragstart', data);
    await drag(button('Gamma'), 'drop', data, 1);
    expect(bridge.request).toHaveBeenLastCalledWith('project-menu.move', {
      id: 'Alpha',
      target: 'Gamma',
      after: true,
    });
  });
  it('ignores external, self and canceled drags and preserves the list on failed saves', async () => {
    const data = transfer();
    await drag(button('Beta'), 'drop', data);
    await drag(button('Reorder Alpha'), 'dragstart', data);
    await drag(button('Alpha'), 'drop', data);
    await drag(button('Reorder Gamma'), 'dragstart', data);
    await drag(button('Reorder Gamma'), 'dragend', data);
    await drag(button('Beta'), 'drop', data);
    expect(bridge.request).not.toHaveBeenCalled();
    bridge.request.mockRejectedValueOnce(Error('Write failed'));
    await drag(button('Reorder Alpha'), 'dragstart', data);
    await drag(button('Beta'), 'drop', data);
    expect(errors.map(String)).toEqual(['Error: Write failed']);
    expect(Array.from(host.querySelectorAll('.project-item')).map((b) => b.textContent)).toEqual([
      'Alpha',
      'Beta',
      'Gamma',
    ]);
  });
  it('supports keyboard reordering, honors boundaries, and disables changes while saving', async () => {
    const key = async (name: string, key: string) =>
      act(async () =>
        button(name).dispatchEvent(
          new KeyboardEvent('keydown', { key, altKey: true, bubbles: true }),
        ),
      );
    await key('Reorder Alpha', 'ArrowUp');
    await key('Reorder Gamma', 'ArrowDown');
    expect(bridge.request).not.toHaveBeenCalled();
    button('Reorder Beta').focus();
    await key('Reorder Beta', 'ArrowUp');
    expect(bridge.request).toHaveBeenLastCalledWith('project-menu.move', {
      id: 'Beta',
      target: 'Alpha',
      after: false,
    });
    expect(document.activeElement).toBe(button('Reorder Beta'));
    await key('Reorder Beta', 'ArrowDown');
    expect(bridge.request).toHaveBeenLastCalledWith('project-menu.move', {
      id: 'Beta',
      target: 'Gamma',
      after: true,
    });
    vm = { ...vm, pending: true };
    await render();
    expect(button('Reorder Beta').getAttribute('aria-disabled')).toBe('true');
    bridge.request.mockClear();
    await key('Reorder Beta', 'ArrowDown');
    await click('Reorder Beta');
    expect(bridge.request).not.toHaveBeenCalled();
    expect(host.querySelector('dialog')).toBeNull();
    expect(button('Remove project Beta').disabled).toBe(true);
  });
  it('localizes the new management controls with the shell display language', async () => {
    await act(async () => surfaceI18n.changeLanguage('tr'));
    expect(button('Alpha sırasını değiştir')).toBeDefined();
    expect(button('Alpha projesini kaldır')).toBeDefined();
  });
});
