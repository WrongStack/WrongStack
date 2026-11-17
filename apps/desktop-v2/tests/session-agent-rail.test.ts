// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionAgentRail } from '../src/AgentTranscripts';
import { isInactiveAgent } from '../src/agent-cleanup';
import { type EngineState, emptyEngineState, reduceEngine } from '../src/engine-state';
import { surfaceI18n } from '../src/surface-i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const roots: Array<ReturnType<typeof createRoot>> = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
  localStorage.clear();
  await surfaceI18n.changeLanguage('en');
});
const worker = (id: string, content: string) => ({
  type: 'agent.timeline.message',
  payload: {
    sessionId: 's',
    subagentId: id,
    agentName: id,
    iteration: 1,
    ts: '2026-11-17',
    kind: 'text',
    content,
  },
});
function fixture() {
  let state: EngineState = {
    ...emptyEngineState,
    sessionId: 's',
    connected: true,
    hydrating: false,
  };
  state = reduceEngine(state, worker('Ada', 'Audit result **verified**.'));
  state = reduceEngine(state, worker('Bob', 'Tests passed.'));
  state = reduceEngine(state, {
    ...worker('Foreign', 'Private foreign work'),
    payload: {
      ...worker('Foreign', '').payload,
      sessionId: 'another',
      content: 'Private foreign work',
    },
  });
  return state;
}
async function mount(state = fixture()) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  const render = async (value: EngineState) =>
    act(async () =>
      root.render(createElement(SessionAgentRail, { state: value, onLink: () => {} })),
    );
  await render(state);
  const buttons = () => Array.from(host.querySelectorAll<HTMLButtonElement>('nav button'));
  const click = async (index: number) => act(async () => buttons()[index]?.click());
  return { host, render, buttons, click };
}

