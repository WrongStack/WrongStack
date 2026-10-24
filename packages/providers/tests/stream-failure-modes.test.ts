/**
 * Failure modes a stream can end in, per wire: an error envelope inside a 200
 * stream, a cut connection, a blocked prompt, a stale WebSocket handshake.
 * Each case used to either commit a wrong turn or classify retryability wrong.
 */
import { ProviderError, type StreamEvent } from '@wrongstack/contracts/types';
import { describe, expect, it } from 'vitest';
import {
  CodexWebSocketFallbackError,
  type CodexWebSocketLike,
  CodexWebSocketPool,
} from '../src/codex-websocket.js';
import { providerErrorFromStreamPayload } from '../src/error-parse.js';
import { OpenAIProvider } from '../src/openai.js';
import { parseOpenAIResponsesStream } from '../src/openai-codex.js';
import { googleWireFormat } from '../src/presets/google.js';
import { ollamaWireFormat } from '../src/presets/local-llm.js';
import { openaiWireFormat } from '../src/presets/openai.js';
import { redirectSafeFetch } from '../src/redirect-safe-fetch.js';
import { WireFormatProvider } from '../src/wire-format.js';

function sse(frames: unknown[]): ReadableStream<Uint8Array> {
  const text = frames
    .map((f) => `data: ${typeof f === 'string' ? f : JSON.stringify(f)}\n\n`)
    .join('');
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function fetchOf(frames: unknown[]): typeof fetch {
  return (async () =>
    ({ ok: true, status: 200, text: async () => '', body: sse(frames) }) as never) as never;
}

async function drain(
  stream: AsyncIterable<StreamEvent>,
): Promise<{ events: StreamEvent[]; error?: unknown }> {
  const events: StreamEvent[] = [];
  try {
    for await (const ev of stream) events.push(ev);
    return { events };
  } catch (error) {
    return { events, error };
  }
}

const REQ = { model: 'm', messages: [], maxTokens: 100 };
const signal = () => ({ signal: new AbortController().signal });

describe('providerErrorFromStreamPayload', () => {
  it('uses a numeric code as the status (OpenRouter upstream 502 → retryable)', () => {
    const err = providerErrorFromStreamPayload('openrouter', {
      error: { code: 502, message: 'Provider returned error' },
    });
    expect(err).toMatchObject({ status: 502, retryable: true, providerId: 'openrouter' });
  });

  it('keeps context-overflow prose non-retryable', () => {
    const err = providerErrorFromStreamPayload('x', {
      error: { message: "This model's maximum context length is 8192 tokens" },
    });
    expect(err.kind).toBe('context_overflow');
    expect(err.retryable).toBe(false);
  });

  it('treats an unrecognised mid-stream failure as a retryable server fault', () => {
    const err = providerErrorFromStreamPayload('x', { error: { message: 'upstream went away' } });
    expect(err).toMatchObject({ status: 500, retryable: true, kind: 'server' });
  });
});

describe('OpenAI chat-completions stream', () => {
  it('raises an in-stream error envelope instead of ending the turn cleanly', async () => {
    const provider = new OpenAIProvider({
      apiKey: 'k',
      id: 'openrouter',
      fetchImpl: fetchOf([
        { choices: [{ delta: { content: 'par' } }] },
        {
          error: { code: 429, message: 'Rate limit exceeded' },
          choices: [{ finish_reason: 'error' }],
        },
      ]),
    });
    const { events, error } = await drain(provider.stream(REQ, signal()));
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ status: 429, retryable: true, providerId: 'openrouter' });
    expect(events.some((e) => e.type === 'message_stop')).toBe(false);
  });

  it('does not close a half-streamed tool call before reporting truncation', async () => {
    const provider = new OpenAIProvider({
      apiKey: 'k',
      fetchImpl: fetchOf([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 'call_1', function: { name: 'write', arguments: '{"path":"a' } },
                ],
              },
            },
          ],
        },
      ]),
    });
    const { events, error } = await drain(provider.stream(REQ, signal()));
    expect(error).toMatchObject({ status: 599, retryable: true });
    expect(events.some((e) => e.type === 'tool_use_stop')).toBe(false);
  });

  it('declarative preset raises in-stream errors under the live provider id', async () => {
    const provider = new WireFormatProvider(openaiWireFormat, {
      apiKey: 'k',
      fetchImpl: fetchOf([{ error: { type: 'server_error', message: 'boom' } }]),
    });
    Object.defineProperty(provider, 'id', { value: 'copilot-alias' });
    const { error } = await drain(provider.stream(REQ, signal()));
    expect(error).toMatchObject({ providerId: 'copilot-alias', retryable: true });
  });
});

