// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { type EngineState, emptyEngineState, reduceEngine } from '../src/engine-state';
import { ProviderWaitingRoom } from '../src/ProviderWaitingRoom';
import { reduceWaitingRoom, siblingTrigger, waitRemaining } from '../src/provider-waiting';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const blocked = {
  providerId: 'zai',
  model: 'glm-5',
  oldState: 'healthy',
  newState: 'blocked',
  reason: 'rate_limit',
  timestamp: 1000,
  stateExpiresAt: 61_000,
  lastErrorStatus: 429,
  lastErrorMessage: 'Too many requests',
};

describe('waiting room frames', () => {
  it('moves a pair in on a block and out when it recovers', () => {
    const room = reduceWaitingRoom({}, 'provider.status_changed', blocked);
    expect(Object.values(room)).toEqual([
      expect.objectContaining({
        providerId: 'zai',
        model: 'glm-5',
        state: 'blocked',
        reason: 'rate_limit',
        stateExpiresAt: 61_000,
        lastErrorStatus: 429,
      }),
    ]);
    const recovered = reduceWaitingRoom(room, 'provider.status_changed', {
      ...blocked,
      oldState: 'blocked',
      newState: 'healthy',
    });
    expect(recovered).toEqual({});
  });

  it('keeps what a snapshot said when a later change omits it', () => {
    const snapshot = reduceWaitingRoom({}, 'provider.status.snapshot', {
      statuses: [
        {
          providerId: 'zai',
          model: 'glm-5',
          state: 'degraded',
          lastErrorKind: 'server_error',
          totalFailures: 4,
          recentErrors: [{ timestamp: 5, kind: 'server_error', status: 500, message: 'boom' }],
        },
        { providerId: 'openai', model: 'gpt-5', state: 'healthy' },
      ],
    });
    expect(Object.keys(snapshot)).toHaveLength(1);
    const next = reduceWaitingRoom(snapshot, 'provider.status_changed', {
      providerId: 'zai',
      model: 'glm-5',
      newState: 'blocked',
      reason: 'quota',
      lastErrorStatus: null,
    });
    expect(Object.values(next)[0]).toMatchObject({
      state: 'blocked',
      reason: 'quota',
      totalFailures: 4,
      recentErrors: [expect.objectContaining({ status: 500 })],
    });
  });

  it('replaces the room with a snapshot and ignores an error reply', () => {
    const room = reduceWaitingRoom({}, 'provider.status_changed', blocked);
    expect(reduceWaitingRoom(room, 'provider.status.snapshot', { error: 'off' })).toBe(room);
    expect(reduceWaitingRoom(room, 'provider.status.snapshot', { statuses: [] })).toEqual({});
    expect(reduceWaitingRoom(room, 'run.result', {})).toBe(room);
  });

  it('is folded into the conversation state and survives a reset', () => {
    let state = reduceEngine(emptyEngineState, {
      type: 'provider.status_changed',
      payload: blocked,
    });
    state = reduceEngine(state, { type: 'session.start', payload: { reset: true } });
    expect(Object.keys(state.waiting)).toHaveLength(1);
  });

  it('words the wait and names the sibling that tripped a quarantine', () => {
    expect(waitRemaining(undefined, 0)).toBe('reset time unknown');
    expect(waitRemaining(1000, 2000)).toBe('rechecking now');
    expect(waitRemaining(46_000, 1000)).toBe('45s');
    expect(waitRemaining(3_725_000, 0)).toBe('1h 2m');
    expect(
      siblingTrigger({ lastErrorMessage: 'Sibling quarantine: quota exhausted on zai/glm-5 x' }),
    ).toBe('zai/glm-5');
  });
});

function mount(state: EngineState, command = vi.fn(async () => ({}))) {
  const host = document.createElement('div');
  const root = createRoot(host);
  act(() => root.render(createElement(ProviderWaitingRoom, { state, command })));
  return { host, root, command };
}

describe('waiting room above the composer', () => {
  it('stays hidden while nothing waits and asks for a fresh snapshot once live', () => {
    const { host, command } = mount(emptyEngineState);
    expect(host.textContent).toBe('');
    expect(command).toHaveBeenCalledWith('provider.status.get', {}, ['provider.status.snapshot']);
  });

  it('does not ask while the journal is still replaying', () => {
    const { command } = mount({ ...emptyEngineState, hydrating: true, synced: false });
    expect(command).not.toHaveBeenCalled();
  });

  it('lists blocked pairs and releases one for the next probe', async () => {
    const state = reduceEngine(emptyEngineState, {
      type: 'provider.status_changed',
      payload: blocked,
    });
    const { host, command } = mount(state);
    expect(host.textContent).toContain('1 blocked · 0 degraded · 0 scheduled');
    act(() => host.querySelector<HTMLButtonElement>('[aria-expanded="false"]')?.click());
    expect(host.textContent).toContain('zai/glm-5');
    act(() => host.querySelector<HTMLButtonElement>('.waiting-pair')?.click());
    expect(host.textContent).toContain('Last error: Too many requests');
    const release = [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Release for next probe'),
    );
    await act(async () => release?.click());
    expect(command).toHaveBeenCalledWith(
      'provider.status.retry',
      { providerId: 'zai', model: 'glm-5' },
      ['key.operation_result'],
    );
  });

  it('asks before clearing tracked failures', () => {
    const state = reduceEngine(emptyEngineState, {
      type: 'provider.status_changed',
      payload: blocked,
    });
    const { host, command } = mount(state);
    act(() => host.querySelector<HTMLButtonElement>('[aria-expanded="false"]')?.click());
    act(() => host.querySelector<HTMLButtonElement>('.waiting-pair')?.click());
    const clear = () =>
      [...host.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('Clear tracking'),
      );
    act(() => clear()?.click());
    expect(host.textContent).toContain('Clear tracked failures for zai/glm-5?');
    expect(command).not.toHaveBeenCalledWith(
      'provider.status.clear',
      expect.anything(),
      expect.anything(),
    );
  });

  it('shows a calendar blackout in force now', () => {
    const state: EngineState = {
      ...emptyEngineState,
      results: {
        'prefs.updated': {
          modelAvailabilitySchedule: [
            { id: 'night', provider: 'zai', start: '00:00', end: '00:00', label: 'All day' },
          ],
        },
      },
    };
    const { host } = mount(state);
    expect(host.textContent).toContain('0 blocked · 0 degraded · 1 scheduled');
    act(() => host.querySelector<HTMLButtonElement>('[aria-expanded="false"]')?.click());
    expect(host.textContent).toContain('zai/*');
    expect(host.textContent).toContain('All day');
  });
});
