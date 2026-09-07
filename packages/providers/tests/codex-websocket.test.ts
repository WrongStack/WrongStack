import type { Request, StreamEvent } from '@wrongstack/core/types';
import { describe, expect, it, vi } from 'vitest';
import {
  CodexWebSocketFallbackError,
  CodexWebSocketPool,
  defaultCodexWebSocketFactory,
  type CodexWebSocketLike,
} from '../src/codex-websocket.js';
import { OpenAICodexProvider, parseOpenAIResponsesStream } from '../src/openai-codex.js';

// Capture what the default factory hands to the real `ws` transport without
// opening sockets. Every other case in this suite injects its own factory, so
// this mock never affects them.
const wsConstructCalls = vi.hoisted(
  () => [] as Array<{ url: string; options: Record<string, unknown> }>,
);
vi.mock('ws', () => ({
  default: class {
    readyState = 0;
    constructor(url: string, options: Record<string, unknown>) {
      wsConstructCalls.push({ url, options });
    }
    on(): this {
      return this;
    }
    once(): this {
      return this;
    }
    removeListener(): this {
      return this;
    }
    send(): void {}
    close(): void {}
  },
}));

class FakeSocket implements CodexWebSocketLike {
  readyState = 0;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Array<(...args: any[]) => void>>();

  constructor(private readonly onSend: (socket: FakeSocket, payload: string) => void) {
    queueMicrotask(() => {
      this.readyState = 1;
      this.emit('open');
    });
  }

  send(data: string): void {
    this.sent.push(data);
    this.onSend(this, data);
  }

  closeCount = 0;
  close(): void {
    this.closeCount++;
    this.readyState = 3;
    this.emit('close');
  }

  on(event: string, listener: (...args: any[]) => void): this {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }

  once(event: string, listener: (...args: any[]) => void): this {
    const wrapped = (...args: any[]) => {
      this.removeListener(event, wrapped);
      listener(...args);
    };
    return this.on(event, wrapped);
  }

  removeListener(event: string, listener: (...args: any[]) => void): this {
    const list = this.listeners.get(event) ?? [];
    this.listeners.set(event, list.filter((entry) => entry !== listener));
    return this;
  }

