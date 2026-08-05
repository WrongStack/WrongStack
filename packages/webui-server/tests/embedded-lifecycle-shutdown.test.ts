/**
 * Issue #322 — webui.shutdown must stop owned children before closing the
 * listen socket / unregistering the instance registry.
 */
import { describe, expect, it, vi } from 'vitest';
import { createWebuiShutdown } from '../src/server/embedded-lifecycle.js';

function makeWss() {
  return {
    close: (cb?: () => void) => {
      queueMicrotask(() => cb?.());
    },
  };
}

describe('createWebuiShutdown (issue #322)', () => {
  it('stops owned children before closing HTTP/WS and unregistering', async () => {
    const order: string[] = [];
    const stopOwnedChildren = vi.fn(async () => {
      order.push('children');
    });
    const disposeResources = vi.fn(() => {
      order.push('dispose');
    });
    const closeClients = vi.fn(() => {
      order.push('clients');
    });
    const closeHttpServer = vi.fn(() => {
      order.push('http');
    });
    const unregisterFn = vi.fn(async () => {
      order.push('unregister');
    });
    const onStopped = vi.fn(() => {
      order.push('stopped');
    });
    const wss = {
      close: (cb?: () => void) => {
        order.push('wss');
        queueMicrotask(() => cb?.());
      },
    };

    const shutdown = createWebuiShutdown({
      abortInFlight: () => order.push('abort'),
      unsubscribeEvents: () => order.push('unsub'),
      stopOwnedChildren,
      disposeResources,
      closeClients,
      closeHttpServer,
      wss,
      pid: 12345,
      registryBaseDir: undefined,
      unregisterFn,
      onStopped,
      log: () => {},
      debug: () => {},
    });

    shutdown();
    await vi.waitFor(() => expect(onStopped).toHaveBeenCalled());

    expect(order.indexOf('children')).toBeGreaterThan(order.indexOf('abort'));
    expect(order.indexOf('children')).toBeLessThan(order.indexOf('http'));
    expect(order.indexOf('children')).toBeLessThan(order.indexOf('wss'));
    expect(order.indexOf('children')).toBeLessThan(order.indexOf('unregister'));
    expect(order.indexOf('unregister')).toBeLessThan(order.indexOf('stopped'));
    expect(stopOwnedChildren).toHaveBeenCalledOnce();
  });

  it('still stops the server when stopOwnedChildren times out', async () => {
    const onStopped = vi.fn();
    const unregisterFn = vi.fn(async () => {});
    const debug = vi.fn();

    const shutdown = createWebuiShutdown({
      abortInFlight: () => {},
      unsubscribeEvents: () => {},
      stopOwnedChildren: () => new Promise(() => {}), // never settles
      childCleanupTimeoutMs: 30,
      disposeResources: () => {},
      closeClients: () => {},
      closeHttpServer: () => {},
      wss: makeWss(),
      pid: 1,
      registryBaseDir: undefined,
      unregisterFn,
      onStopped,
      log: () => {},
      debug,
    });

    shutdown();
    await vi.waitFor(() => expect(onStopped).toHaveBeenCalled(), { timeout: 2_000 });
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('timed out'));
    expect(unregisterFn).toHaveBeenCalled();
  });

  it('is idempotent', async () => {
    const stopOwnedChildren = vi.fn(async () => {});
    const onStopped = vi.fn();
    const shutdown = createWebuiShutdown({
      abortInFlight: () => {},
      unsubscribeEvents: () => {},
      stopOwnedChildren,
      closeClients: () => {},
      closeHttpServer: () => {},
      wss: makeWss(),
      pid: 1,
      registryBaseDir: undefined,
      unregisterFn: async () => {},
      onStopped,
      log: () => {},
      debug: () => {},
    });

    shutdown();
    shutdown();
    await vi.waitFor(() => expect(onStopped).toHaveBeenCalled());
    expect(stopOwnedChildren).toHaveBeenCalledOnce();
    expect(onStopped).toHaveBeenCalledOnce();
  });
});
