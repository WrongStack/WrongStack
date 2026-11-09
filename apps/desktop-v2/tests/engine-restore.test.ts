import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { restoreEngineSession } from '../engine/restore-session';

const servers: WebSocketServer[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          for (const socket of server.clients) socket.terminate();
          server.close(() => resolve());
        }),
    ),
  );
});
async function peer(replay: boolean, success: boolean, legacy = false) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const requests: unknown[] = [];
  server.on('connection', (socket, request) => {
    expect(new URL(request.url ?? '', 'http://localhost').searchParams.get('token')).toBe(
      'private',
    );
    socket.on('message', (data) => {
      const frame = JSON.parse(String(data));
      requests.push(frame);
      socket.send(
        JSON.stringify({
          type: 'key.operation_result',
          payload: { requestId: 'foreign', success: false },
        }),
      );
      if (replay)
        socket.send(
          JSON.stringify({
            type: 'session.start',
            payload: { sessionId: 'recorded', reset: true },
          }),
        );
      socket.send(
        JSON.stringify({
          type: 'key.operation_result',
          payload: {
            ...(legacy ? {} : { requestId: frame.payload.requestId }),
            success,
            message: 'Ownership refused',
          },
        }),
      );
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('Missing test port');
  return { port: address.port, requests };
}
describe('private engine history bootstrap', () => {
  it('accepts a legacy acknowledgement only on its dedicated single-request connection', async () => {
    const server = await peer(true, true, true);
    await restoreEngineSession(server.port, 'private', 'recorded');
    expect(server.requests).toHaveLength(1);
  });
  it('requires the requested replay and correlated acknowledgement without sending a prompt', async () => {
    const server = await peer(true, true);
    await restoreEngineSession(server.port, 'private', 'recorded');
    expect(server.requests).toEqual([
      { type: 'session.resume', payload: { id: 'recorded', requestId: expect.any(String) } },
    ]);
  });
  it('refuses ownership failures and a success without a verified replay', async () => {
    const refused = await peer(false, false);
    await expect(restoreEngineSession(refused.port, 'private', 'recorded')).rejects.toThrow(
      'Ownership refused',
    );
    const incomplete = await peer(false, true);
    await expect(restoreEngineSession(incomplete.port, 'private', 'recorded')).rejects.toThrow(
      'replay was not verified',
    );
  });
  it('trims padded session ids and tokens and rejects invalid arguments early (F104)', async () => {
    const server = await peer(true, true);
    await restoreEngineSession(server.port, ' private ', ' recorded ');
    expect(server.requests).toEqual([
      { type: 'session.resume', payload: { id: 'recorded', requestId: expect.any(String) } },
    ]);
    await expect(restoreEngineSession(0, 'private', 'recorded')).rejects.toThrow(
      'requires a valid',
    );
    await expect(restoreEngineSession(server.port, '   ', 'recorded')).rejects.toThrow(
      'requires a valid',
    );
    await expect(restoreEngineSession(server.port, 'private', '   ')).rejects.toThrow(
      'requires a valid',
    );
  });
});