describe('Gemini stream', () => {
  const gemini = (frames: unknown[]) =>
    new WireFormatProvider(googleWireFormat, { apiKey: 'k', fetchImpl: fetchOf(frames) });

  it('ends a blocked prompt as a refusal instead of a retryable truncation', async () => {
    const { events, error } = await drain(
      gemini([{ promptFeedback: { blockReason: 'SAFETY' } }]).stream(REQ, signal()),
    );
    expect(error).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ type: 'message_stop', stopReason: 'refusal' });
  });

  it('routes thought-summary parts to the thinking channel', async () => {
    const { events } = await drain(
      gemini([
        { candidates: [{ content: { parts: [{ text: 'pondering', thought: true }] } }] },
        { candidates: [{ content: { parts: [{ text: 'answer' }] }, finishReason: 'STOP' }] },
      ]).stream(REQ, signal()),
    );
    expect(events.map((e) => e.type)).toEqual([
      'message_start',
      'thinking_start',
      'thinking_delta',
      'thinking_stop',
      'text_delta',
      'message_stop',
    ]);
    expect(events.find((e) => e.type === 'text_delta')).toMatchObject({ text: 'answer' });
  });

  it('raises an in-stream error envelope', async () => {
    const { error } = await drain(
      gemini([{ error: { code: 503, message: 'overloaded', status: 'UNAVAILABLE' } }]).stream(
        REQ,
        signal(),
      ),
    );
    expect(error).toMatchObject({ status: 503, retryable: true });
  });
});

describe('local LLM stream', () => {
  it('surfaces reasoning deltas and keeps tool calls that arrive without an id', async () => {
    const provider = new WireFormatProvider(ollamaWireFormat, {
      apiKey: 'k',
      fetchImpl: fetchOf([
        { choices: [{ delta: { reasoning: 'thinking…' } }] },
        {
          choices: [
            { delta: { tool_calls: [{ index: 0, function: { name: 'ls', arguments: '{}' } }] } },
          ],
        },
        { choices: [{ finish_reason: 'tool_calls' }] },
        '[DONE]',
      ]),
    });
    const { events } = await drain(provider.stream(REQ, signal()));
    expect(events).toContainEqual({ type: 'thinking_delta', text: 'thinking…' });
    const stop = events.find((e) => e.type === 'tool_use_stop');
    expect(stop).toMatchObject({ input: {} });
    expect((stop as { id: string }).id).toMatch(/^call_/);
  });
});

describe('redirectSafeFetch local endpoints', () => {
  const redirect = (status: number, location?: string) =>
    ({
      status,
      ok: status < 300,
      headers: { get: (n: string) => (n === 'location' ? location : null) },
      text: async () => '',
    }) as unknown as Response;

  it('follows a localhost → loopback redirect for a local runtime', async () => {
    let calls = 0;
    const impl = (async () =>
      ++calls === 1
        ? redirect(307, 'http://127.0.0.1:11434/v1/chat/completions')
        : redirect(200)) as never;
    const res = await redirectSafeFetch(impl, 'http://localhost:11434/v1/chat/completions', {
      method: 'POST',
      headers: {},
      body: '{}',
    });
    expect(res.status).toBe(200);
  });

  it('still blocks a public host redirecting into loopback', async () => {
    const impl = (async () => redirect(307, 'http://127.0.0.1:8080/')) as never;
    await expect(
      redirectSafeFetch(impl, 'https://api.example.com/v1', { headers: {} }),
    ).rejects.toThrow(/private\/loopback/);
  });
});

