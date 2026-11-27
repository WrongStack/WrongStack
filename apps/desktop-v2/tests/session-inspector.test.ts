// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EngineCommand } from '../src/engine-operations';
import { type EngineState, emptyEngineState, reduceEngine } from '../src/engine-state';
import { SessionInspector } from '../src/SessionInspector';
import { surfaceI18n } from '../src/surface-i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const roots: Array<ReturnType<typeof createRoot>> = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  localStorage.clear();
  await surfaceI18n.changeLanguage('en');
});
const initial: EngineState = {
  ...emptyEngineState,
  sessionId: 'session-a',
  provider: 'fixture-provider',
  model: 'fixture-model',
  connected: true,
};
async function mount(state = initial, command = vi.fn<EngineCommand>(async () => ({}))) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  const render = (value: EngineState) =>
    act(async () =>
      root.render(
        createElement(SessionInspector, {
          key: value.sessionId,
          state: value,
          command,
          onLink: () => {},
        }),
      ),
    );
  await render(state);
  const tabs = () => Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
  const select = (index: number) => act(async () => tabs()[index]?.click());
  const toggle = () =>
    act(async () => host.querySelector<HTMLButtonElement>('.session-inspector-toggle')?.click());
  const visiblePanel = () => host.querySelector<HTMLElement>('[role="tabpanel"]:not([hidden])');
  return { host, render, tabs, select, toggle, visiblePanel, command };
}

