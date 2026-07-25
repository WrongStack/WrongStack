/**
 * Tests for setupDepWatcherBridge (extracted from cli-main.ts).
 *
 * Covers:
 *   - Enabled with default targetAgent/debounceMs
 *   - Enabled with custom targetAgent and debounceMs from config
 *   - Disabled (enabled === false) — no bridge created
 *   - Missing config entirely — no-op, dwCfg undefined
 *   - attachDepWatcherBridge throws — logged as warning
 *   - Teardown handler registered on successful creation
 *   - Returns dwCfg for downstream use by setupDepWatcherConsumers
 */
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ──────────────────────────────────────────────────────────────
const t = vi.hoisted(() => {
  const disposeMock = vi.fn();
  const attachDepWatcherBridgeMock = vi.fn(function () {
    return disposeMock;
  });
  const GlobalMailboxMock = vi.fn(function () {
    return { /* mailbox stub — passed through to attachDepWatcherBridge */ };
  });
  return {
    disposeMock,
    attachDepWatcherBridgeMock,
    GlobalMailboxMock,
  };
});

vi.mock('@wrongstack/core/coordination', () => ({
  attachDepWatcherBridge: t.attachDepWatcherBridgeMock,
  GlobalMailbox: t.GlobalMailboxMock,
}));

// ── Module under test ─────────────────────────────────────────────────
import { setupDepWatcherBridge } from '../src/wiring/dep-watcher-bridge.js';

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn() };
}

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    config: {
      extensions: {
        'file-watcher': {
          depWatcher: {
            enabled: true,
          },
        },
      },
    },
    wpaths: {
      globalRoot: '/tmp/.wrongstack',
      projectSlug: 'my-project',
    },
    projectRoot: '/home/user/projects/my-project',
    events: { on: vi.fn() } as never,
    logger: makeLogger(),
    teardownHandlers: [] as Array<() => void>,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();

  // Re-apply mock implementations (clearAllMocks resets call history but
  // not mockImplementation — error-case tests would pollute later tests).
  t.attachDepWatcherBridgeMock.mockImplementation(function () {
    return t.disposeMock;
  });
  t.GlobalMailboxMock.mockImplementation(function () {
    return {};
  });
});

describe('setupDepWatcherBridge', () => {
  it('creates bridge and logs info when enabled with defaults', () => {
    const result = setupDepWatcherBridge(makeDeps());

    expect(result.dwCfg).toEqual({ enabled: true });
    expect(t.GlobalMailboxMock).toHaveBeenCalledWith(
      path.join('/tmp/.wrongstack', 'projects', 'my-project'),
      expect.any(Object),
    );
    expect(t.attachDepWatcherBridgeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectRoot: '/home/user/projects/my-project',
        targetAgent: 'tech-stack',
        watcherAgentId: 'dep-watcher',
        debounceMs: 3000,
      }),
    );
  });

  it('passes custom targetAgent and debounceMs from config', () => {
    const deps = makeDeps({
      config: {
        extensions: {
          'file-watcher': {
            depWatcher: {
              enabled: true,
              targetAgent: 'my-custom-agent',
              debounceMs: 5000,
            },
          },
        },
      },
    });

    setupDepWatcherBridge(deps);

    expect(t.attachDepWatcherBridgeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        targetAgent: 'my-custom-agent',
        debounceMs: 5000,
      }),
    );
  });

  it('does nothing when depWatcher is disabled', () => {
    const deps = makeDeps({
      config: {
        extensions: {
          'file-watcher': {
            depWatcher: { enabled: false },
          },
        },
      },
    });

    const result = setupDepWatcherBridge(deps);

    expect(result.dwCfg).toEqual({ enabled: false });
    expect(t.GlobalMailboxMock).not.toHaveBeenCalled();
    expect(t.attachDepWatcherBridgeMock).not.toHaveBeenCalled();
  });

  it('does nothing when file-watcher config is missing entirely', () => {
    const deps = makeDeps({
      config: { extensions: {} },
    });

    const result = setupDepWatcherBridge(deps);

    expect(result.dwCfg).toBeUndefined();
    expect(t.GlobalMailboxMock).not.toHaveBeenCalled();
    expect(t.attachDepWatcherBridgeMock).not.toHaveBeenCalled();
  });

  it('does nothing when extensions config is missing', () => {
    const deps = makeDeps({
      config: {},
    });

    const result = setupDepWatcherBridge(deps);

    expect(result.dwCfg).toBeUndefined();
    expect(t.GlobalMailboxMock).not.toHaveBeenCalled();
    expect(t.attachDepWatcherBridgeMock).not.toHaveBeenCalled();
  });

  it('logs warning when attachDepWatcherBridge throws', () => {
    t.attachDepWatcherBridgeMock.mockImplementation(() => {
      throw new Error('mailbox init failed');
    });
    const logger = makeLogger();
    const deps = makeDeps({ logger });

    const result = setupDepWatcherBridge(deps);

    expect(result.dwCfg).toEqual({ enabled: true });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to wire dep-watcher bridge'),
    );
  });

  it('registers teardown dispose handler when bridge is created', () => {
    const teardownHandlers: Array<() => void> = [];
    const deps = makeDeps({ teardownHandlers });

    setupDepWatcherBridge(deps);

    expect(teardownHandlers).toHaveLength(1);
    expect(teardownHandlers[0]).toBe(t.disposeMock);
  });

  it('does not register teardown handler when bridge is not created', () => {
    const teardownHandlers: Array<() => void> = [];
    const deps = makeDeps({
      config: { extensions: {} },
      teardownHandlers,
    });

    setupDepWatcherBridge(deps);

    expect(teardownHandlers).toHaveLength(0);
  });

  it('logs info when bridge is activated', () => {
    const logger = makeLogger();
    const deps = makeDeps({ logger });

    setupDepWatcherBridge(deps);

    expect(logger.info).toHaveBeenCalledWith(
      'Dep-watcher bridge activated — dependency changes will trigger tech-stack audits',
    );
  });

  it('forwards the mailbox instance to attachDepWatcherBridge', () => {
    const deps = makeDeps();

    setupDepWatcherBridge(deps);

    const callArgs = t.attachDepWatcherBridgeMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(callArgs.mailbox).toBeDefined();
    // The mailbox is the return value of new GlobalMailboxMock(...)
    expect(t.GlobalMailboxMock.mock.instances[0]).toBe(callArgs.mailbox);
  });

  it('returns dwCfg for downstream use by setupDepWatcherConsumers', () => {
    const customConfig = {
      enabled: true,
      targetAgent: 'audit-agent',
      debounceMs: 10000,
      extraField: 'preserved',
    };
    const deps = makeDeps({
      config: {
        extensions: {
          'file-watcher': {
            depWatcher: customConfig,
          },
        },
      },
    });

    const result = setupDepWatcherBridge(deps);

    // The full config fragment is returned, including extra fields
    expect(result.dwCfg).toEqual(customConfig);
  });
});
