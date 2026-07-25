/**
 * Tests for setupSessionRegistry (extracted from cli-main.ts).
 *
 * Covers:
 *   - Happy path: git branch detected, session registered, tracker started
 *   - Git failure: execFile calls back with error, session still registers
 *   - Detached HEAD: git returns "HEAD" -> mapped to undefined
 *   - TUI mode: clientType is "tui" vs "cli"
 *   - Registry.register rejection: entire block catches, tracker is undefined
 *   - AgentStatusTracker/FleetNotifier construction args
 *   - Graceful shutdown handler is installed with correct cleanup wiring
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// All mocks in one hoisted block. vi.mock factories run during hoisting
// so every variable they reference must also be hoisted.
// NOTE: Constructor mocks (AgentStatusTracker, FleetNotifier) use `function()`
// declarations so `new` returns the implementation's return object.
// Arrow functions passed to vi.fn() cannot be called with `new` at all.
const t = vi.hoisted(() => {
  const execFileMock = vi.fn();
  const installMock = vi.fn();
  const createGracefulShutdownMock = vi.fn(() => ({ install: installMock }));
  const registerMock = vi.fn();
  const markClosingMock = vi.fn();
  const getSessionRegistryMock = vi.fn(function () {
    return {
      register: registerMock,
      markClosing: markClosingMock,
    };
  });
  const startMock = vi.fn();
  const stopMock = vi.fn();
  const AgentStatusTrackerMock = vi.fn(function () {
    return { start: startMock, stop: stopMock };
  });
  const notifyMock = vi.fn();
  const disposeMock = vi.fn();
  const FleetNotifierMock = vi.fn(function () {
    return { notify: notifyMock, dispose: disposeMock };
  });
  return {
    execFileMock,
    installMock,
    createGracefulShutdownMock,
    registerMock,
    markClosingMock,
    getSessionRegistryMock,
    startMock,
    stopMock,
    AgentStatusTrackerMock,
    notifyMock,
    disposeMock,
    FleetNotifierMock,
  };
});

vi.mock('node:child_process', () => ({
  execFile: t.execFileMock,
}));

vi.mock('../src/shutdown-cleanup.js', () => ({
  createGracefulShutdown: t.createGracefulShutdownMock,
}));

vi.mock('@wrongstack/core/storage', () => ({
  getSessionRegistry: t.getSessionRegistryMock,
  AgentStatusTracker: t.AgentStatusTrackerMock,
  FleetNotifier: t.FleetNotifierMock,
}));

// Module under test
import { setupSessionRegistry } from '../src/wiring/session-registry.js';

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    wpaths: {
      globalRoot: '/tmp/.wrongstack',
      projectDir: '/tmp/.wrongstack/projects/my-project',
      projectSlug: 'my-project',
    },
    projectRoot: '/home/user/projects/my-project',
    session: { id: 'sess_abc123' },
    context: { workingDir: '/home/user/projects/my-project/src', session: { id: 'sess_abc123' } },
    tuiOwnsScreen: false,
    events: { on: vi.fn() } as never,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();

  // Re-apply constructor implementations (clearAllMocks resets call history
  // but not mockImplementation — without this, error-case tests that set
  // mockImplementation(() => { throw ... }) would pollute subsequent tests).
  t.getSessionRegistryMock.mockImplementation(function () {
    return { register: t.registerMock, markClosing: t.markClosingMock };
  });
  t.AgentStatusTrackerMock.mockImplementation(function () {
    return { start: t.startMock, stop: t.stopMock };
  });
  t.FleetNotifierMock.mockImplementation(function () {
    return { notify: t.notifyMock, dispose: t.disposeMock };
  });

  // Default git success
  t.execFileMock.mockImplementation(
    (_cmd: string, _args: string[], _opts: object, cb: (err: Error | null, stdout: string) => void) => {
      cb(null, 'main\n');
    },
  );

  // Default async resolves
  t.registerMock.mockResolvedValue(undefined);
  t.markClosingMock.mockResolvedValue(undefined);
  t.stopMock.mockResolvedValue(undefined);
});

describe('setupSessionRegistry', () => {
  it('registers the session and starts the tracker on happy path', async () => {
    const result = await setupSessionRegistry(makeDeps());

    expect(result.tracker).toBeDefined();
    expect(t.getSessionRegistryMock).toHaveBeenCalledWith('/tmp/.wrongstack');

    expect(t.registerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess_abc123',
        projectSlug: 'my-project',
        projectRoot: '/home/user/projects/my-project',
        projectName: 'my-project',
        workingDir: '/home/user/projects/my-project/src',
        gitBranch: 'main',
        clientType: 'cli',
        pid: process.pid,
      }),
    );

    expect(t.FleetNotifierMock).toHaveBeenCalledWith({
      baseDir: '/tmp/.wrongstack',
      projectRoot: '/home/user/projects/my-project',
      selfPid: process.pid,
    });

    expect(t.AgentStatusTrackerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        events: expect.any(Object),
        registry: expect.any(Object),
        sessionId: expect.any(Function),
        onUpdate: expect.any(Function),
      }),
    );
    const trackerArg = t.AgentStatusTrackerMock.mock.calls[0]![0] as unknown as {
      sessionId: () => string;
    };
    expect(trackerArg.sessionId()).toBe('sess_abc123');

    expect(t.startMock).toHaveBeenCalled();
    expect(t.createGracefulShutdownMock).toHaveBeenCalledTimes(1);
    expect(t.installMock).toHaveBeenCalledTimes(1);
  });

  it('wires the shutdown handler to dispose notifier, mark closing, and stop tracker', async () => {
    await setupSessionRegistry(makeDeps());

    const shutdownArg = t.createGracefulShutdownMock.mock.calls[0]![0] as unknown as {
      run: () => Promise<void>;
    };
    await shutdownArg.run();

    expect(t.disposeMock).toHaveBeenCalled();
    expect(t.markClosingMock).toHaveBeenCalled();
    expect(t.stopMock).toHaveBeenCalled();
  });

  it('shutdown handler does not throw when cleanup operations fail', async () => {
    t.markClosingMock.mockRejectedValue(new Error('disk full'));

    await setupSessionRegistry(makeDeps());

    const shutdownArg = t.createGracefulShutdownMock.mock.calls[0]![0] as unknown as {
      run: () => Promise<void>;
    };
    await expect(shutdownArg.run()).resolves.toBeUndefined();
  });

  it('handles git failure gracefully', async () => {
    t.execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: object, cb: (err: Error | null, _stdout: string) => void) => {
        cb(new Error('not a git repository'), '');
      },
    );

    const result = await setupSessionRegistry(makeDeps());

    expect(result.tracker).toBeDefined();
    expect(t.registerMock).toHaveBeenCalledWith(
      expect.objectContaining({ gitBranch: undefined }),
    );
  });

  it('maps detached HEAD to undefined gitBranch', async () => {
    t.execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: object, cb: (err: Error | null, stdout: string) => void) => {
        cb(null, 'HEAD\n');
      },
    );

    await setupSessionRegistry(makeDeps());

    expect(t.registerMock).toHaveBeenCalledWith(
      expect.objectContaining({ gitBranch: undefined }),
    );
  });

  it('maps empty stdout to undefined gitBranch', async () => {
    t.execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: object, cb: (err: Error | null, stdout: string) => void) => {
        cb(null, '');
      },
    );

    await setupSessionRegistry(makeDeps());

    expect(t.registerMock).toHaveBeenCalledWith(
      expect.objectContaining({ gitBranch: undefined }),
    );
  });

  it('passes clientType "tui" when tuiOwnsScreen is true', async () => {
    await setupSessionRegistry(makeDeps({ tuiOwnsScreen: true }));

    expect(t.registerMock).toHaveBeenCalledWith(
      expect.objectContaining({ clientType: 'tui' }),
    );
  });

  it('passes clientType "cli" when tuiOwnsScreen is false', async () => {
    await setupSessionRegistry(makeDeps({ tuiOwnsScreen: false }));

    expect(t.registerMock).toHaveBeenCalledWith(
      expect.objectContaining({ clientType: 'cli' }),
    );
  });

  it('returns tracker undefined when registry.register rejects', async () => {
    t.registerMock.mockRejectedValue(new Error('registry unavailable'));

    const result = await setupSessionRegistry(makeDeps());

    expect(result.tracker).toBeUndefined();
    expect(t.createGracefulShutdownMock).not.toHaveBeenCalled();
  });

  it('returns tracker undefined when getSessionRegistry throws', async () => {
    t.getSessionRegistryMock.mockImplementation(() => {
      throw new Error('singleton not initialized');
    });

    const result = await setupSessionRegistry(makeDeps());

    expect(result.tracker).toBeUndefined();
    expect(t.registerMock).not.toHaveBeenCalled();
  });

  it('returns tracker undefined when AgentStatusTracker constructor throws', async () => {
    t.AgentStatusTrackerMock.mockImplementation(() => {
      throw new Error('invalid events bus');
    });

    const result = await setupSessionRegistry(makeDeps());

    expect(result.tracker).toBeUndefined();
    expect(t.createGracefulShutdownMock).not.toHaveBeenCalled();
  });

  it('passes resolved projectName as basename of projectRoot', async () => {
    await setupSessionRegistry(
      makeDeps({ projectRoot: '/some/deep/path/to/awesome-project' }),
    );

    expect(t.registerMock).toHaveBeenCalledWith(
      expect.objectContaining({ projectName: 'awesome-project' }),
    );
  });

  it('includes pid and startedAt timestamp in the registration', async () => {
    const before = Date.now();
    await setupSessionRegistry(makeDeps());

    const callArg = t.registerMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(callArg.pid).toBe(process.pid);
    expect(typeof callArg.startedAt).toBe('string');
    const startedAt = new Date(callArg.startedAt as string).getTime();
    expect(startedAt).toBeGreaterThanOrEqual(before - 1000);
    expect(startedAt).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('invokes FleetNotifier notify on every status change via onUpdate', async () => {
    await setupSessionRegistry(makeDeps());

    const trackerArg = t.AgentStatusTrackerMock.mock.calls[0]![0] as unknown as {
      onUpdate: () => void;
    };

    trackerArg.onUpdate();
    expect(t.notifyMock).toHaveBeenCalledTimes(1);

    trackerArg.onUpdate();
    expect(t.notifyMock).toHaveBeenCalledTimes(2);
  });
});
