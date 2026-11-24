/**
 * The HQ listener: plain HTTP, or HTTPS when PEM material is configured
 * (`--tls-cert` / `--tls-key`, read by `tls-input.ts`). The WebSocket server
 * attaches through the same `upgrade` event either way, so `/ws/browser` and
 * `/ws/client` become WSS with no further change.
 *
 * TLS also turns on Secure cookies, clears the "without TLS" exposure warning,
 * and lets the key vault accept operator changes from any address.
 */
import * as http from 'node:http';
import * as https from 'node:https';

export interface HqTlsMaterial {
  cert: string | Buffer;
  key: string | Buffer;
}

export function createHqHttpServer(
  tls: HqTlsMaterial | undefined,
  onRequest: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): http.Server {
  return tls
    ? https.createServer({ cert: tls.cert, key: tls.key }, onRequest)
    : http.createServer(onRequest);
}

/** The origin a client on this machine uses to reach HQ. */
export function hqLocalOrigin(host: string, port: number, tls: boolean): string {
  return `${tls ? 'https' : 'http'}://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`;
}
