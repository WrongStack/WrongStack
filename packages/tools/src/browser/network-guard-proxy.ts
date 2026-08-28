import * as http from 'node:http';
import * as net from 'node:net';
import type { Duplex } from 'node:stream';
import type { BrowserDnsLookup } from './security.js';
import { resolvePinnedBrowserTarget } from './security.js';

interface BrowserNetworkGuardProxyOptions {
  allowPrivateHosts?: boolean | undefined;
  allowedPrivateOrigins?: readonly string[] | undefined;
  lookup?: BrowserDnsLookup | undefined;
  connectTimeoutMs?: number | undefined;
}

/** Local HTTP proxy that pins every browser socket to its validated DNS answer. */
export class BrowserNetworkGuardProxy {
  private readonly server: http.Server;
  private readonly sockets = new Set<net.Socket>();
  private startPromise?: Promise<string> | undefined;
  private url?: string | undefined;

  constructor(private readonly options: BrowserNetworkGuardProxyOptions = {}) {
    this.server = http.createServer((request, response) => {
      void this.forwardHttp(request, response);
    });
    this.server.on('connect', (request, socket, head) => {
      void this.forwardConnect(request, socket, head);
    });
    this.server.on('upgrade', (request, socket, head) => {
      void this.forwardUpgrade(request, socket, head);
    });
    this.server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
      // Browsers routinely abort speculative/idle connections. On Windows
      // that can surface as an asynchronous ECONNABORTED from a pipe write.
      // A Server's `clientError` event only covers HTTP parser failures; once
      // a socket becomes a CONNECT/WebSocket tunnel, an unhandled socket
      // `error` would otherwise terminate the entire host process.
      socket.on('error', () => {
        socket.destroy();
      });
    });
    this.server.on('clientError', (_error, socket) => {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    });
  }

  async start(): Promise<string> {
    if (this.url) return this.url;
    if (this.startPromise) return this.startPromise;
    this.startPromise = new Promise<string>((resolve, reject) => {
      const onError = (error: Error) => {
        this.server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        this.server.off('error', onError);
        const address = this.server.address();
        if (!address || typeof address === 'string') {
          reject(new Error('browser: network guard proxy failed to bind'));
          return;
        }
        this.url = `http://127.0.0.1:${address.port}`;
        resolve(this.url);
      };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(0, '127.0.0.1');
    }).finally(() => {
      this.startPromise = undefined;
    });
    return this.startPromise;
  }

  async close(): Promise<void> {
    this.url = undefined;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (!this.server.listening) return;
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async forwardHttp(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    try {
      const target = await this.resolve(request.url ?? '');
      if (target.url.protocol !== 'http:') throw new Error('browser: HTTPS must use CONNECT');
      const headers = sanitizeHeaders(request.headers);
      headers.host = target.url.host;
      const upstream = http.request({
        host: target.address,
        family: target.family,
        port: Number(target.url.port || 80),
        method: request.method,
        path: `${target.url.pathname}${target.url.search}`,
        headers,
        agent: false,
      });
      upstream.setTimeout(this.options.connectTimeoutMs ?? 30_000, () => {
        upstream.destroy(new Error('browser: upstream connection timed out'));
      });
      upstream.on('response', (upstreamResponse) => {
        response.writeHead(
          upstreamResponse.statusCode ?? 502,
          sanitizeHeaders(upstreamResponse.headers),
        );
        upstreamResponse.pipe(response);
      });
      upstream.on('error', () => writeProxyError(response, 502, 'Bad Gateway'));
      request.on('aborted', () => upstream.destroy());
      request.pipe(upstream);
    } catch (error) {
      writeProxyError(response, 403, policyBlockMessage(error));
    }
  }

  private async forwardConnect(
    request: http.IncomingMessage,
    client: Duplex,
    head: Buffer,
  ): Promise<void> {
    try {
      const authority = request.url ?? '';
      const target = await this.resolve(`https://${authority}`);
      const upstream = net.connect({
        host: target.address,
        family: target.family,
        port: Number(target.url.port || 443),
      });
      upstream.setTimeout(this.options.connectTimeoutMs ?? 30_000, () => upstream.destroy());
      const onConnectError = () => {
        client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
      };
      upstream.once('error', onConnectError);
      upstream.once('connect', () => {
        upstream.off('error', onConnectError);
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length > 0) upstream.write(head);
        pipeDuplexPair(upstream, client);
      });
      client.once('close', () => upstream.destroy());
    } catch (error) {
      client.end(rawForbiddenResponse(policyBlockMessage(error)));
    }
  }

  private async forwardUpgrade(
    request: http.IncomingMessage,
    client: Duplex,
    head: Buffer,
  ): Promise<void> {
    let upstream: http.ClientRequest | undefined;
    try {
      const rawUrl = request.url ?? '';
      const websocketUrl = new URL(rawUrl);
      if (websocketUrl.protocol !== 'ws:') {
        throw new Error('browser: only plain ws upgrades are handled by the HTTP proxy');
      }
      websocketUrl.protocol = 'http:';
      const target = await this.resolve(websocketUrl.toString());
      const headers = sanitizeHeaders(request.headers, true);
      headers.host = target.url.host;
      upstream = http.request({
        host: target.address,
        family: target.family,
        port: Number(target.url.port || 80),
        method: request.method,
        path: `${target.url.pathname}${target.url.search}`,
        headers,
        agent: false,
      });
      upstream.once('upgrade', (response, upstreamSocket, upstreamHead) => {
        writeRawResponseHead(client, response);
        if (head.length > 0) upstreamSocket.write(head);
        if (upstreamHead.length > 0) client.write(upstreamHead);
        pipeDuplexPair(upstreamSocket, client);
        client.once('close', () => upstreamSocket.destroy());
      });
      upstream.once('response', (response) => {
        writeRawResponseHead(client, response);
        response.once('error', () => client.destroy());
        response.pipe(client);
      });
      upstream.once('error', () => {
        client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
      });
      client.once('close', () => upstream?.destroy());
      upstream.end();
    } catch (error) {
      upstream?.destroy();
      client.end(rawForbiddenResponse(policyBlockMessage(error)));
    }
  }

  private resolve(rawUrl: string) {
    return resolvePinnedBrowserTarget(rawUrl, {
      allowPrivateHosts: this.options.allowPrivateHosts,
      allowedPrivateOrigins: this.options.allowedPrivateOrigins,
      lookup: this.options.lookup,
    });
  }
}