describe('session inspector', () => {
  it('provides linked tabs, automatic arrow navigation, and a labelled collapse control', async () => {
    const view = await mount();
    expect(view.tabs().map((tab) => tab.textContent)).toEqual([
      'Agents',
      'Plan',
      'Companions',
      'Details',
    ]);
    for (const tab of view.tabs()) {
      const panel = document.getElementById(tab.getAttribute('aria-controls') ?? '');
      expect(panel?.getAttribute('aria-labelledby')).toBe(tab.id);
    }
    view.tabs()[0]?.focus();
    const key = async (key: string) =>
      act(async () =>
        document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })),
      );
    await key('ArrowRight');
    expect(document.activeElement).toBe(view.tabs()[1]);
    expect(view.tabs()[1]?.getAttribute('aria-selected')).toBe('true');
    expect(view.visiblePanel()?.textContent).toContain('No plan yet');
    await key('End');
    expect(document.activeElement).toBe(view.tabs()[3]);
    expect(view.visiblePanel()?.textContent).toContain('fixture-provider');
    expect(view.visiblePanel()?.textContent).toContain('fixture-model');
    await key('ArrowRight');
    expect(document.activeElement).toBe(view.tabs()[0]);
    await key('ArrowLeft');
    expect(document.activeElement).toBe(view.tabs()[3]);
    await key('Home');
    expect(document.activeElement).toBe(view.tabs()[0]);
    await view.toggle();
    expect(
      view.host.querySelector('[aria-label="Expand session panel"]')?.getAttribute('aria-expanded'),
    ).toBe('false');
    expect(view.host.querySelector<HTMLElement>('.session-inspector-body')?.hidden).toBe(true);
    await view.toggle();
    expect(view.tabs()[0]?.getAttribute('aria-selected')).toBe('true');
  });

  it('preserves selected worker and mounted transcript across tabs and collapse, but resets for a new session', async () => {
    const state = reduceEngine(initial, {
      type: 'agent.timeline.message',
      payload: {
        sessionId: initial.sessionId,
        subagentId: 'ada',
        agentName: 'Ada',
        kind: 'text',
        content: 'Verified worker output',
        iteration: 1,
      },
    });
    const view = await mount(state);
    await act(async () =>
      view.host.querySelectorAll<HTMLButtonElement>('.agent-tabs button')[1]?.click(),
    );
    const transcript = view.host.querySelector('.agent-transcript');
    expect(transcript?.textContent).toContain('Verified worker output');
    await view.select(1);
    await view.toggle();
    await view.toggle();
    await view.select(0);
    expect(view.host.querySelector('.agent-transcript')).toBe(transcript);
    expect(view.host.querySelectorAll('.agent-tabs button')[1]?.getAttribute('aria-pressed')).toBe(
      'true',
    );
    await view.render({ ...initial, sessionId: 'session-b' });
    expect(view.host.querySelector('.agent-transcript')).toBeNull();
    expect(view.command.mock.calls.every(([type]) => type === 'todos.get')).toBe(true);
  });

  it('renders real todo events live, with existing edit contracts and managed-task isolation', async () => {
    const view = await mount();
    await view.select(1);
    const todos = [{ id: 'first', content: 'Inspect session layout 検証', status: 'in_progress' }];
    const state = reduceEngine(initial, { type: 'todos.updated', payload: { todos } });
    await view.render(state);
    expect(view.visiblePanel()?.textContent).toContain(todos[0]?.content);
    expect(view.visiblePanel()?.querySelector('details')?.open).toBe(true);
    const select = view.visiblePanel()?.querySelector('select');
    expect(select?.value).toBe('in_progress');
    await act(async () => {
      if (!select) throw new Error('Missing status control');
      select.value = 'completed';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(view.command).toHaveBeenCalledWith('todo.update', { id: 'first', status: 'completed' }, [
      'key.operation_result',
    ]);
    const managed = reduceEngine(state, {
      type: 'todos.updated',
      payload: {
        todos: [{ ...todos[0], kanbanBoardId: 'board', kanbanTaskId: 'task', status: 'completed' }],
      },
    });
    await view.render(managed);
    expect(view.visiblePanel()?.querySelector('select')).toBeNull();
    expect(view.visiblePanel()?.textContent).toContain('Kanban');
  });

  it('shows loading, a failed request with retry, and recovery without hiding failure', async () => {
    let rejectRequest: (error: Error) => void = () => {
      throw new Error('Request not started');
    };
    const pending = new Promise<Record<string, unknown>>((_, reject) => {
      rejectRequest = reject;
    });
    const command = vi.fn<EngineCommand>(async () => ({})).mockReturnValueOnce(pending);
    const view = await mount(initial, command);
    await view.select(1);
    expect(view.visiblePanel()?.querySelector('[role="status"]')?.textContent).not.toContain(
      'No plan yet',
    );
    await act(async () => rejectRequest(new Error('Fixture disconnected')));
    expect(view.visiblePanel()?.querySelector('[role="alert"]')?.textContent).toContain(
      'Fixture disconnected',
    );
    await act(async () => view.visiblePanel()?.querySelector<HTMLButtonElement>('button')?.click());
    expect(command).toHaveBeenCalledTimes(2);
    expect(view.visiblePanel()?.textContent).toContain('No plan yet');
    expect(view.visiblePanel()?.querySelector('[role="alert"]')).toBeNull();
  });

  it('opens companions from the collapsed rail and confirms changes through profile preferences', async () => {
    const prefs = {
      memoryCompanionEnabled: true,
      exploreCompanionEnabled: false,
      skillCompanionEnabled: true,
    };
    const command = vi.fn<EngineCommand>(async (type, payload) => {
      if (type === 'prefs.update') Object.assign(prefs, payload);
      return type === 'prefs.get' ? { ...prefs } : {};
    });
    const view = await mount(initial, command);
    expect(command).not.toHaveBeenCalledWith('prefs.get', {}, ['prefs.updated']);
    await view.toggle();
    await view.select(2);
    const panel = view.visiblePanel();
    expect(panel?.closest<HTMLElement>('.session-inspector')?.dataset.collapsed).toBe('false');
    expect(panel?.querySelectorAll('input[type="checkbox"]')).toHaveLength(4);
    const memory = panel?.querySelector<HTMLInputElement>('[aria-label="Memory Companion"]');
    expect(memory?.checked).toBe(true);
    command.mockRejectedValueOnce(new Error('Could not save profile'));
    await act(async () => memory?.click());
    expect(memory?.checked).toBe(true);
    expect(panel?.querySelector('[role="alert"]')?.textContent).toContain('Could not save profile');
    await act(async () => memory?.click());
    expect(command).toHaveBeenCalledWith('prefs.update', { memoryCompanionEnabled: false }, [
      'key.operation_result',
    ]);
    expect(memory?.checked).toBe(false);
    expect(panel?.querySelector('[role="alert"]')).toBeNull();
  });

  it('uses localized chrome', async () => {
    await surfaceI18n.changeLanguage('tr');
    const view = await mount();
    expect(view.tabs().map((tab) => tab.textContent)).toEqual([
      'Ajanlar',
      'Plan',
      'Yardımcı ajanlar',
      'Ayrıntılar',
    ]);
    expect(view.host.querySelector('.session-inspector-heading h2')?.textContent).toBe('Ajanlar');
    expect(view.host.querySelector('.session-inspector')?.getAttribute('aria-label')).toBe(
      'Oturum paneli',
    );
  });

  it('keeps the icon rail visible when collapsed and opens the sidebar from any icon', async () => {
    const view = await mount();
    const rail = view.host.querySelector('.session-inspector-rail');
    expect(rail).not.toBeNull();
    expect(rail?.querySelectorAll('[role="tab"]').length).toBe(4);
    expect(view.host.querySelector('.session-inspector-heading h2')?.textContent).toBe('Agents');
    await view.toggle();
    expect(view.host.querySelector<HTMLElement>('.session-inspector')?.dataset.collapsed).toBe(
      'true',
    );
    expect(view.tabs().length).toBe(4);
    await view.select(1);
    expect(view.host.querySelector<HTMLElement>('.session-inspector')?.dataset.collapsed).toBe(
      'false',
    );
    expect(view.tabs()[1]?.getAttribute('aria-selected')).toBe('true');
    expect(view.visiblePanel()?.textContent).toContain('No plan yet');
  });
});
