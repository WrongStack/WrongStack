import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { EventBus } from '../../src/kernel/events.js';
import {
  runWithNetworkTelemetry,
  startNetworkTelemetryMonitor,
} from '../../src/observability/network-telemetry.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

describe('network telemetry', () => {
  it('correlates fetch lifecycle while removing path and query values', async () => {
    const server = createServer((_request, response) => {
      response.setHeader('content-length', '2');
      response.end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing address');
    const events = new EventBus();
    const captured: unknown[] = [];
    const offStarted = events.on('network.request.started', (event) => captured.push(event));
    const offCompleted = events.on('network.request.completed', (event) => captured.push(event));
    cleanup.push(offStarted, offCompleted, startNetworkTelemetryMonitor());
    await runWithNetworkTelemetry(
      {
        events,
        sessionId: 's',
        traceId: 't',
        toolCallId: 'tc',
        initiator: 'tool',
        operationName: 'fetch',
      },
      () =>
        fetch(`http://127.0.0.1:${address.port}/private/path?token=secret&limit=2`).then(
          (response) => response.text(),
        ),
    );
    expect(captured).toHaveLength(2);
    expect(captured[0]).toMatchObject({
      sessionId: 's',
      traceId: 't',
      toolCallId: 'tc',
      method: 'GET',
      serverAddress: '127.0.0.1',
      queryKeys: ['token', 'limit'],
    });
    expect(captured[1]).toMatchObject({ statusCode: 200, responseBytes: 2 });
    expect(JSON.stringify(captured)).not.toContain('private/path');
    expect(JSON.stringify(captured)).not.toContain('secret');
  });
});
