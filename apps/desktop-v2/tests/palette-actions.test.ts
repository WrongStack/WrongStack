// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { DesktopController } from '../src/useDesktop';
import { WorkspacePalette } from '../src/WorkspacePalette';

vi.mock('../src/Modal', () => ({
  Modal: ({ children }: { children: ReactNode }) => createElement('div', null, children),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function controller(project: string | null = 'p1') {
  return {
    project,
    snapshot: {
      projects: project
        ? [{ id: project, name: 'Sample Project', root: 'D:/fixture/project' }]
        : [],
      sessions: [],
    },
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
    root.render(
      createElement(WorkspacePalette, { vm: { ...vm, search } as unknown as DesktopController }),
    ),
  );
  return host;
}

describe('palette actions', () => {
  it('lists a few actions with nothing typed and searches all of them', () => {
    const vm = controller();
    const idle = render(vm, '');
    expect(
      idle.querySelectorAll('.workspace-palette-group:first-child [role="option"]'),
    ).toHaveLength(6);
    expect(idle.textContent).toContain('Start a new agent session');
    const found = render(vm, 'kanban');
    expect(found.textContent).toContain('Open the project task board');
    // The slash command still finds the page; the row shows its name, not the command.
    const bySlash = render(vm, '/kanban');
    expect(bySlash.textContent).toContain('Open the project task board');
    expect(bySlash.textContent).not.toContain('/kanban');
    expect(render(vm, 'no such action').querySelector('[role="status"]')?.textContent).toContain(
      'No matching commands',
    );
  });

  it('closes the palette, then runs the action', () => {
    const vm = controller();
    const host = render(vm, '/office');
    act(() => host.querySelector<HTMLButtonElement>('[role="option"]')?.click());
    expect(vm.setDialog).toHaveBeenCalledWith(null);
    expect(vm.openProjectPage).toHaveBeenCalledWith('p1', 'office');
    const theme = render(vm, 'dark mode');
    act(() => theme.querySelector<HTMLButtonElement>('[role="option"]')?.click());
    expect(vm.changeAppearance).toHaveBeenCalledWith({ mode: 'dark' });
  });

  it('offers no project pages or sessions without a project', () => {
    const host = render(controller(null), '');
    expect(host.textContent).not.toContain('Start a new agent session');
    expect(host.textContent).toContain('Open WrongStack settings');
  });

  it('opens a project result found by path in the same project workspace', () => {
    const vm = controller();
    const host = render(vm, 'D:/fixture/project');
    act(() => host.querySelector<HTMLButtonElement>('[role="option"]')?.click());
    expect(vm.openProjectPage).toHaveBeenCalledWith('p1');
    expect(vm.setSearch).toHaveBeenCalledWith('');
  });
});
