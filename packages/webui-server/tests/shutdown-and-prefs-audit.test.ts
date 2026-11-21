import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';

const seam = vi.hoisted(() => ({
  registered: null as null | { onShutdown: () => Promise<void> },
}));

vi.mock('../src/server/server-runtime.js', () => ({
  registerShutdown: (opts: { onShutdown: () => Promise<void> }) => {
    seam.registered = opts;
    return () => {};
  },
}));
vi.mock('../src/server/instance-registry.js', () => ({
  unregisterInstance: async () => {},
}));

import { handlePrefsRoute, type PrefsRouteHandlers } from '../src/server/prefs-routes.js';
import { setupWebuiShutdown } from '../src/server/start-webui-shutdown.js';

describe('webui-server shutdown & prefs-routes regressions', () => {
  it('invokes getProxyInstantApplyDispose() during onShutdown', async () => {
    let proxyDisposed = 0;
    const noop = () => {};
    const done = async () => {};
    setupWebuiShutdown({
      getSession: () => ({ id: 'boot', append: done, close: done, flushSync: noop }) as never,
      tokenCounter: { total: () => ({ input: 0, output: 0 }) } as never,
      clients: new Map(),
      httpServer: { close: noop } as never,
      companionServer: null,
      wssPrimary: { close: noop } as never,
      stopEmptySessionCleanup: { dispose: done },
      getKanbanSupervisorDispose: () => null,
      todosCheckpoint: { detach: done },
      stopHeapWatchdog: done,
      getCredentialWatcherClose: () => noop,
      getProxyInstantApplyDispose: () => () => {
        proxyDisposed++;
      },
      disposeRealtimeHandlers: noop,
      logger: { info: noop, warn: noop, debug: noop } as never,
      brainMonitor: { stop: noop } as never,
      agentServices: {
        closeChimera: done,
        closeAcpLeader: done,
        closePlugins: done,
        runSageSessionHygiene: done,
      } as never,
      mcpRegistry: { stopAll: done } as never,
      sessionIdentity: { stop: done } as never,
      eventArming: { getDispose: () => undefined } as never,
      getEternalSubscription: () => null,
      clearEternalSubscription: noop,
      codebaseIndexing: { dispose: noop } as never,
      memoryStore: { dispose: done } as never,
      vectorMemoryStore: undefined,
      globalConfigPath: '/tmp/global/config.json',
    });

    await seam.registered?.onShutdown();
    expect(proxyDisposed).toBe(1);
  });

  it('sends a correlated config.doctor.result error reply when doctorConfig throws', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const ws = {
      readyState: 1,
      send: (raw: string) => sent.push(JSON.parse(raw) as Record<string, unknown>),
    } as unknown as WebSocket;

    const handlers: PrefsRouteHandlers = {
      getPrefs: async () => {},
      updatePrefs: async () => {},
      getSystemPrompt: async () => {},
      manageSystemPromptPresets: async () => {},
      doctorConfig: async () => {
        throw new Error('config lock failed');
      },
    };

    const handled = await handlePrefsRoute(
      ws,
      { type: 'config.doctor', payload: { requestId: 'doc-req-1', apply: false } } as never,
      handlers,
    );

    expect(handled).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: 'config.doctor.result',
      payload: {
        success: false,
        requestId: 'doc-req-1',
        error: 'config lock failed',
      },
    });
  });
});