/** Socket whose handshake outcome the test drives. */
class HandshakeSocket implements CodexWebSocketLike {
  readyState = 0;
  closeCount = 0;
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  send(): void {}
  close(): void {
    this.closeCount++;
    this.readyState = 3;
  }
  on(event: string, listener: (...args: unknown[]) => void): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }
  once(event: string, listener: (...args: unknown[]) => void): this {
    return this.on(event, listener);
  }
  removeListener(event: string, listener: (...args: unknown[]) => void): this {
    this.listeners.set(
      event,
      (this.listeners.get(event) ?? []).filter((l) => l !== listener),
    );
    return this;
  }
  emit(event: string, ...args: unknown[]): void {
    for (const l of [...(this.listeners.get(event) ?? [])]) l(...args);
  }
}

describe('Codex WebSocket handshake and rotation', () => {
  const opts = (sessionId = 's') => ({
    url: 'wss://chatgpt.com/backend-api/codex/responses',
    headers: { authorization: 'Bearer old' },
    request: { model: 'gpt-5-codex', messages: [], cache: { sessionId } },
    body: { model: 'gpt-5-codex', stream: true, input: [] },
    fallbackModel: 'gpt-5-codex',
    providerId: 'openai-codex',
    signal: new AbortController().signal,
  });

  it('turns a 401 upgrade rejection into a ProviderError the caller refreshes on', async () => {
    const pool = new CodexWebSocketPool(() => {
      const socket = new HandshakeSocket();
      queueMicrotask(() =>
        socket.emit('unexpected-response', {}, { statusCode: 401, headers: {} }),
      );
      return socket;
    });
    const { error } = await drain(pool.stream(opts(), parseOpenAIResponsesStream));
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ status: 401 });
  });

  it('turns any other handshake failure into an SSE fallback', async () => {
    const pool = new CodexWebSocketPool(() => {
      const socket = new HandshakeSocket();
      queueMicrotask(() => socket.emit('error', new Error('ECONNRESET')));
      return socket;
    });
    const { error } = await drain(pool.stream(opts(), parseOpenAIResponsesStream));
    expect(error).toBeInstanceOf(CodexWebSocketFallbackError);
  });

  it('retireAll lets an in-flight response finish, then closes its socket', async () => {
    const sockets: HandshakeSocket[] = [];
    const pool = new CodexWebSocketPool(() => {
      const socket = new HandshakeSocket();
      socket.send = () => {
        const frame = (payload: unknown) => socket.emit('message', JSON.stringify(payload));
        frame({ type: 'response.created', response: { model: 'gpt-5-codex' } });
        frame({ type: 'response.output_text.delta', delta: 'still ' });
        // Token rotation lands while this response is mid-stream.
        pool.retireAll();
        frame({ type: 'response.output_text.delta', delta: 'here' });
        frame({ type: 'response.completed', response: { status: 'completed' } });
      };
      queueMicrotask(() => {
        socket.readyState = 1;
        socket.emit('open');
      });
      sockets.push(socket);
      return socket;
    });

    const { events, error } = await drain(pool.stream(opts(), parseOpenAIResponsesStream));
    expect(error).toBeUndefined();
    const text = events
      .filter((e): e is Extract<StreamEvent, { type: 'text_delta' }> => e.type === 'text_delta')
      .map((e) => e.text)
      .join('');
    expect(text).toBe('still here');
    expect(sockets[0]?.closeCount).toBe(1);

    await drain(pool.stream(opts(), parseOpenAIResponsesStream));
    expect(sockets).toHaveLength(2);
  });
});
