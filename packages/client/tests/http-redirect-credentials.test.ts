import { createServer, type Server } from 'node:http';
import { expect, it } from 'vitest';
import { WrongStackError } from '../src/errors.js';
import { createHttpClient } from '../src/http.js';

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP listener');
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

it.each([
  { status: 301, operation: 'GET', auth: 'option' },
  { status: 302, operation: 'GET', auth: 'option' },
  { status: 303, operation: 'GET', auth: 'option' },
  { status: 307, operation: 'GET', auth: 'option' },
  { status: 308, operation: 'GET', auth: 'option' },
  { status: 307, operation: 'POST', auth: 'option' },
  { status: 308, operation: 'POST', auth: 'option' },
  { status: 307, operation: 'GET', auth: 'url' },
])('refuses HTTP $status on $operation with $auth authentication', async (testCase) => {
  const token = 'test';
  const expected = testCase.operation === 'GET' ? [] : { ok: true, delivered: 'active' };
  let forwardedRequests = 0;
  let authenticatedOriginRequests = 0;
  let redirect = false;
  let destination = '';
  const receiver = createServer((_req, res) => {
    forwardedRequests++;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(expected));
  });
  const origin = createServer((req, res) => {
    if (req.headers['x-ws-token'] === token) authenticatedOriginRequests++;
    if (redirect) {
      res.writeHead(testCase.status, { Location: `${destination}/capture` }).end();
    } else {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(expected));
    }
  });
  try {
    destination = await listen(receiver);
    const url = await listen(origin);
    const api = createHttpClient(
      testCase.auth === 'url' ? { url: `${url}/?token=test` } : { url, token },
    );
    const call = () =>
      testCase.operation === 'GET'
        ? api.listLiveSessions()
        : api.messageSession('session_1', { text: 'private fixture message' });

    // The configured server must still receive authentication normally.
    expect(await call()).toEqual(expected);
    expect(authenticatedOriginRequests).toBe(1);
    redirect = true;
    const error = await call().then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(authenticatedOriginRequests).toBe(2);
    // Zero follow-up requests protects both credentials and POST bodies.
    expect(forwardedRequests).toBe(0);
    expect(error).toBeInstanceOf(WrongStackError);
    expect(error).toMatchObject({ kind: 'connection' });
  } finally {
    await Promise.all([close(origin), close(receiver)]);
  }
});
