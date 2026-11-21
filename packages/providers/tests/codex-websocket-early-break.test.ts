import { EventEmitter } from 'node:events';
import type { StreamEvent } from '@wrongstack/contracts/types';
import { describe, expect, it } from 'vitest';
import { type CodexWebSocketLike, CodexWebSocketPool } from '../src/codex-websocket.js';
import { CodexWebSocketConnection } from '../src/codex-websocket-connection.js';

class FakeSocket extends EventEmitter implements CodexWebSocketLike {
  readyState = 1;
  sent: string[] = [];
  closed = false;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
    this.emit('close');
  }
}

async function* fakeParse(body: ReadableStream<Uint8Array>): AsyncIterable<StreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      for (const chunk of buf.split('\n\n')) {
        if (!chunk.startsWith('data: ')) continue;
        const msg = JSON.parse(chunk.slice(6)) as { type?: string; text?: string };
        if (msg.type === 'delta' && typeof msg.text === 'string') {
          yield { type: 'text_delta', text: msg.text } as StreamEvent;
        }
      }
      buf = '';
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function makeOpts(sessionId: string, prompt: string) {
  return {
    url: 'wss://example.test/codex',
    headers: { 'x-codex-routing-hint': 'gpt-5' },
    body: { input: [{ role: 'user', content: prompt }] },
    request: { model: 'gpt-5', messages: [], cache: { sessionId } } as never,
    fallbackModel: 'gpt-5',
    providerId: 'openai-codex',
    signal: new AbortController().signal,
    prewarm: false,
    stallTimeoutMs: 5_000,
  };
}

describe('CodexWebSocketPool early consumer break (F936)', () => {
  it('closes and evicts an abandoned mid-response socket so stale frames cannot bleed into the next turn', async () => {
    const sockets: FakeSocket[] = [];
    const pool = new CodexWebSocketPool(() => {
      const sock = new FakeSocket();
      sockets.push(sock);
      queueMicrotask(() => sock.emit('open'));
      const origSend = sock.send.bind(sock);
      sock.send = (data: string) => {
        origSend(data);
        const idx = sockets.length;
        queueMicrotask(() => {
          if (idx === 1) {
            sock.emit('message', JSON.stringify({ type: 'delta', text: 'req1-part1' }));
          } else {
            sock.emit('message', JSON.stringify({ type: 'delta', text: 'req2-clean' }));
            sock.emit(
              'message',
              JSON.stringify({ type: 'response.completed', response: { id: 'r2' } }),
            );
          }
        });
      };
      return sock;
    });

    for await (const ev of pool.stream(makeOpts('sess-1', 'first'), fakeParse)) {
      if (ev.type === 'text_delta') break;
    }

    expect(sockets[0]?.closed).toBe(true);

    const req2: string[] = [];
    for await (const ev of pool.stream(makeOpts('sess-1', 'second'), fakeParse)) {
      if (ev.type === 'text_delta') req2.push(ev.text);
    }

    expect(sockets).toHaveLength(2);
    expect(req2).toEqual(['req2-clean']);
    pool.close();
  });

  it('closes direct CodexWebSocketConnection sockets on early break before terminal frame', async () => {
    let directSock: FakeSocket | undefined;
    const conn = new CodexWebSocketConnection(
      () => {
        const s = new FakeSocket();
        directSock = s;
        queueMicrotask(() => s.emit('open'));
        const origSend = s.send.bind(s);
        s.send = (data: string) => {
          origSend(data);
          queueMicrotask(() =>
            s.emit('message', JSON.stringify({ type: 'delta', text: 'partial' })),
          );
        };
        return s;
      },
      'wss://example.test/codex',
      { 'x-codex-routing-hint': 'gpt-5' },
    );

    const opts = makeOpts('direct', 'hello');
    for await (const ev of conn.stream(opts.body, opts, fakeParse)) {
      if (ev.type === 'text_delta') break;
    }

    expect(directSock?.closed).toBe(true);
  });
});