  emit(event: string, ...args: any[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
  }

  message(payload: Record<string, unknown>): void {
    this.emit('message', JSON.stringify(payload));
  }

  fail(error = new Error('socket failed')): void {
    this.emit('error', error);
  }
}

const request = (sessionId: string): Request => ({
  model: 'gpt-5-codex',
  messages: [{ role: 'user', content: 'hi' }],
  cache: { sessionId },
});

const body = { model: 'gpt-5-codex', stream: true, store: false };
const headers = { authorization: 'Bearer test' };

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const result: StreamEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

function sseBody(events: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(events);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function options(sessionId: string, prewarm = false) {
  return {
    url: 'wss://chatgpt.com/backend-api/codex/responses',
    headers,
    request: request(sessionId),
    body,
    fallbackModel: 'gpt-5-codex',
    providerId: 'openai-codex',
    signal: new AbortController().signal,
    prewarm,
  };
}

describe('Codex WebSocket Responses transport', () => {
  it('reuses one connection for sequential requests in one session', async () => {
    const sockets: FakeSocket[] = [];
    let connectedUrl = '';
    let connectedHeaders: Record<string, string> | undefined;
    const pool = new CodexWebSocketPool((url, connectionOptions) => {
      connectedUrl = url;
      connectedHeaders = connectionOptions.headers;
      const socket = new FakeSocket((current) => {
        current.message({ type: 'response.created', response: { model: 'gpt-5-codex' } });
        current.message({ type: 'response.output_text.delta', delta: 'ok' });
        current.message({ type: 'response.completed', response: { status: 'completed' } });
      });
      sockets.push(socket);
      return socket;
    });

    await collect(pool.stream(options('same'), parseOpenAIResponsesStream));
    await collect(pool.stream(options('same'), parseOpenAIResponsesStream));

    expect(sockets).toHaveLength(1);
    expect(sockets[0]?.sent).toHaveLength(2);
    expect(connectedUrl).toBe('wss://chatgpt.com/backend-api/codex/responses');
    expect(connectedHeaders?.authorization).toBe('Bearer test');
    expect(JSON.parse(sockets[0]?.sent[0] ?? '{}')).toMatchObject({
      type: 'response.create',
      model: 'gpt-5-codex',
      stream: true,
      store: false,
    });
  });

  it('prewarms a connection and sends previous_response_id on the real turn', async () => {
    const frames: Array<Record<string, unknown>> = [];
    const pool = new CodexWebSocketPool((_url, _options) =>
      new FakeSocket((socket, raw) => {
        const frame = JSON.parse(raw) as Record<string, unknown>;
        frames.push(frame);
        if (frames.length === 1) {
          socket.message({ type: 'response.created', response: { id: 'resp-prewarm' } });
          socket.message({ type: 'response.done', response: { id: 'resp-prewarm' } });
        } else {
          socket.message({ type: 'response.created', response: { id: 'resp-real', model: 'gpt-5-codex' } });
          socket.message({ type: 'response.output_text.delta', delta: 'ok' });
          socket.message({ type: 'response.completed', response: { id: 'resp-real', status: 'completed' } });
        }
      }),
    );

    await collect(pool.stream(options('prewarm', true), parseOpenAIResponsesStream));

    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({
      type: 'response.create',
      input: [],
      generate: false,
      stream: true,
      store: false,
    });
    expect(frames[1]).toMatchObject({
      type: 'response.create',
      previous_response_id: 'resp-prewarm',
    });
  });

  it('reconnects after a closed socket without replaying stale response ids', async () => {
    const sockets: FakeSocket[] = [];
    const frames: Array<Record<string, unknown>> = [];
    const pool = new CodexWebSocketPool((_url, _options) => {
      const socket = new FakeSocket((current, raw) => {
        frames.push(JSON.parse(raw) as Record<string, unknown>);
        current.message({ type: 'response.created', response: { id: `resp-${sockets.length}` } });
        current.message({ type: 'response.completed', response: { status: 'completed' } });
        queueMicrotask(() => current.close());
      });
      sockets.push(socket);
      return socket;
    });

    await collect(pool.stream(options('reconnect'), parseOpenAIResponsesStream));
    await collect(pool.stream(options('reconnect'), parseOpenAIResponsesStream));

    expect(sockets).toHaveLength(2);
    expect(frames[0]).not.toHaveProperty('previous_response_id');
    expect(frames[1]).not.toHaveProperty('previous_response_id');
  });

  it('does not share connections between sessions and evicts bounded entries', async () => {
    const sockets: FakeSocket[] = [];
    const pool = new CodexWebSocketPool(
      (_url, _options) => {
        const socket = new FakeSocket((current) => {
          current.message({ type: 'response.created', response: { model: 'gpt-5-codex' } });
          current.message({ type: 'response.completed', response: { status: 'completed' } });
        });
        sockets.push(socket);
        return socket;
      },
      1,
    );

    await collect(pool.stream(options('one'), parseOpenAIResponsesStream));
    await collect(pool.stream(options('two'), parseOpenAIResponsesStream));
    await collect(pool.stream(options('one'), parseOpenAIResponsesStream));

    expect(sockets).toHaveLength(3);
  });

  it('marks a pre-output socket failure as safe for SSE fallback', async () => {
    const pool = new CodexWebSocketPool((_url, _options) => {
      return new FakeSocket((socket) => queueMicrotask(() => socket.fail()));
    });

    await expect(collect(pool.stream(options('fallback'), parseOpenAIResponsesStream))).rejects.toBeInstanceOf(
      CodexWebSocketFallbackError,
    );
  });

  it('does not allow fallback after partial output, preventing duplicates', async () => {
    const pool = new CodexWebSocketPool((_url, _options) => {
      return new FakeSocket((socket) => {
        socket.message({ type: 'response.created', response: { model: 'gpt-5-codex' } });
        socket.message({ type: 'response.output_text.delta', delta: 'partial' });
        queueMicrotask(() => socket.close());
      });
    });

    await expect(collect(pool.stream(options('partial'), parseOpenAIResponsesStream))).rejects.toMatchObject({
      providerId: 'openai-codex',
      retryable: true,
    });
  });

  it('falls back to SSE only when WebSocket fails before output', async () => {
    let fetchCalls = 0;
    const provider = new OpenAICodexProvider({
      credentials: { accessToken: 'token' },
      webSocket: true,
      webSocketFactory: () => new FakeSocket((socket) => queueMicrotask(() => socket.fail())),
      fetchImpl: (async () => {
        fetchCalls++;
        return new Response(
          sseBody(
            'data: {"type":"response.created","response":{"model":"gpt-5-codex"}}\n\n' +
              'data: {"type":"response.output_text.delta","delta":"sse"}\n\n' +
              'data: {"type":"response.completed","response":{"status":"completed"}}\n\n',
          ),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        );
      }) as typeof fetch,
    });

    const events = await collect(provider.stream(request('fallback-provider'), { signal: new AbortController().signal }));
    expect(events.some((event) => event.type === 'text_delta' && event.text === 'sse')).toBe(true);
    expect(fetchCalls).toBe(1);
  });

  it('does not retry through SSE after WebSocket output has started', async () => {
    let fetchCalls = 0;
    const provider = new OpenAICodexProvider({
      credentials: { accessToken: 'token' },
      webSocket: true,
      webSocketFactory: () =>
        new FakeSocket((socket) => {
          socket.message({ type: 'response.created', response: { model: 'gpt-5-codex' } });
          socket.message({ type: 'response.output_text.delta', delta: 'partial' });
          queueMicrotask(() => socket.close());
        }),
      fetchImpl: (async () => {
        fetchCalls++;
        return new Response('', { status: 500 });
      }) as typeof fetch,
    });

    await expect(collect(provider.stream(request('partial-provider'), { signal: new AbortController().signal }))).rejects.toMatchObject({
      providerId: 'openai-codex',
      retryable: true,
    });
    expect(fetchCalls).toBe(0);
  });

  it('fails a silent backend through the stall watchdog instead of hanging', async () => {
    const pool = new CodexWebSocketPool(
      (_url, _options) =>
        new FakeSocket(() => {
          // Silent backend: never sends a frame after response.create.
        }),
    );
    const startedAt = Date.now();

    await expect(
      collect(pool.stream({ ...options('stall'), stallTimeoutMs: 25 }, parseOpenAIResponsesStream)),
    ).rejects.toBeInstanceOf(CodexWebSocketFallbackError);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it('turns a mid-stream stall into a retryable error without SSE fallback', async () => {
    const pool = new CodexWebSocketPool((_url, _options) => {
      return new FakeSocket((socket) => {
        socket.message({ type: 'response.created', response: { model: 'gpt-5-codex' } });
        socket.message({ type: 'response.output_text.delta', delta: 'partial' });
        // Silence afterwards: no terminal frame, no close.
      });
    });

    await expect(
      collect(pool.stream({ ...options('mid-stall'), stallTimeoutMs: 25 }, parseOpenAIResponsesStream)),
    ).rejects.toMatchObject({ providerId: 'openai-codex', retryable: true });
  });

  it('keeps the abort listener alive after the handshake and closes the socket', async () => {
    const controller = new AbortController();
    const sockets: FakeSocket[] = [];
    const pool = new CodexWebSocketPool((_url, _options) => {
      const socket = new FakeSocket((current) => {
        current.message({ type: 'response.created', response: { model: 'gpt-5-codex' } });
        current.message({ type: 'response.output_text.delta', delta: 'partial' });
        // Silence: only the mid-stream abort below can end this turn.
      });
      sockets.push(socket);
      return socket;
    });

    const streamPromise = collect(
      pool.stream(
        { ...options('abort'), signal: controller.signal, stallTimeoutMs: 0 },
        parseOpenAIResponsesStream,
      ),
    );
    while (sockets[0]?.sent.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    controller.abort();

    // An abort must surface fast and raw (AbortError), never masquerading as a
    // retryable transport error — the caller explicitly cancelled the turn.
    await expect(streamPromise).rejects.toMatchObject({ name: 'AbortError' });
    // The abort itself closes the socket; the pool's error-path cleanup then
    // closes it again (idempotent), so assert "closed", not "exactly once".
    expect(sockets[0]?.closeCount).toBeGreaterThanOrEqual(1);
  });

  it('forwards the caller signal and headers to the ws transport', () => {
    const controller = new AbortController();
    defaultCodexWebSocketFactory('wss://chatgpt.com/backend-api/codex/responses', {
      headers: { authorization: 'Bearer t' },
      signal: controller.signal,
    });

    expect(wsConstructCalls.at(-1)).toMatchObject({
      url: 'wss://chatgpt.com/backend-api/codex/responses',
      options: {
        headers: { authorization: 'Bearer t' },
        signal: controller.signal,
        followRedirects: false,
      },
    });
  });
});
