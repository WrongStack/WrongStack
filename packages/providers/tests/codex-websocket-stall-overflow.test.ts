import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { CodexWebSocketConnection } from '../src/codex-websocket-connection.js';

class FakeWs extends EventEmitter {
  readyState = 1;
  constructor() {
    super();
    queueMicrotask(() => this.emit('open'));
  }
  send() {
    setTimeout(() => {
      this.emit(
        'message',
        Buffer.from(JSON.stringify({ type: 'response.completed', response: { id: 'r1' } })),
      );
    }, 30);
  }
  close() {}
}

describe('CodexWebSocketConnection stallTimeoutMs clamping (F386)', () => {
  it('clamps stallTimeoutMs above 32-bit signed max instead of stalling in 1ms', async () => {
    const conn = new CodexWebSocketConnection(
      () => new FakeWs() as never,
      'wss://example.com/ws',
      {},
    );

    const events: unknown[] = [];
    for await (const ev of conn.stream(
      { model: 'gpt-5', input: [] },
      {
        request: { model: 'gpt-5', messages: [] },
        fallbackModel: 'gpt-5',
        providerId: 'openai',
        signal: new AbortController().signal,
        stallTimeoutMs: 3_000_000_000,
      },
      async function* (bodyStream) {
        const reader = bodyStream.getReader();
        while (!(await reader.read()).done) {
          // drain
        }
        yield { type: 'message_end' } as never;
      },
    )) {
      events.push(ev);
    }

    expect(events.length).toBe(1);
  });
});
