import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  render: vi.fn(),
  createRegistration: vi.fn(),
  createDurableTeardown: vi.fn(),
  killAll: vi.fn(),
  unsilenceTerminal: vi.fn(),
}));

vi.mock('ink', () => ({ render: mocks.render }));
vi.mock('../src/run-tui-client-registration.js', () => ({
  createRunTuiClientRegistration: mocks.createRegistration,
}));
vi.mock('../src/run-tui-teardown.js', () => ({
  createDurableTeardown: mocks.createDurableTeardown,
}));
vi.mock('@wrongstack/tools', () => ({
  getProcessRegistry: () => ({ killAll: mocks.killAll }),
}));
vi.mock('../src/terminal-silence.js', () => ({
  unsilenceTerminal: mocks.unsilenceTerminal,
}));

import { createExitOrchestrator } from '../src/run-tui-exits.js';
import { mountInkApp } from '../src/run-tui-mount.js';
import { setupTuiSession } from '../src/run-tui-session.js';

describe('extracted runTui facades', () => {
  const registration = { register: vi.fn(), unregister: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createRegistration.mockReturnValue(registration);
    mocks.createDurableTeardown.mockImplementation((deps: { cleanup: () => void }) => ({
      salvageSync: vi.fn(),
      shutdownViaSignal: vi.fn(async () => deps.cleanup()),
      awaitDurableClose: vi.fn(async () => deps.cleanup()),
    }));
  });

  it('maps session identity and cleanup state into client registration', () => {
    const opts = {
      projectRoot: '/repo',
      events: {},
      appConfig: {},
      hqTelemetryOwnedExternally: true,
      getSessionId: () => 'session-1',
      agent: { ctx: { meta: { globalAgentId: 'global-1' }, agentId: 'local-1' } },
    };

    expect(setupTuiSession(opts as never, () => true)).toBe(registration);
    const mapped = mocks.createRegistration.mock.calls[0]?.[0];
    expect(mapped).toMatchObject({ projectRoot: '/repo', hqTelemetryOwnedExternally: true });
    expect(mapped.getAgentId()).toBe('global-1');
    expect(mapped.isCleaned()).toBe(true);
  });

  it('mounts Ink, wires terminal listeners, and reports render failures', () => {
    const instance = { unmount: vi.fn(), waitUntilExit: vi.fn(async () => undefined) };
    mocks.render.mockReturnValueOnce(instance);
    const stdin = { on: vi.fn() };
    const stdout = { on: vi.fn(), off: vi.fn(), write: vi.fn() };
    const onRawCtrlC = vi.fn();
    const onStartupFailure = vi.fn();

    const mounted = mountInkApp({
      appElement: {} as never,
      inkStdin: stdin as never,
      stdout: stdout as never,
      onRawCtrlC,
      onStartupFailure,
    });

    expect(mounted?.instance).toBe(instance);
    expect(stdin.on).toHaveBeenCalledWith('data', onRawCtrlC);
    const onResize = stdout.on.mock.calls.find(([event]) => event === 'resize')?.[1] as
      | (() => void)
      | undefined;
    onResize?.();
    expect(stdout.write).toHaveBeenCalledWith('\x1b[J');
    mounted?.detachResize();
    expect(stdout.off).toHaveBeenCalledWith('resize', onResize);

    const failure = new Error('render failed');
    mocks.render.mockImplementationOnce(() => {
      throw failure;
    });
    expect(
      mountInkApp({
        appElement: {} as never,
        inkStdin: stdin as never,
        stdout: stdout as never,
        onRawCtrlC,
        onStartupFailure,
      }),
    ).toBeNull();
    expect(onStartupFailure).toHaveBeenCalledWith(failure);
  });

  it('settles through durable cleanup and detaches exit listeners', async () => {
    const close = vi.fn(async () => undefined);
    const stdout = { write: vi.fn() };
    const stdin = { off: vi.fn() };
    const lifecycle = { release: vi.fn(), reset: vi.fn() };
    const stopTitle = vi.fn();
    const restoreTrace = vi.fn();
    const opts = {
      projectRoot: '/repo',
      agent: { ctx: { meta: {}, agentId: 'agent-1', session: { close } } },
    };
    const exits = createExitOrchestrator({
      opts: opts as never,
      stdout: stdout as never,
      inkStdin: stdin as never,
      lifecycle: lifecycle as never,
      stopTitle,
      restoreTrace,
    });
    const result = new Promise<number>((resolve) => exits.attachResolve(resolve));

    exits.recordExitCode(7);
    expect(exits.getRunExitCode()).toBe(7);
    exits.markAlternateScreenActive();
    exits.onRawCtrlC('ordinary input');
    exits.settle(7);

    await expect(result).resolves.toBe(7);
    expect(registration.register).toHaveBeenCalledTimes(1);
    expect(registration.unregister).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(lifecycle.release).toHaveBeenCalledTimes(1);
    expect(lifecycle.reset).toHaveBeenCalledWith(stdout);
    expect(restoreTrace).toHaveBeenCalledTimes(1);
    expect(mocks.unsilenceTerminal).toHaveBeenCalledTimes(1);
  });
});
