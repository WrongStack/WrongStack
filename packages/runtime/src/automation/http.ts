import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeTokenEqual } from '@wrongstack/primitives';
import { ingestGitHubEvent } from './github.js';
import { AutomationPayloadTooLarge, handleAutomationManagement } from './management.js';
import type { AutomationService } from './service.js';
import { AutomationRevisionConflict } from './store.js';

function authorized(value: string | undefined, token: string): boolean {
  return timingSafeTokenEqual(value, `Bearer ${token}`);
}
async function readBody(request: IncomingMessage): Promise<Buffer> {
  const parts: Buffer[] = [];
  let bytes = 0;
  let tooLarge = false;
  for await (const part of request) {
    const buffer = Buffer.isBuffer(part) ? part : Buffer.from(part);
    bytes += buffer.length;
    if (bytes > 128 * 1024) {
      tooLarge = true;
      parts.length = 0;
      if (bytes > 512 * 1024) break;
      continue;
    }
    parts.push(buffer);
  }
  if (tooLarge) throw new AutomationPayloadTooLarge();
  return Buffer.concat(parts);
}
function reply(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(value));
}

/** Local control plane. GitHub ingress uses its own HMAC, all control calls a bearer token. */
export function createAutomationServer(
  service: AutomationService,
  token: string,
  profileConfig?: (profile: string) => string,
): Server {
  if (token.length < 32)
    throw new Error('Automation API token must contain at least 32 characters');
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (request.method === 'GET' && url.pathname === '/healthz') {
        reply(response, 200, { ok: true, workerId: service.workerId });
        return;
      }
      const webhook = /^\/hooks\/([a-f0-9-]{36})\/github$/.exec(url.pathname);
      if (webhook && request.method === 'POST') {
        const run = await ingestGitHubEvent(service.store, webhook[1]!, await readBody(request), {
          signature:
            typeof request.headers['x-hub-signature-256'] === 'string'
              ? request.headers['x-hub-signature-256']
              : undefined,
          delivery:
            typeof request.headers['x-github-delivery'] === 'string'
              ? request.headers['x-github-delivery']
              : undefined,
          event:
            typeof request.headers['x-github-event'] === 'string'
              ? request.headers['x-github-event']
              : undefined,
        });
        reply(response, run ? 202 : 200, { runId: run?.id ?? null });
        return;
      }
      if (!authorized(request.headers.authorization, token)) {
        reply(response, 401, { error: 'Unauthorized' });
        return;
      }
      if (
        url.pathname !== '/v1/state' &&
        (await handleAutomationManagement(
          request,
          response,
          url,
          service.store,
          (id) => service.cancel(id),
          undefined,
          profileConfig,
        ))
      )
        return;
      if (request.method === 'GET' && url.pathname === '/v1/state') {
        reply(response, 200, {
          ...(await service.store.snapshot()),
          workerError: service.lastError,
        });
        return;
      }
      reply(response, 404, { error: 'Not found' });
    })().catch((error) => {
      const message = error instanceof Error ? error.message : 'Automation request failed';
      const status =
        error instanceof AutomationPayloadTooLarge
          ? 413
          : error instanceof AutomationRevisionConflict || /Delivery ID reused/.test(message)
            ? 409
            : /signature|trigger is unavailable|repository does not match/.test(message)
              ? 403
              : 400;
      if (!response.headersSent) reply(response, status, { error: message.slice(0, 256) });
      else response.end();
    });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 64;
  return server;
}
