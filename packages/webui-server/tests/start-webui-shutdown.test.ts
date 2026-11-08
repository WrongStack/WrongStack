import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  registerShutdown: vi.fn(),
  unregisterInstance: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/server/server-runtime.js', () => ({
  registerShutdown: mocks.registerShutdown,
}));
vi.mock('../src/server/instance-registry.js', () => ({
  unregisterInstance: mocks.unregisterInstance,
}));

import { setupWebuiShutdown } from '../src/server/start-webui-shutdown.js';

describe('setupWebuiShutdown', () => {
  it('registers and runs the complete standalone cleanup lifecycle', async () => {
    let registered:
      | {
          flushSession: () => Promise<void>;
          onPreShutdown: () => Promise<void>;
          onShutdown: () => Promise<void>;
          servers: unknown[];
        }
      | undefined;
    const unregister = vi.fn();
    mocks.registerShutdown.mockImplementation((options: typeof registered) => {
      registered = options;
      return unregister;
    });
    const append = vi.fn().mockResolvedValue(undefined);
    const closeSession = vi.fn().mockResolvedValue(undefined);
    const disposeEmptySessions = vi.fn().mockResolvedValue(undefined);
    const disposeKanban = vi.fn();
    const detachTodos = vi.fn().mockResolvedValue(undefined);
    const stopHeapWatchdog = vi.fn().mockResolvedValue(undefined);
    const closeCredentialWatcher = vi.fn();
    const disposeProxyApply = vi.fn();
    const disposeRealtimeHandlers = vi.fn();
    const governanceClose = vi.fn().mockResolvedValue({
      ok: false,
      action: 'rollback',
      message: 'cleanup failed',
    });
    const logger = { warn: vi.fn() };
    const brainStop = vi.fn();
    const brainLedgerStop = vi.fn().mockRejectedValue(new Error('ignored'));
    const stopAll = vi.fn().mockRejectedValue(new Error('ignored'));
    const sessionIdentityStop = vi.fn().mockResolvedValue(undefined);
    const disposeEvents = vi.fn();
    const eternalDispose = vi.fn();
    const clearEternalSubscription = vi.fn();
    const disposeIndexing = vi.fn();
    const runSageSessionHygiene = vi.fn().mockRejectedValue(new Error('sage failed'));
    const disposeMemory = vi.fn().mockRejectedValue(new Error('memory failed'));
    const closeVectorMemory = vi.fn();
    const closeChimera = vi.fn().mockResolvedValue(undefined);
    const closePlugins = vi.fn().mockRejectedValue(new Error('teardown timed out'));
    const closeAcpLeader = vi.fn().mockResolvedValue(undefined);
    const primary = {};
    const companion = {};
    const secondary = {};

    const result = setupWebuiShutdown({
      getSession: () => ({ append, close: closeSession }) as never,
      tokenCounter: { total: vi.fn(() => ({ input: 12, output: 3 })) } as never,
      clients: new Map(),
      httpServer: primary as never,
      companionServer: companion as never,
      wssPrimary: {} as never,
      wssSecondary: secondary as never,
      stopEmptySessionCleanup: { dispose: disposeEmptySessions },
      getKanbanSupervisorDispose: () => disposeKanban,
      todosCheckpoint: { detach: detachTodos },
      stopHeapWatchdog,
      getCredentialWatcherClose: () => closeCredentialWatcher,
      getProxyInstantApplyDispose: () => disposeProxyApply,
      disposeRealtimeHandlers,
      governanceHandle: { close: governanceClose },
      logger: logger as never,
      brainMonitor: { stop: brainStop } as never,
      agentServices: {
        brainLedger: { stop: brainLedgerStop },
        runSageSessionHygiene,
        closeChimera,
        closePlugins,
        closeAcpLeader,
      } as never,
      mcpRegistry: { stopAll } as never,
      sessionIdentity: { stop: sessionIdentityStop } as never,
      eventArming: { getDispose: () => disposeEvents } as never,
      getEternalSubscription: () => ({ dispose: eternalDispose }),
      clearEternalSubscription,
      codebaseIndexing: { dispose: disposeIndexing } as never,
      memoryStore: { dispose: disposeMemory } as never,
      vectorMemoryStore: { close: closeVectorMemory },
      globalConfigPath: 'D:/home/.wrongstack/config.json',
    });

    expect(result).toEqual(expect.any(Function));
    expect(registered?.servers).toEqual([primary, companion, expect.anything(), secondary]);
    await registered?.flushSession();
    await registered?.onPreShutdown();
    await registered?.onShutdown();

    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'session_end', usage: { input: 12, output: 3 } }),
    );
    expect(closeSession).toHaveBeenCalled();
    expect(disposeEmptySessions).toHaveBeenCalled();
    // Plugins go after Chimera's reviews drain and before the journals close; a
    // plugin that fails to tear down is reported, never fatal to shutdown.
    expect(closePlugins).toHaveBeenCalledOnce();
    expect(closeChimera.mock.invocationCallOrder[0]).toBeLessThan(
      closePlugins.mock.invocationCallOrder[0]!,
    );
    expect(logger.warn).toHaveBeenCalledWith('plugin disposal failed: teardown timed out');
    // An ACP leader's agent sessions (and the processes they hold) close on the
    // way out, while the plugins and hooks they report through are still up.
    expect(closeAcpLeader).toHaveBeenCalledOnce();
    expect(closeAcpLeader.mock.invocationCallOrder[0]).toBeLessThan(
      closePlugins.mock.invocationCallOrder[0]!,
    );
    expect(disposeKanban).toHaveBeenCalled();
    expect(unregister).toHaveBeenCalled();
    expect(detachTodos).toHaveBeenCalled();
    expect(stopHeapWatchdog).toHaveBeenCalled();
    expect(closeCredentialWatcher).toHaveBeenCalled();
    expect(disposeRealtimeHandlers).toHaveBeenCalled();
    expect(brainStop).toHaveBeenCalled();
    expect(sessionIdentityStop).toHaveBeenCalled();
    expect(disposeEvents).toHaveBeenCalled();
    expect(eternalDispose).toHaveBeenCalled();
    expect(clearEternalSubscription).toHaveBeenCalled();
    expect(disposeIndexing).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      'governance: standalone WebUI rollback cleanup failed',
      { message: 'cleanup failed' },
    );
    expect(logger.warn).toHaveBeenCalledWith('sage session hygiene failed: sage failed');
    expect(logger.warn).toHaveBeenCalledWith('sage connection disposal failed: memory failed');
    // Vector memory store is wired: shutdown closes the SQLite handle
    // after the SAGE disposal. Must run BEFORE unregisterInstance.
    expect(closeVectorMemory).toHaveBeenCalledTimes(1);
    expect(mocks.unregisterInstance).toHaveBeenCalledWith(
      process.pid,
      expect.stringMatching(/[\\/]\.wrongstack$/),
    );
  });

  it('does not throw when no vector memory store was constructed (disabled / read-only FS)', async () => {
    let registered: { onShutdown: () => Promise<void> } | undefined;
    mocks.registerShutdown.mockImplementation((options: typeof registered) => {
      registered = options;
      return vi.fn();
    });

    const disposeMemoryOk = vi.fn().mockResolvedValue(undefined);
    setupWebuiShutdown({
      getSession: () =>
        ({
          append: vi.fn().mockResolvedValue(undefined),
          close: vi.fn().mockResolvedValue(undefined),
        }) as never,
      tokenCounter: { total: vi.fn(() => ({ input: 0, output: 0 })) } as never,
      clients: new Map(),
      httpServer: {} as never,
      companionServer: null,
      wssPrimary: {} as never,
      wssSecondary: null,
      stopEmptySessionCleanup: { dispose: vi.fn().mockResolvedValue(undefined) },
      getKanbanSupervisorDispose: () => null,
      todosCheckpoint: { detach: vi.fn().mockResolvedValue(undefined) },
      stopHeapWatchdog: vi.fn().mockResolvedValue(undefined),
      getCredentialWatcherClose: () => undefined,
      getProxyInstantApplyDispose: () => vi.fn(),
      disposeRealtimeHandlers: vi.fn(),
      governanceHandle: undefined,
      logger: { warn: vi.fn() } as never,
      brainMonitor: { stop: vi.fn() } as never,
      agentServices: {
        brainLedger: undefined,
        runSageSessionHygiene: () => Promise.resolve(),
      } as never,
      mcpRegistry: { stopAll: vi.fn().mockResolvedValue(undefined) } as never,
      sessionIdentity: { stop: vi.fn().mockResolvedValue(undefined) } as never,
      eventArming: { getDispose: () => undefined } as never,
      getEternalSubscription: () => null,
      clearEternalSubscription: vi.fn(),
      codebaseIndexing: { dispose: vi.fn() } as never,
      memoryStore: { dispose: disposeMemoryOk } as never,
      // vectorMemoryStore: undefined — must be tolerated without throwing.
      vectorMemoryStore: undefined,
      globalConfigPath: 'D:/home/.wrongstack/config.json',
    });

    await expect(registered?.onShutdown()).resolves.toBeUndefined();
    expect(disposeMemoryOk).toHaveBeenCalledTimes(1);
    expect(mocks.unregisterInstance).toHaveBeenCalled();
  });
});
