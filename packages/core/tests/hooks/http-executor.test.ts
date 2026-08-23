import { createServer, type RequestListener, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { runHttpHookDetailed } from '../../src/hooks/http-executor.js';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

async function listen(handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing test server address');
  return `http://127.0.0.1:${address.port}/hook`;
}

describe('runHttpHookDetailed', () => {
  it('POSTs HookInput and parses a mutate outcome', async () => {
    let received = '';
    const url = await listen((request, response) => {
      request.setEncoding('utf8');
      request.on('data', (chunk) => (received += chunk));
      request.on('end', () => {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ action: 'mutate', input: { command: 'safe' } }));
      });
    });
    const result = await runHttpHookDetailed(
      { url, timeoutMs: 1_000 },
      { event: 'PreToolUse', toolName: 'bash', toolInput: { command: 'unsafe' }, cwd: '/tmp' },
    );
    expect(result.failure).toBeUndefined();
    expect(result.outcome).toEqual({ action: 'mutate', input: { command: 'safe' } });
    expect(JSON.parse(received)).toMatchObject({ event: 'PreToolUse', toolName: 'bash' });
  });

  it('reports non-2xx responses as transport failures', async () => {
    const url = await listen((_request, response) => {
      response.statusCode = 503;
      response.end('unavailable');
    });
    const result = await runHttpHookDetailed({ url }, { event: 'PreToolUse', cwd: '/tmp' });
    expect(result.failure?.kind).toBe('error');
  });

  it('rejects cleartext non-loopback endpoints', async () => {
    const result = await runHttpHookDetailed(
      { url: 'http://example.com/hook' },
      { event: 'PreToolUse', cwd: '/tmp' },
    );
    expect(result.failure?.kind).toBe('rejected');
  });
});
