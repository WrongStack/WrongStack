import type { Director } from '@wrongstack/core/coordination';
import type { SlashCommandRegistry } from '@wrongstack/core/registry';
import type { SlashCommand } from '@wrongstack/core/types';
import { render } from 'ink-testing-library';
import React, { act, StrictMode, useState } from 'react';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';
import type { Action, State } from '../src/app-reducer.js';
import { useExitCommand } from '../src/hooks/use-exit-command.js';
import type { SessionInterruptController } from '../src/hooks/use-session-interrupt-controller.js';
import { Text } from '../src/ink.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface RegisteredCmd {
  name: string;
  aliases?: string[] | undefined;
  description?: string;
  run: (args: string, ctx: unknown) => Promise<{ exit?: boolean; message?: string }>;
}

function makeRegistry(hostExitCommand?: SlashCommand): SlashCommandRegistry & {
  registered: RegisteredCmd[];
  unregisterCalls: string[];
} {
  const registered: RegisteredCmd[] = [];
  const unregisterCalls: string[] = [];
  const commands = new Map<string, SlashCommand>();
  if (hostExitCommand) {
    commands.set(hostExitCommand.name, hostExitCommand);
    for (const alias of hostExitCommand.aliases ?? []) commands.set(alias, hostExitCommand);
  }
  const registry = {
    registered,
    unregisterCalls,
    register(cmd: SlashCommand, _owner?: string, _opts?: { official?: boolean }): void {
      registered.push({
        name: cmd.name,
        aliases: cmd.aliases,
        description: cmd.description,
        run: cmd.run as RegisteredCmd['run'],
      });
      commands.set(cmd.name, cmd);
      for (const alias of cmd.aliases ?? []) commands.set(alias, cmd);
    },
    unregister(name: string): boolean {
      unregisterCalls.push(name);
      const command = commands.get(name);
      if (!command) return false;
      for (const [key, candidate] of commands) {
        if (candidate === command) commands.delete(key);
      }
      return true;
    },
    get(name: string): SlashCommand | undefined {
      return commands.get(name);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as unknown as SlashCommandRegistry & { registered: RegisteredCmd[]; unregisterCalls: string[] };
  return registry;
}

interface HarnessRefs {
  stateRef: React.MutableRefObject<State>;
  sessionGenerationRef: React.MutableRefObject<number>;
  dispatch: Mock<(action: Action) => void>;
  interruptController: SessionInterruptController;
  getDirector: () => Director | null;
}

function defined<T>(value: T | null | undefined): T {
  expect(value).not.toBeNull();
  expect(value).toBeDefined();
  return value as T;
}

function buildHarness(): {
  refs: HarnessRefs;
} {
  const state = {
    status: 'idle',
    fleet: {},
    exitConfirm: null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as unknown as State;
  const stateRef = { current: state } as React.MutableRefObject<State>;
  const sessionGenerationRef = { current: 0 } as React.MutableRefObject<number>;
  const dispatch = vi.fn<(action: Action) => void>();
  const interruptController: SessionInterruptController = {
    abortLeader: vi.fn(() => false),
    waitForIdle: vi.fn(async () => undefined),
  };
  const director: Partial<Director> = {
    terminateAll: vi.fn(async () => undefined),
  };
  const getDirector = (): Director | null => director as Director;
  return {
    refs: { stateRef, sessionGenerationRef, dispatch, interruptController, getDirector },
  };
}

function ExitHarness(props: {
  registry: ReturnType<typeof makeRegistry>;
  refs: HarnessRefs;
  /** Reducer-mirrored panel state passed through the production hook API. */
  exitConfirm: State['exitConfirm'];
}): React.ReactElement {
  useExitCommand({
    slashRegistry: props.registry,
    dispatch: props.refs.dispatch,
    exitConfirm: props.exitConfirm,
    stateRef: props.refs.stateRef,
    sessionGenerationRef: props.refs.sessionGenerationRef,
    interruptController: props.refs.interruptController,
    getDirector: props.refs.getDirector,
  });
  return React.createElement(Text, null, 'mounted');
}

function StatefulHarness(props: {
  registry: ReturnType<typeof makeRegistry>;
  refs: HarnessRefs;
  initial: State['exitConfirm'];
}): React.ReactElement {
  // Real React state mirrors the reducer's confirmation panel so the hook
  // is exercised through the same open/close API shape as App.
  const [exitConfirm, setExitConfirm] = useState<State['exitConfirm']>(props.initial);
  props.refs.dispatch.mockImplementation((action: Action) => {
    if (action.type === 'exitConfirmOpen') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const info = (action as any).info;
      setExitConfirm(info);
    }
    if (action.type === 'exitConfirmClose') {
      setExitConfirm(null);
    }
  });
  return React.createElement(ExitHarness, {
    registry: props.registry,
    refs: props.refs,
    exitConfirm,
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('useExitCommand', () => {
  it('registers the /exit slash command on mount and unregisters on unmount', () => {
    const registry = makeRegistry();
    const { refs } = buildHarness();
    const view = render(
      React.createElement(
        StrictMode,
        null,
        React.createElement(ExitHarness, {
          registry,
          refs,
          exitConfirm: null,
        }),
      ),
    );
    expect(registry.registered).toHaveLength(1);
    expect(registry.registered[0]?.name).toBe('exit');
    expect(registry.registered[0]?.aliases).toEqual(['quit', 'q']);
    expect(registry.get('quit')).toBe(registry.get('exit'));
    expect(registry.get('q')).toBe(registry.get('exit'));
    expect(registry.registered[0]?.description).toContain('Exit the TUI');
    act(() => view.unmount());
    expect(registry.unregisterCalls).toContain('exit');
  });

  // (a) idle + 0 subagents — the slash command resolves immediately without
  // dispatching an `exitConfirmOpen`.
  it('idle fleet: /exit awaits the captured host lifecycle without opening confirmation', async () => {
    const hostRun = vi.fn(async () => ({ exit: true, message: 'host cleanup complete' }));
    const registry = makeRegistry({
      name: 'exit',
      aliases: ['quit', 'q'],
      description: 'Host exit',
      run: hostRun,
    });
    const { refs } = buildHarness();
    const view = render(
      React.createElement(
        StrictMode,
        null,
        React.createElement(ExitHarness, {
          registry,
          refs,
          exitConfirm: null,
        }),
      ),
    );
    const cmd = registry.registered[0];
    expect(cmd).toBeDefined();
    const ctx = {};
    const res = await cmd?.run('', ctx);
    expect(res).toEqual({ exit: true, message: 'host cleanup complete' });
    expect(hostRun).toHaveBeenCalledWith('', ctx);
    expect(refs.dispatch).not.toHaveBeenCalled();
    act(() => view.unmount());
  });

  it.each([
    {
      alias: 'quit',
      leaderActive: true,
      fleet: {},
      expected: { leaderActive: true, subagentCount: 0 },
    },
    {
      alias: 'q',
      leaderActive: false,
      fleet: { f1: { id: 'f1', name: 'coder', status: 'running' } },
      expected: { leaderActive: false, subagentCount: 1 },
    },
  ])(
    '/$alias resolves to the guarded command for active leader/subagent work',
    async ({ alias, leaderActive, fleet, expected }) => {
      const registry = makeRegistry();
      const { refs } = buildHarness();
      refs.interruptController.isRunning = vi.fn(() => leaderActive);
      refs.stateRef.current = { ...refs.stateRef.current, fleet } as unknown as State;
      const view = render(React.createElement(ExitHarness, { registry, refs, exitConfirm: null }));

      const cmd = defined(registry.get(alias));
      const pending = cmd.run('', undefined);
      await act(async () => {
        await Promise.resolve();
      });
      const openAction = refs.dispatch.mock.calls.find(
        (c) => (c[0] as Action).type === 'exitConfirmOpen',
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const info = (defined(openAction)[0] as any).info as {
        leaderActive: boolean;
        subagentCount: number;
        resolve: (decision: boolean) => void;
      };
      expect(info).toMatchObject(expected);
      info.resolve(false);
      await expect(pending).resolves.toEqual({ message: 'Exit cancelled.' });
      act(() => view.unmount());
    },
  );

  // (b) leader active — `confirmExit` opens the panel. resolve(true) must
  // complete the bounded teardown before the slash command may return exit.
  it('active leader: resolve(true) awaits teardown before returning exit', async () => {
    const registry = makeRegistry();
    const { refs } = buildHarness();
    refs.stateRef.current = { ...refs.stateRef.current, status: 'running' } as State;
    const view = render(
      React.createElement(
        StrictMode,
        null,
        React.createElement(StatefulHarness, { registry, refs, initial: null }),
      ),
    );
    let releaseIdle!: () => void;
    const idleGate = new Promise<void>((resolve) => {
      releaseIdle = resolve;
    });
    const waitForIdle = vi.mocked(defined(refs.interruptController.waitForIdle));
    waitForIdle.mockImplementation(() => idleGate);

    const cmd = defined(registry.registered[0]);
    const promise = cmd.run('', {});
    await act(async () => {
      await Promise.resolve();
    });
    const openAction = refs.dispatch.mock.calls.find(
      (c) => (c[0] as Action).type === 'exitConfirmOpen',
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const info = (defined(openAction)[0] as any).info as {
      leaderActive: boolean;
      subagentCount: number;
      resolve: (decision: boolean) => void;
    };
    expect(info.leaderActive).toBe(true);
    expect(typeof info.resolve).toBe('function');

    let commandSettled = false;
    void promise.then(() => {
      commandSettled = true;
    });
    info.resolve(true);
    await act(async () => {
      await Promise.resolve();
    });
    expect(refs.interruptController.abortLeader).toHaveBeenCalledTimes(1);
    expect(waitForIdle).toHaveBeenCalledTimes(1);
    expect(commandSettled).toBe(false);

    releaseIdle();
    const res = await promise;
    expect(res).toEqual({ exit: true, message: 'Exiting…' });
    expect(refs.sessionGenerationRef.current).toBe(1);
    expect(refs.getDirector()?.terminateAll).toHaveBeenCalledTimes(1);
    act(() => view.unmount());
  });

  // (b-2) confirm-cancel — resolve(false) returns the cancel message and
  // does NOT terminate the fleet on close.
  it('active leader: resolve(false) yields the cancel message and does not terminate', async () => {
    const registry = makeRegistry();
    const { refs } = buildHarness();
    refs.stateRef.current = { ...refs.stateRef.current, status: 'running' } as State;
    const view = render(
      React.createElement(
        StrictMode,
        null,
        React.createElement(StatefulHarness, { registry, refs, initial: null }),
      ),
    );
    const cmd = registry.registered[0];
    expect(cmd).toBeDefined();
    const promise = cmd?.run('', {});
    await act(async () => {
      await Promise.resolve();
    });
    const openAction = refs.dispatch.mock.calls.find(
      (c) => (c[0] as Action).type === 'exitConfirmOpen',
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const info = (defined(openAction)[0] as any).info as { resolve: (decision: boolean) => void };
    info.resolve(false);
    const res = await promise;
    expect(res).toEqual({ message: 'Exit cancelled.' });
    act(() => {
      refs.dispatch({ type: 'exitConfirmClose' });
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(refs.sessionGenerationRef.current).toBe(0);
    const dir = refs.getDirector();
    expect(dir?.terminateAll).not.toHaveBeenCalled();
    act(() => view.unmount());
  });

  // (b-3) idle leader with one running subagent — the load-bearing path from
  // the task. The command must not yield `{ exit: true }` while terminateAll
  // is still pending, because the caller is allowed to unmount immediately.
  it('idle leader + 1 running subagent: teardown completes before /exit resolves', async () => {
    const registry = makeRegistry();
    const { refs } = buildHarness();
    refs.stateRef.current = {
      ...refs.stateRef.current,
      status: 'idle',
      fleet: { f1: { id: 'f1', name: 'coder', status: 'running' } },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as unknown as State;

    let releaseTeardown!: () => void;
    const teardownGate = new Promise<void>((resolve) => {
      releaseTeardown = resolve;
    });
    const terminateAll = vi.mocked(defined(refs.getDirector()).terminateAll);
    terminateAll.mockImplementation(() => teardownGate);

    const view = render(
      React.createElement(
        StrictMode,
        null,
        React.createElement(StatefulHarness, { registry, refs, initial: null }),
      ),
    );
    const cmd = defined(registry.registered[0]);
    const resultPromise = cmd.run('', {});
    await act(async () => {
      await Promise.resolve();
    });
    const openAction = refs.dispatch.mock.calls.find(
      (c) => (c[0] as Action).type === 'exitConfirmOpen',
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const info = (defined(openAction)[0] as any).info as {
      leaderActive: boolean;
      subagentCount: number;
      resolve: (decision: boolean) => void;
    };
    expect(info.leaderActive).toBe(false);
    expect(info.subagentCount).toBe(1);

    let commandSettled = false;
    void resultPromise.then(() => {
      commandSettled = true;
    });
    info.resolve(true);
    await act(async () => {
      await Promise.resolve();
    });

    expect(refs.sessionGenerationRef.current).toBe(1);
    expect(terminateAll).toHaveBeenCalledTimes(1);
    expect(commandSettled).toBe(false);

    releaseTeardown();
    const res = await resultPromise;
    expect(res).toEqual({ exit: true, message: 'Exiting…' });
    expect(commandSettled).toBe(true);
    act(() => view.unmount());
  });

  // (c) pendingResolveRef swap — opening a second /exit while the first is
  // still open resolves the first waiter with `false` so it cannot strand
  // a stale promise.
  it('a second /exit while the first is open resolves the first waiter with false', async () => {
    const registry = makeRegistry();
    const { refs } = buildHarness();
    refs.stateRef.current = { ...refs.stateRef.current, status: 'running' } as State;
    const view = render(
      React.createElement(
        StrictMode,
        null,
        React.createElement(StatefulHarness, { registry, refs, initial: null }),
      ),
    );
    const cmd = registry.registered[0];
    expect(cmd).toBeDefined();
    const first = cmd?.run('', {});
    await act(async () => {
      await Promise.resolve();
    });
    const second = cmd?.run('', {});
    const firstRes = await first;
    expect(firstRes).toEqual({ message: 'Exit cancelled.' });
    const openActions = refs.dispatch.mock.calls.filter(
      (c) => (c[0] as Action).type === 'exitConfirmOpen',
    );
    expect(openActions).toHaveLength(2);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const secondInfo = (defined(openActions[1])[0] as any).info as {
      resolve: (decision: boolean) => void;
    };
    secondInfo.resolve(true);
    const secondRes = await second;
    expect(secondRes).toEqual({ exit: true, message: 'Exiting…' });
    act(() => view.unmount());
  });

  // Closing the panel without invoking its decision callback (for example,
  // an external dismiss) must not start lifecycle teardown.
  it('panel-close with no decision does not call terminateFleet', () => {
    const registry = makeRegistry();
    const { refs } = buildHarness();
    const view = render(
      React.createElement(
        StrictMode,
        null,
        React.createElement(StatefulHarness, { registry, refs, initial: null }),
      ),
    );
    // Reducer closes the panel WITHOUT a decision (external dismiss).
    act(() => {
      refs.dispatch({ type: 'exitConfirmClose' });
    });
    expect(refs.sessionGenerationRef.current).toBe(0);
    const dir = refs.getDirector();
    expect(dir?.terminateAll).not.toHaveBeenCalled();
    act(() => view.unmount());
  });

  // getDirector is optional — when absent, the awaited confirmation path
  // still bumps the generation and resolves without throwing.
  it('omitting getDirector: confirm(true) bumps generation and resolves', async () => {
    const registry = makeRegistry();
    const { refs } = buildHarness();
    refs.stateRef.current = { ...refs.stateRef.current, status: 'running' } as State;
    function HarnessNoDirector(props: { exitConfirm: State['exitConfirm'] }): React.ReactElement {
      useExitCommand({
        slashRegistry: registry,
        dispatch: refs.dispatch,
        exitConfirm: props.exitConfirm,
        stateRef: refs.stateRef,
        sessionGenerationRef: refs.sessionGenerationRef,
      });
      return React.createElement(Text, null, 'no-dir');
    }
    function StatefulNoDirector(): React.ReactElement {
      const [exitConfirm, setExitConfirm] = useState<State['exitConfirm']>(null);
      refs.dispatch.mockImplementation((action: Action) => {
        if (action.type === 'exitConfirmOpen') {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          setExitConfirm((action as any).info);
        }
        if (action.type === 'exitConfirmClose') {
          setExitConfirm(null);
        }
      });
      return React.createElement(HarnessNoDirector, { exitConfirm });
    }
    const view = render(React.createElement(StatefulNoDirector));
    const cmd = registry.registered[0];
    expect(cmd).toBeDefined();
    const promise = cmd?.run('', {});
    await act(async () => {
      await Promise.resolve();
    });
    const openAction = refs.dispatch.mock.calls.find(
      (c) => (c[0] as Action).type === 'exitConfirmOpen',
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (defined(openAction)[0] as any).info.resolve(true);
    await promise;
    expect(refs.sessionGenerationRef.current).toBe(1);
    act(() => view.unmount());
  });
});
