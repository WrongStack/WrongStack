import { WebSocket } from 'ws';

/**
 * Wraps a WebSocket with a buffered message queue. The `'message'` listener is
 * attached at construction — *before* `'open'` — so the server's immediate
 * `session.start` (sent synchronously inside the connection handler, arriving
 * in the same TCP batch as the handshake) is buffered rather than dropped.
 * Mirrors how a real frontend client sets `onmessage` before the socket opens.
 *
 * Shared between fleet and redaction WebUI server tests.
 */
export interface WsClient {
  ws: WebSocket;
  waitForMessage(type: string, predicate?: (m: WsMessage) => boolean): Promise<WsMessage>;
}

type WsMessage = { type?: string | undefined; [key: string]: unknown };

export function openWs(url: string): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const portSuffix = parsed.port ? `:${parsed.port}` : '';
    const origin = `http://localhost${portSuffix}`;
    const ws = new WebSocket(url, { headers: { Origin: origin } });
    const buffer: WsMessage[] = [];
    const waiters: Array<{
      type: string;
      predicate: ((m: WsMessage) => boolean) | undefined;
      resolve: (m: WsMessage) => void;
    }> = [];

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as WsMessage;
      const idx = waiters.findIndex(
        (w) => w.type === msg.type && (!w.predicate || w.predicate(msg)),
      );
      if (idx >= 0) waiters.splice(idx, 1)[0]?.resolve(msg);
      else buffer.push(msg);
    });

    const waitForMessage = (
      type: string,
      predicate?: (m: WsMessage) => boolean,
    ): Promise<WsMessage> =>
      new Promise((res, rej) => {
        const idx = buffer.findIndex((m) => m.type === type && (!predicate || predicate(m)));
        if (idx >= 0) {
          res(buffer.splice(idx, 1)[0]!);
          return;
        }
        const timer = setTimeout(() => rej(new Error(`timed out waiting for ${type}`)), 5_000);
        waiters.push({
          type,
          predicate,
          resolve: (m) => {
            clearTimeout(timer);
            res(m);
          },
        });
      });

    ws.once('open', () => resolve({ ws, waitForMessage }));
    ws.once('error', reject);
  });
}
