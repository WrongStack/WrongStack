import type { Request, StreamEvent } from '@wrongstack/core/types';
import { ProviderError } from '@wrongstack/core/types';
import { describe, expect, it } from 'vitest';
import {
  WireFormatProvider,
  createWireFormatFactory,
  defineWireFormat,
} from '../src/wire-format.js';

// --- Test helpers -----------------------------------------------------------

interface MiniState {
  model: string;
  started: boolean;
}

const miniConfig = defineWireFormat<MiniState>({
  id: 'mini',
  family: 'openai',
  capabilities: {
    tools: true,
    parallelTools: true,
    vision: false,
    streaming: true,
    promptCache: false,
    systemPrompt: true,
    jsonMode: false,
    maxContext: 8_000,
    cacheControl: 'none',
  },
  defaultBaseUrl: 'https://example.test/v1',
  buildUrl: (base) => `${base}/chat/completions`,
  buildHeaders: (apiKey) => ({ authorization: `Bearer ${apiKey}` }),
  buildBody: (req: Request) => ({
    model: req.model,
    messages: req.messages,
    stream: true,
  }),
  createStreamState: (fallbackModel) => ({ model: fallbackModel, started: false }),
  parseStreamEvent: (msg, state): StreamEvent[] => {
    if (!msg.data || msg.data === '[DONE]') return [];
    const ev = JSON.parse(msg.data) as {
      type?: string;
      model?: string;
      text?: string;
      stopReason?: string;
      usage?: { input: number; output: number };
    };
    const out: StreamEvent[] = [];
    if (ev.model) state.model = ev.model;
    if (!state.started) {
      state.started = true;
      out.push({ type: 'message_start', model: state.model });
    }
    if (ev.type === 'text' && typeof ev.text === 'string') {
      out.push({ type: 'text_delta', text: ev.text });
    }
    if (ev.type === 'stop' && ev.usage) {
      out.push({
        type: 'message_stop',
        stopReason: (ev.stopReason as never) ?? 'end_turn',
        usage: { input: ev.usage.input, output: ev.usage.output },
      });
    }
    return out;
  },
});

function sseBody(messages: { event?: string; data: string }[]): ReadableStream<Uint8Array> {
  const text = messages
    .map((m) => `${m.event ? `event: ${m.event}\n` : ''}data: ${m.data}\n\n`)
    .join('');
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode(text));
      controller.close();
    },
  });
}

function fakeFetch(body: ReadableStream<Uint8Array>, status = 200): typeof fetch {
  return (async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => '',
      body,
    }) as never as Response) as never as typeof fetch;
}

function fakeFetchError(
  status: number,
  body: string,
  headers?: Record<string, string>,
): typeof fetch {
  return (async () =>
    ({
      ok: false,
      status,
      text: async () => body,
      body: null,
      headers: headers ? { get: (n: string) => headers[n.toLowerCase()] ?? null } : undefined,
    }) as never as Response) as never as typeof fetch;
}

// --- Tests ------------------------------------------------------------------

