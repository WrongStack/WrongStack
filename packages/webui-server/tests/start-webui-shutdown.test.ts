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
    let registered: {
      flushSession: () => Promise<void>;
      onPreShutdown: () => Promise<void>;
      onShutdown: () => Promise<void>;
      servers: unknown[];
    } | undefined;
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
    const primary = {};
    const companion = {};
    const secondary = {};

    const result = setupWebuiShutdown({
      session: { append, close: closeSession },
      tokenCounter: { total: vi.fn(() => ({ input: 12, output: 3 })) },
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
      disposeRealtimeHandlers,
      governanceHandle: { close: governanceClose },
      logger,
      brainMonitor: { stop: brainStop },
      agentServices: { brainLedger: { stop: brainLedgerStop }, runSageSessionHygiene },
      mcpRegistry: { stopAll },
      sessionIdentity: { stop: sessionIdentityStop },
      eventArming: { getDispose: () => disposeEvents },
      getEternalSubscription: () => ({ dispose: eternalDispose }),
      clearEternalSubscription,
      codebaseIndexing: { dispose: disposeIndexing },
      memoryStore: { dispose: disposeMemory },
      globalConfigPath: 'D:/home/.wrongstack/config.json',
    });

    expect(result).toBe(unregister);
    expect(registered?.servers).toEqual([primary, companion, expect.anything(), secondary]);
    await registered?.flushSession();
    await registered?.onPreShutdown();
    await registered?.onShutdown();

    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'session_end', usage: { input: 12, output: 3 } }),
    );
    expect(closeSession).toHaveBeenCalled();
    expect(disposeEmptySessions).toHaveBeenCalled();
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
    expect(mocks.unregisterInstance).toHaveBeenCalledWith(
      process.pid,
      expect.stringMatching(/[\\/]\.wrongstack$/),
    );
  });
});
