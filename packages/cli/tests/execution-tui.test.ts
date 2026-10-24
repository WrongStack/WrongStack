import { EventBus } from '@wrongstack/contracts/kernel';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecuteDeps } from '../src/execute-deps.js';
import { type ExecutionTuiLocals, runExecutionTui } from '../src/execution-tui.js';

// The terminal renderer is the boundary: all option construction and cleanup run for real.
const terminal = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../src/boot/dispatch-tui.js', () => ({ runTuiDispatch: terminal.run }));

beforeEach(() => {
  terminal.run.mockReset();
});

function fixture() {
  const events = new EventBus();
  const context = { model: 'model', provider: { id: 'provider' }, meta: {} };
  const config = {
    provider: 'provider',
    model: 'model',
    features: { autonomousCoordination: false },
  };
  const agent = {
    ctx: context,
    disableInteractiveConfirmation: vi.fn(),
    tools: { list: () => [] },
  };
  const renderer = { setTuiActive: vi.fn() };
  const deps = {
    core: { agent, events, config, configStore: { get: () => config }, flags: {} },
    session: { session: { id: 'boot' }, context, attachments: { clear: async () => {} } },
    provider: {},
    ui: { renderer },
    fleet: {},
    controllers: {},
  } as unknown as ExecuteDeps;
  const local = {
    wpaths: { projectSessions: 'sessions', profileConfig: () => 'profile.json' },
    projectRoot: 'project',
    profileName: 'default',
    setCoordinatorStop: vi.fn(),
  } as unknown as ExecutionTuiLocals;
  return { deps, local, renderer, agent, events };
}

describe('interactive execution host', () => {
  it('wires session identity and clears restored transcript state before returning the terminal exit code', async () => {
    const { deps, local, renderer, agent } = fixture();
    terminal.run.mockImplementation(async (options) => {
      expect(options.sessionsDir).toBe('sessions');
      expect(options.getSessionId()).toBe('boot');
      const dispatch = vi.fn();
      options.onClearHistory(dispatch);
      expect(dispatch.mock.calls.map(([action]) => action)).toEqual([
        {
          type: 'clearHistory',
          model: 'model',
          provider: 'provider',
          restoredMessages: null,
          restoredToolCalls: null,
          restoredEvents: null,
        },
        { type: 'resetContextChip' },
        { type: 'streamReset' },
        { type: 'toolStreamClear' },
      ]);
      return 7;
    });
    await expect(runExecutionTui(deps, local)).resolves.toEqual({ code: 7 });
    expect(agent.disableInteractiveConfirmation).toHaveBeenCalledOnce();
    expect(renderer.setTuiActive.mock.calls).toEqual([[true], [false]]);
  });

  it('deactivates the renderer and releases auto-wake listeners when terminal rendering fails', async () => {
    const { deps, local, renderer, events } = fixture();
    const initialListeners = events.listenerCount();
    const error = new Error('terminal closed');
    terminal.run.mockRejectedValue(error);
    await expect(runExecutionTui(deps, local)).rejects.toBe(error);
    expect(renderer.setTuiActive.mock.calls).toEqual([[true], [false]]);
    expect(events.listenerCount()).toBe(initialListeners);
  });
});
