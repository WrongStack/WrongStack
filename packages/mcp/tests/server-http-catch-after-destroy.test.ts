import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { handleHttpRequest } from '../src/server-http.js';

function makeReq(): IncomingMessage {
  return Object.assign(new EventEmitter(), {
    method: 'POST',
    headers: { host: '127.0.0.1:8080', 'content-type': 'application/json' },
    destroy() {},
  }) as unknown as IncomingMessage;
}

describe('handleHttpRequest catch guard after response end/destroy (F937)', () => {
  it('does not call writeHead(500) when handleMessage rejects after response is destroyed or headersSent', async () => {
    const req = makeReq();
    let writeHeadCalls = 0;
    const res = Object.assign(new EventEmitter(), {
      destroyed: true,
      headersSent: true,
      writableEnded: true,
      writeHead() {
        writeHeadCalls += 1;
        throw Object.assign(new Error('ERR_HTTP_HEADERS_SENT'), { code: 'ERR_HTTP_HEADERS_SENT' });
      },
      end() {},
    }) as unknown as ServerResponse;

    void handleHttpRequest(
      {
        handleMessage: async () => {
          throw new Error('aborted after disconnect');
        },
        validateHttpHeaders: async () => undefined,
      } as never,
      req,
      res,
      undefined,
      undefined,
      '127.0.0.1',
    );

    req.emit('data', Buffer.from('{"jsonrpc":"2.0","id":1,"method":"tools/call"}'));
    req.emit('end');
    await new Promise((r) => setTimeout(r, 25));

    expect(writeHeadCalls).toBe(0);
  });

  it('still sends HTTP 500 when handleMessage rejects on an open response', async () => {
    const req = makeReq();
    let status = 0;
    const res = Object.assign(new EventEmitter(), {
      destroyed: false,
      headersSent: false,
      writableEnded: false,
      writeHead(code: number) {
        status = code;
        (this as { headersSent: boolean }).headersSent = true;
      },
      end() {
        (this as { writableEnded: boolean }).writableEnded = true;
      },
    }) as unknown as ServerResponse;

    void handleHttpRequest(
      {
        handleMessage: async () => {
          throw new Error('boom');
        },
        validateHttpHeaders: async () => undefined,
      } as never,
      req,
      res,
      undefined,
      undefined,
      '127.0.0.1',
    );

    req.emit('data', Buffer.from('{"jsonrpc":"2.0","id":2,"method":"tools/call"}'));
    req.emit('end');
    await new Promise((r) => setTimeout(r, 25));

    expect(status).toBe(500);
  });
});