describe('session agent rail', () => {
  it('inspects one worker without sending anything and returns to the leader', async () => {
    const view = await mount();
    expect(view.buttons()).toHaveLength(3);
    expect(view.buttons()[0]?.textContent).toContain('Leader');
    expect(view.host.textContent).not.toContain('Foreign');
    await view.click(1);
    expect(
      view.host.querySelector('section[aria-label="Ada transcript"] strong')?.textContent,
    ).toBe('verified');
    expect(view.host.textContent).toContain(
      "Read only: what you send goes to the conversation's leader.",
    );
    expect(view.host.querySelector('textarea')).toBeNull();
    expect(view.buttons()[1]?.getAttribute('aria-pressed')).toBe('true');
    await view.click(2);
    expect(view.host.querySelector('section')?.getAttribute('aria-label')).toBe('Bob transcript');
    await act(async () =>
      view.host.querySelector<HTMLButtonElement>('[aria-label="Close agent transcript"]')?.click(),
    );
    expect(view.host.querySelector('section')).toBeNull();
    expect(view.buttons()[0]?.getAttribute('aria-pressed')).toBe('true');
  });

  it('supports vertical keyboard traversal without stealing focus or changing selection', async () => {
    const view = await mount();
    view.buttons()[0]?.focus();
    const key = async (value: string) =>
      act(async () =>
        document.activeElement?.dispatchEvent(
          new KeyboardEvent('keydown', { key: value, bubbles: true }),
        ),
      );
    await key('ArrowDown');
    expect(document.activeElement).toBe(view.buttons()[1]);
    expect(view.buttons()[0]?.getAttribute('aria-pressed')).toBe('true');
    await key('End');
    expect(document.activeElement).toBe(view.buttons()[2]);
    await key('ArrowUp');
    expect(document.activeElement).toBe(view.buttons()[1]);
    await key('Home');
    expect(document.activeElement).toBe(view.buttons()[0]);
  });

  it('drops a stale selection on session switch or agent removal', async () => {
    const state = fixture();
    const view = await mount(state);
    await view.click(1);
    await view.render({ ...state, sessionId: 'other' });
    expect(view.host.querySelector('section')).toBeNull();
    await view.render(state);
    await view.click(1);
    await view.render({ ...state, agents: {} });
    expect(view.host.querySelector('section')).toBeNull();
    expect(view.buttons()).toHaveLength(1);
  });

  it('retains every agent, live preview and error state, including workers without messages', async () => {
    let state = fixture();
    for (let index = 0; index < 30; index++)
      state = reduceEngine(state, worker(`Worker ${index}`, `Result ${index}`));
    state = reduceEngine(state, {
      type: 'agent.status_changed',
      payload: {
        sessionId: 's',
        subagentId: 'Empty',
        agentName: 'Empty',
        status: 'failed',
        task: 'Inspect a boundary',
      },
    });
    const view = await mount(state);
    expect(view.buttons()).toHaveLength(34);
    expect(view.host.textContent).toContain('Result 29');
    await view.click(33);
    expect(view.host.querySelector('section')?.textContent).toContain('Failed');
    expect(view.host.querySelector('section')?.textContent).toContain('Inspect a boundary');
  });

  it('clears only inactive workers, preserves history, and lets the user undo', async () => {
    let state = fixture();
    state = reduceEngine(state, {
      type: 'agent.status_changed',
      payload: { sessionId: 's', subagentId: 'Ada', status: 'completed' },
    });
    const view = await mount(state);
    await view.click(1);
    const clear = Array.from(view.host.querySelectorAll('button')).find((button) =>
      button.textContent?.startsWith('Clear inactive'),
    );
    expect(clear, 'Inactive-worker cleanup must be available').toBeDefined();
    await act(async () => clear?.click());
    expect(view.buttons()).toHaveLength(2);
    expect(view.buttons()[1]?.textContent).toContain('Bob');
    expect(view.host.querySelector('section')).toBeNull();
    expect(
      state.agents['Ada']?.entries.some((entry) => entry.content.includes('Audit result')),
    ).toBe(true);
    const undo = Array.from(view.host.querySelectorAll('button')).find((button) =>
      button.textContent?.startsWith('Undo cleanup'),
    );
    expect(undo).toBeDefined();
    await act(async () => undo?.click());
    expect(view.buttons()).toHaveLength(3);
  });

  it('keeps cleaned workers out after remount, isolates sessions, and reveals new work', async () => {
    let state = fixture();
    state = reduceEngine(state, {
      type: 'agent.status_changed',
      payload: { sessionId: 's', subagentId: 'Ada', status: 'failed' },
    });
    const view = await mount(state);
    const clear = Array.from(view.host.querySelectorAll('button')).find((button) =>
      button.textContent?.startsWith('Clear inactive'),
    );
    expect(clear).toBeDefined();
    await act(async () => clear?.click());
    const reopened = await mount(state);
    expect(reopened.buttons()).toHaveLength(2);
    await reopened.render({ ...state, sessionId: 'another' });
    expect(reopened.buttons()).toHaveLength(3);
    const restarted = reduceEngine(state, {
      type: 'agent.status_changed',
      payload: { sessionId: 's', subagentId: 'Ada', status: 'running' },
    });
    await reopened.render(restarted);
    expect(reopened.buttons()).toHaveLength(3);
    const newResult = reduceEngine(restarted, worker('Ada', 'New attempt result'));
    const finished = reduceEngine(newResult, {
      type: 'agent.status_changed',
      payload: { sessionId: 's', subagentId: 'Ada', status: 'completed' },
    });
    await reopened.render(finished);
    expect(reopened.buttons()).toHaveLength(3);
  });

  it('does not allow cleanup while replay is loading or for active and unknown states', async () => {
    const state = fixture();
    const view = await mount(state);
    const clear = () =>
      Array.from(view.host.querySelectorAll('button')).find((button) =>
        button.textContent?.startsWith('Clear inactive'),
      );
    expect(clear()?.disabled).toBe(true);
    const finished = reduceEngine(state, {
      type: 'agent.status_changed',
      payload: { sessionId: 's', subagentId: 'Ada', status: 'stopped' },
    });
    await view.render({ ...finished, hydrating: true });
    expect(clear()?.disabled).toBe(true);
    const pending = reduceEngine(state, {
      type: 'agent.status_changed',
      payload: { sessionId: 's', subagentId: 'Ada', status: 'waiting' },
    });
    await view.render(pending);
    expect(clear()?.disabled).toBe(true);
  });

  it('recognizes only terminal worker statuses as safe to clean', () => {
    for (const status of ['completed', 'failed', 'timeout', 'stopped', 'cancelled']) {
      expect(isInactiveAgent({ id: 'worker', status })).toBe(true);
      expect(isInactiveAgent({ id: 'leader', status })).toBe(false);
    }
    for (const status of ['running', 'starting', 'waiting', 'idle', '', 'future-status'])
      expect(isInactiveAgent({ id: 'worker', status })).toBe(false);
  });

  it('reports storage failure without removing workers or their selected transcript', async () => {
    const state = reduceEngine(fixture(), {
      type: 'agent.status_changed',
      payload: { sessionId: 's', subagentId: 'Ada', status: 'completed' },
    });
    const view = await mount(state);
    await view.click(1);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    });
    const clear = Array.from(view.host.querySelectorAll('button')).find((button) =>
      button.textContent?.startsWith('Clear inactive'),
    );
    await act(async () => clear?.click());
    expect(view.buttons()).toHaveLength(3);
    expect(view.host.querySelector('section')?.getAttribute('aria-label')).toBe('Ada transcript');
    expect(view.host.querySelector('[role="alert"]')?.textContent).toContain(
      'Could not save agent cleanup',
    );
  });

  it('synchronizes cleanup and undo between views of the same session', async () => {
    const state = reduceEngine(fixture(), {
      type: 'agent.status_changed',
      payload: { sessionId: 's', subagentId: 'Ada', status: 'timeout' },
    });
    const first = await mount(state);
    const second = await mount(state);
    const clear = Array.from(first.host.querySelectorAll('button')).find((button) =>
      button.textContent?.startsWith('Clear inactive'),
    );
    await act(async () => clear?.click());
    expect(second.buttons()).toHaveLength(2);
    expect(localStorage.getItem('wrongstack.desktop.agent-cleanup:s')).not.toContain(
      'Audit result',
    );
    localStorage.removeItem('wrongstack.desktop.agent-cleanup:s');
    await act(async () =>
      window.dispatchEvent(
        new StorageEvent('storage', { key: 'wrongstack.desktop.agent-cleanup:s' }),
      ),
    );
    expect(first.buttons()).toHaveLength(3);
    expect(second.buttons()).toHaveLength(3);
  });

  it('uses the selected display language and shows replay loading', async () => {
    await surfaceI18n.changeLanguage('tr');
    const view = await mount({ ...emptyEngineState, hydrating: true });
    expect(view.host.textContent).toContain('Oturum ajanları');
    expect(view.buttons()[0]?.textContent).toContain('Lider');
    expect(view.host.querySelector('[role="status"]')?.textContent).not.toContain('chatView.');
  });
});
