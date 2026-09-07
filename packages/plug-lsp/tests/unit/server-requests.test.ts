import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { Connection } from '../../src/server/connection.js';

/**
 * A server-initiated request carries BOTH an id and a method, and the server
 * blocks until it is answered. TypeScript 7's native server registers a
 * configuration watcher during `initialized` and stalls every later request
 * when the client stays silent.
 */
function harness() {
  const toServer = new PassThrough();
  const fromServer = new PassThrough();
  const connection = new Connection(toServer, fromServer);
  const written: Record<string, unknown>[] = [];
  let buffer = '';
  toServer.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    for (;;) {
      const sep = buffer.indexOf('\r\n\r\n');
      if (sep === -1) return;
      const length = Number(/Content-Length:\s*(\d+)/i.exec(buffer.slice(0, sep))?.[1]);
      const body = buffer.slice(sep + 4, sep + 4 + length);
      if (body.length < length) return;
      buffer = buffer.slice(sep + 4 + length);
      written.push(JSON.parse(body) as Record<string, unknown>);
    }
  });
  const send = (message: unknown): void => {
    const body = JSON.stringify(message);
    fromServer.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  };
  const settled = (): Promise<void> => new Promise((r) => setImmediate(r));
  return { connection, written, send, settled };
}

describe('server-initiated requests', () => {
  it('accepts dynamic capability registration', async () => {
    const { written, send, settled } = harness();
    send({ jsonrpc: '2.0', id: 7, method: 'client/registerCapability', params: {} });
    await settled();
    expect(written).toEqual([{ jsonrpc: '2.0', id: 7, result: null }]);
  });

  it('answers workspace/configuration with one null per requested item', async () => {
    const { written, send, settled } = harness();
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'workspace/configuration',
      params: { items: [{ section: 'typescript' }, { section: 'javascript' }] },
    });
    await settled();
    expect(written[0]).toEqual({ jsonrpc: '2.0', id: 1, result: [null, null] });
  });

  it('declines server-pushed edits rather than dropping them', async () => {
    const { written, send, settled } = harness();
    send({ jsonrpc: '2.0', id: 2, method: 'workspace/applyEdit', params: { edit: {} } });
    await settled();
    expect(written[0]).toMatchObject({ id: 2, result: { applied: false } });
  });

  it('replies MethodNotFound for anything else, so the server never blocks', async () => {
    const { written, send, settled } = harness();
    send({ jsonrpc: '2.0', id: 3, method: 'window/showMessageRequest', params: {} });
    await settled();
    expect(written[0]).toMatchObject({ id: 3, error: { code: -32601 } });
  });

  it('still delivers the params to notification subscribers', async () => {
    const { connection, send, settled } = harness();
    const seen: unknown[] = [];
    connection.onNotification('client/registerCapability', (p) => seen.push(p));
    send({ jsonrpc: '2.0', id: 4, method: 'client/registerCapability', params: { a: 1 } });
    await settled();
    expect(seen).toEqual([{ a: 1 }]);
  });

  it('leaves plain notifications alone — answering one would be a protocol error', async () => {
    const { written, send, settled } = harness();
    send({ jsonrpc: '2.0', method: 'window/logMessage', params: { message: 'hi' } });
    await settled();
    expect(written).toEqual([]);
  });

  it('treats a configuration request with no items as an empty result', async () => {
    const { written, send, settled } = harness();
    send({ jsonrpc: '2.0', id: 5, method: 'workspace/configuration', params: {} });
    await settled();
    expect(written[0]).toEqual({ jsonrpc: '2.0', id: 5, result: [] });
  });

  it('writes nothing once the connection is closed', async () => {
    const { connection, written, send, settled } = harness();
    connection.close();
    send({ jsonrpc: '2.0', id: 6, method: 'client/registerCapability', params: {} });
    await settled();
    expect(written).toEqual([]);
  });
});