/**
 * Couple both directions of a raw tunnel. `pipe()` deliberately does not
 * forward stream errors, so each destination needs its own listener before
 * either side can write. Destroying the peer also stops the opposite pipe and
 * prevents a disconnected browser socket from accumulating more writes.
 */
function pipeDuplexPair(left: Duplex, right: Duplex): void {
  left.on('error', () => right.destroy());
  right.on('error', () => left.destroy());
  left.pipe(right);
  right.pipe(left);
}

function sanitizeHeaders(
  headers: http.IncomingHttpHeaders,
  preserveUpgrade = false,
): http.OutgoingHttpHeaders {
  const sanitized: http.OutgoingHttpHeaders = { ...headers };
  delete sanitized['proxy-authorization'];
  delete sanitized['proxy-connection'];
  if (!preserveUpgrade) delete sanitized.connection;
  return sanitized;
}

function writeRawResponseHead(client: Duplex, response: http.IncomingMessage): void {
  const status = response.statusCode ?? 502;
  const statusText = response.statusMessage ?? 'Bad Gateway';
  const lines = [`HTTP/1.1 ${status} ${statusText}`];
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    lines.push(`${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}`);
  }
  client.write(`${lines.join('\r\n')}\r\n\r\n`);
}

function writeProxyError(response: http.ServerResponse, status: number, message: string): void {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, { 'content-type': 'text/plain', connection: 'close' });
  response.end(message);
}

/**
 * Carry the guard's precise refusal reason (from security.ts assertions, e.g.
 * `browser: blocked private/loopback address "127.0.0.1"`) into the response
 * body so callers can see WHY the policy fired, while keeping the stable
 * "Blocked by browser network policy" prefix as the machine-greppable marker.
 */
function policyBlockMessage(error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  return reason
    ? `Blocked by browser network policy: ${reason}`
    : 'Blocked by browser network policy';
}

/** Raw 403 for CONNECT/upgrade sockets that never got an http.ServerResponse. */
function rawForbiddenResponse(message: string): string {
  return (
    'HTTP/1.1 403 Forbidden\r\n' +
    'Content-Type: text/plain\r\n' +
    `Content-Length: ${Buffer.byteLength(message)}\r\n` +
    'Connection: close\r\n\r\n' +
    message
  );
}