describe('WireFormatProvider — declarative wire format', () => {
  it('streams text events translated through parseStreamEvent', async () => {
    const body = sseBody([
      { data: JSON.stringify({ type: 'start', model: 'mini-1' }) },
      { data: JSON.stringify({ type: 'text', text: 'hello ' }) },
      { data: JSON.stringify({ type: 'text', text: 'world' }) },
      {
        data: JSON.stringify({
          type: 'stop',
          stopReason: 'end_turn',
          usage: { input: 10, output: 5 },
        }),
      },
      { data: '[DONE]' },
    ]);
    const provider = new WireFormatProvider(miniConfig, {
      apiKey: 'k',
      fetchImpl: fakeFetch(body),
    });

    const events: StreamEvent[] = [];
    for await (const ev of provider.stream(
      { model: 'mini-1', messages: [], maxTokens: 100 },
      { signal: new AbortController().signal },
    )) {
      events.push(ev);
    }

    expect(events[0]).toEqual({ type: 'message_start', model: 'mini-1' });
    const textDeltas = events.filter((e) => e.type === 'text_delta');
    expect(textDeltas).toHaveLength(2);
    const stop = events.find((e) => e.type === 'message_stop');
    expect(stop).toBeDefined();
    expect(
      (stop as { stopReason: string; usage: { input: number; output: number } }).usage,
    ).toEqual({
      input: 10,
      output: 5,
    });
  });

  it('builds the URL and headers from the config', async () => {
    let captured: { url: string; headers: HeadersInit } | null = null;
    const customFetch = (async (url: unknown, init: unknown) => {
      const i = init as { headers: HeadersInit };
      captured = { url: String(url), headers: i.headers };
      return {
        ok: true,
        status: 200,
        text: async () => '',
        body: sseBody([{ data: '[DONE]' }]),
      } as never as Response;
    }) as never as typeof fetch;

    const provider = new WireFormatProvider(miniConfig, {
      apiKey: 'sk-test',
      baseUrl: 'https://override.test/v9',
      fetchImpl: customFetch,
    });

    for await (const _ of provider.stream(
      { model: 'mini-1', messages: [], maxTokens: 100 },
      { signal: new AbortController().signal },
    )) {
      /* drain */
    }

    expect(captured).not.toBeNull();
    expect(captured!.url).toBe('https://override.test/v9/chat/completions');
    expect((captured!.headers as Record<string, string>)['authorization']).toBe('Bearer sk-test');
  });

  it('per-stream state is isolated across multiple stream() calls', async () => {
    // Each call must get a fresh `started` flag, so message_start emits on
    // every stream not just the first.
    const makeBody = () =>
      sseBody([
        { data: JSON.stringify({ type: 'start', model: 'mini-1' }) },
        { data: JSON.stringify({ type: 'text', text: 'x' }) },
        { data: '[DONE]' },
      ]);

    const collect = async (provider: WireFormatProvider<MiniState>) => {
      const events: StreamEvent[] = [];
      for await (const ev of provider.stream(
        { model: 'mini-1', messages: [], maxTokens: 100 },
        { signal: new AbortController().signal },
      )) {
        events.push(ev);
      }
      return events;
    };

    const provider1 = new WireFormatProvider(miniConfig, {
      apiKey: 'k',
      fetchImpl: fakeFetch(makeBody()),
    });
    const first = await collect(provider1);

    const provider2 = new WireFormatProvider(miniConfig, {
      apiKey: 'k',
      fetchImpl: fakeFetch(makeBody()),
    });
    const second = await collect(provider2);

    expect(first.filter((e) => e.type === 'message_start')).toHaveLength(1);
    expect(second.filter((e) => e.type === 'message_start')).toHaveLength(1);
  });

  it('translates HTTP errors via the default normalizer', async () => {
    const provider = new WireFormatProvider(miniConfig, {
      apiKey: 'k',
      fetchImpl: fakeFetchError(429, JSON.stringify({ error: { message: 'too fast' } })),
    });

    let caught: unknown;
    try {
      for await (const _ of provider.stream(
        { model: 'mini-1', messages: [], maxTokens: 100 },
        { signal: new AbortController().signal },
      )) {
        // unreachable
      }
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProviderError);
    expect((caught as ProviderError).status).toBe(429);
  });

  it('uses a custom normalizeError when supplied', async () => {
    const customCfg = defineWireFormat<MiniState>({
      ...miniConfig,
      normalizeError: (status) => new ProviderError(`custom ${status}`, status, false, 'mini'),
    });
    const provider = new WireFormatProvider(customCfg, {
      apiKey: 'k',
      fetchImpl: fakeFetchError(500, 'oh no'),
    });

    let caught: unknown;
    try {
      for await (const _ of provider.stream(
        { model: 'mini-1', messages: [], maxTokens: 100 },
        { signal: new AbortController().signal },
      )) {
        // unreachable
      }
    } catch (e) {
      caught = e;
    }
    expect((caught as Error).message).toBe('custom 500');
  });

  it('backfills Retry-After onto errors from a custom normalizeError', async () => {
    const customCfg = defineWireFormat<MiniState>({
      ...miniConfig,
      normalizeError: (status) =>
        new ProviderError(`custom ${status}`, status, true, 'mini', { body: {} }),
    });
    const provider = new WireFormatProvider(customCfg, {
      apiKey: 'k',
      fetchImpl: fakeFetchError(429, 'slow down', { 'retry-after': '7' }),
    });

    let caught: unknown;
    try {
      for await (const _ of provider.stream(
        { model: 'mini-1', messages: [], maxTokens: 100 },
        { signal: new AbortController().signal },
      )) {
        // unreachable
      }
    } catch (e) {
      caught = e;
    }
    expect((caught as ProviderError).body?.retryAfterMs).toBe(7_000);
  });

  it('parses Retry-After through the default normalizer', async () => {
    const provider = new WireFormatProvider(miniConfig, {
      apiKey: 'k',
      fetchImpl: fakeFetchError(429, '', { 'retry-after-ms': '1500' }),
    });

    let caught: unknown;
    try {
      for await (const _ of provider.stream(
        { model: 'mini-1', messages: [], maxTokens: 100 },
        { signal: new AbortController().signal },
      )) {
        // unreachable
      }
    } catch (e) {
      caught = e;
    }
    expect((caught as ProviderError).body?.retryAfterMs).toBe(1500);
    expect((caught as ProviderError).kind).toBe('rate_limit');
  });

  it('finalizeStream emits trailing events when defined', async () => {
    const trailingCfg = defineWireFormat<{ saw: number }>({
      ...miniConfig,
      isTruncated: () => false,
      createStreamState: () => ({ saw: 0 }),
      parseStreamEvent: (_msg, state) => {
        state.saw++;
        return [];
      },
      finalizeStream: (state) =>
        state.saw > 0
          ? [{ type: 'message_stop', stopReason: 'end_turn', usage: { input: 0, output: 0 } }]
          : [],
    });

    const provider = new WireFormatProvider(trailingCfg, {
      apiKey: 'k',
      fetchImpl: fakeFetch(sseBody([{ data: 'a' }, { data: 'b' }, { data: '[DONE]' }])),
    });

    const events: StreamEvent[] = [];
    for await (const ev of provider.stream(
      { model: 'mini-1', messages: [], maxTokens: 100 },
      { signal: new AbortController().signal },
    )) {
      events.push(ev);
    }
    // 3 SSE messages parsed → 1 finalize event
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('message_stop');
  });
});

describe('createWireFormatFactory', () => {
  it('returns a ProviderFactory whose create() builds a working provider', async () => {
    const factory = createWireFormatFactory(miniConfig);
    expect(factory.type).toBe('mini');
    expect(factory.family).toBe('openai');

    const provider = factory.create({ apiKey: 'sk-x' });
    expect(provider.id).toBe('mini');
    expect(provider.capabilities.maxContext).toBe(8_000);
  });

  it('throws when apiKey is missing from config', () => {
    const factory = createWireFormatFactory(miniConfig);
    expect(() => factory.create({})).toThrow(/apiKey/);
  });

  it('respects factory-level apiKey override', () => {
    const factory = createWireFormatFactory(miniConfig, { apiKey: 'preset-key' });
    const provider = factory.create({}); // no key in cfg
    // Building the provider succeeded — the override kicked in.
    expect(provider.id).toBe('mini');
  });
});

describe('defineWireFormat', () => {
  it('returns the same object — identity helper for type inference', () => {
    const raw = { ...miniConfig };
    expect(defineWireFormat(raw)).toBe(raw);
  });
});
