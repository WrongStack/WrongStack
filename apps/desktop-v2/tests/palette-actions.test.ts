// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { PaletteActions } from '../src/PaletteActions';
import type { DesktopController } from '../src/useDesktop';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function controller(project: string | null = 'p1') {
  return {
    project,
    snapshot: { projects: project ? [{ id: project }] : [] },
    mode: 'light',
    appearance: { mode: 'system', accent: 'blue-navy', contrast: 'system' },
    changeAppearance: vi.fn(),
    newSession: vi.fn(),
    openProjectPage: vi.fn(),
    openWrongStackSettings: vi.fn(),
    setDialog: vi.fn(),
    setSearch: vi.fn(),
  };
}

function render(vm: ReturnType<typeof controller>, search: string) {
  const host = document.createElement('div');
  const root = createRoot(host);
  act(() =>
    root.render(createElement(PaletteActions, { vm: vm as unknown as DesktopController, search })),
  );
  return host;
}

describe('palette actions', () => {
  it('lists a few actions with nothing typed and searches all of them', () => {
    const vm = controller();
    const idle = render(vm, '');
    expect(idle.querySelectorAll('button')).toHaveLength(6);
    expect(idle.textContent).toContain('Start a new agent session');
    const found = render(vm, 'kanban');
    expect(found.textContent).toContain('/kanban');
    expect(render(vm, 'no such action').textContent).toBe('');
  });

  it('closes the palette, then runs the action', () => {
    const vm = controller();
    const host = render(vm, '/office');
    act(() => host.querySelector('button')?.click());
    expect(vm.setDialog).toHaveBeenCalledWith(null);
    expect(vm.openProjectPage).toHaveBeenCalledWith('p1', 'office');
    const theme = render(vm, 'dark mode');
    act(() => theme.querySelector('button')?.click());
    expect(vm.changeAppearance).toHaveBeenCalledWith({ mode: 'dark' });
  });

  it('offers no project pages or sessions without a project', () => {
    const host = render(controller(null), '');
    expect(host.textContent).not.toContain('Start a new agent session');
    expect(host.textContent).toContain('Open WrongStack settings');
  });
});
