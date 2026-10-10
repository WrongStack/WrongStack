import { afterEach, describe, expect, it } from 'vitest';
import { EventBus } from '../../src/kernel/events.js';
import {
  runWithNetworkTelemetry,
  startNetworkTelemetryMonitor,
} from '../../src/observability/network-telemetry.js';

const originalFetch = globalThis.fetch;

function nativeLikeFetch(gate: Promise<void>, failWith?: Error): typeof fetch {
  const impl = async function fetch(): Promise<Response> {
    await gate;
    if (failWith) throw failWith;
    return new Response('ok', { status: 200, headers: { 'content-length': '2' } });
  };
  Object.defineProperty(impl, 'name', { value: 'fetch' });
  Object.defineProperty(impl, 'toString', {
    value: () => 'function fetch() { [native code] }',
  });
  return impl as unknown as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('network telemetry in-flight stop', () => {
  it('drops a Bun fetch that settles after the last monitor stops', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    globalThis.fetch = nativeLikeFetch(gate);
    const events = new EventBus();
    const names: string[] = [];
    events.on('network.request.started', () => void names.push('started'));
    events.on('network.request.completed', () => void names.push('completed'));
    const stop = startNetworkTelemetryMonitor();
    try {
      const pending = runWithNetworkTelemetry(
        { events, sessionId: 'sess', initiator: 'tool', operationName: 'fetch' },
        () => globalThis.fetch('https://example.test/resource'),
      );
      await Promise.resolve();
      expect(names).toEqual(['started']);
      stop();
      release();
      await pending;
      expect(names).toEqual(['started']);
    } finally {
      stop();
    }
  });

  it('still publishes when the fetch settles before stop, and when another monitor remains', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    globalThis.fetch = nativeLikeFetch(gate);
    const events = new EventBus();
    const names: string[] = [];
    events.on('network.request.completed', () => void names.push('completed'));
    const stopEarly = startNetworkTelemetryMonitor();
    const stopLate = startNetworkTelemetryMonitor();
    try {
      const pending = runWithNetworkTelemetry(
        { events, sessionId: 'sess', initiator: 'tool', operationName: 'fetch' },
        () => globalThis.fetch('https://example.test/resource'),
      );
      await Promise.resolve();
      stopEarly();
      release();
      await pending;
      expect(names).toEqual(['completed']);
    } finally {
      stopEarly();
      stopLate();
    }
  });
});
