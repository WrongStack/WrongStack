import { describe, expect, it, vi } from 'vitest';
import { AnthropicProvider } from '../src/anthropic.js';

function mockFetch(json: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => json,
    text: async () => JSON.stringify(json),
  } as never as Response);
}

describe('AnthropicProvider', () => {
  // Content-parsing tests live in streaming.test.ts since complete() now
  // wraps stream() internally and content parsing happens in the SSE
  // pipeline, not from a JSON body. This file covers everything else.

  it('throws ProviderError on non-2xx', async () => {
    const fetchImpl = mockFetch({ error: 'rate' }, 429) as never as typeof fetch;
    const p = new AnthropicProvider({ apiKey: 'k', fetchImpl });
    await expect(
      p.complete(
        { model: 'm', messages: [{ role: 'user', content: 'x' }], maxTokens: 1 },
        { signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ status: 429 });
  });

  it('requires apiKey', () => {
    expect(() => new AnthropicProvider({ apiKey: '' })).toThrow(/apiKey required/);
  });

  it('adds anthropic-beta header when set', async () => {
    const spy = vi.fn(async (_url: unknown, init?: { headers?: Record<string, string> }) => ({
      ok: true,
      status: 200,
      headers: init?.headers,
      json: async () => ({
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      text: async () => '',
    }));
    const p = new AnthropicProvider({
      apiKey: 'k',
      beta: ['prompt-caching-2024-07-31', 'tools-2024-04-04'],
      fetchImpl: spy as never as typeof fetch,
    });
    await p.complete(
      { model: 'm', messages: [{ role: 'user', content: 'x' }], maxTokens: 1 },
      { signal: new AbortController().signal },
    );
    const hdrs = (spy.mock.calls[0]![1] as { headers: Record<string, string> }).headers;
    expect(hdrs['anthropic-beta']).toBe('prompt-caching-2024-07-31,tools-2024-04-04');
    expect(hdrs['x-api-key']).toBe('k');
  });

  it('serialises system, tools, temperature, topP, stopSequences', async () => {
    let body: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(async (_url: unknown, init: { body?: string } = {}) => {
      body = JSON.parse(init.body ?? '{}');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        text: async () => '',
      };
    }) as never as typeof fetch;
    const p = new AnthropicProvider({ apiKey: 'k', fetchImpl });
    await p.complete(
      {
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 1,
        system: [{ type: 'text', text: 'be terse' }],
        temperature: 0.2,
        topP: 0.9,
        stopSequences: ['<end>'],
        tools: [
          {
            name: 'read',
            description: '',
            inputSchema: { type: 'object' },
            permission: 'auto',
            mutating: false,
            async execute() {
              return '';
            },
          },
        ],
      },
      { signal: new AbortController().signal },
    );
    expect(body?.['system']).toEqual([{ type: 'text', text: 'be terse' }]);
    expect(body?.['temperature']).toBe(0.2);
    expect(body?.['top_p']).toBe(0.9);
    expect(body?.['stop_sequences']).toEqual(['<end>']);
    expect(body?.['tools'] as unknown[]).toHaveLength(1);
  });

  it('caps cache breakpoints to 4 on the wire and never mutates the caller system blocks', async () => {
    let body: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(async (_url: unknown, init: { body?: string } = {}) => {
      body = JSON.parse(init.body ?? '{}');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        text: async () => '',
      };
    }) as never as typeof fetch;
    const p = new AnthropicProvider({ apiKey: 'k', fetchImpl });
    // Six ephemeral system markers — two over Anthropic's ceiling of 4.
    const system = Array.from({ length: 6 }, (_, i) => ({
      type: 'text' as const,
      text: `block-${i}`,
      cache_control: { type: 'ephemeral' as const },
    }));
    await p.complete(
      { model: 'm', messages: [{ role: 'user', content: 'hi' }], maxTokens: 1, system },
      { signal: new AbortController().signal },
    );
    const wire = body?.['system'] as Array<Record<string, unknown>>;
    expect(wire.filter((b) => b['cache_control']).length).toBe(4);
    // The caller's own blocks must be untouched (buildBody clones before capping).
    expect(system.every((b) => b.cache_control?.type === 'ephemeral')).toBe(true);
  });

  it('applies the cache ttl to the deepest message marker, not the system tail', async () => {
    let body: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(async (_url: unknown, init: { body?: string } = {}) => {
      body = JSON.parse(init.body ?? '{}');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        text: async () => '',
      };
    }) as never as typeof fetch;
    const p = new AnthropicProvider({ apiKey: 'k', fetchImpl });
    await p.complete(
      {
        model: 'm',
        maxTokens: 1,
        system: [
          { type: 'text', text: 'identity', cache_control: { type: 'ephemeral' } },
          { type: 'text', text: 'environment' },
        ],
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 't1',
                content: 'result body',
                cache_control: { type: 'ephemeral' },
              },
            ],
          },
        ],
        cache: { ttl: '1h' },
      },
      { signal: new AbortController().signal },
    );
    // The conversation boundary (tool_result marker) carries the ttl…
    const messages = body?.['messages'] as Array<{ content: Array<Record<string, unknown>> }>;
    expect(messages[0]?.content[0]?.['cache_control']).toEqual({ type: 'ephemeral', ttl: '1h' });
    // …and the system blocks keep their own markers untouched (no forced tail marker).
    const wireSystem = body?.['system'] as Array<Record<string, unknown>>;
    expect(wireSystem[0]?.['cache_control']).toEqual({ type: 'ephemeral' });
    expect(wireSystem[1]?.['cache_control']).toBeUndefined();
  });

  it('falls back to the last system block for ttl when no message marker exists', async () => {
    let body: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(async (_url: unknown, init: { body?: string } = {}) => {
      body = JSON.parse(init.body ?? '{}');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        text: async () => '',
      };
    }) as never as typeof fetch;
    const p = new AnthropicProvider({ apiKey: 'k', fetchImpl });
    await p.complete(
      {
        model: 'm',
        maxTokens: 1,
        system: [{ type: 'text', text: 'marker-less embedder prompt' }],
        messages: [{ role: 'user', content: 'hi' }],
        cache: { ttl: '5m' },
      },
      { signal: new AbortController().signal },
    );
    const wireSystem = body?.['system'] as Array<Record<string, unknown>>;
    expect(wireSystem[0]?.['cache_control']).toEqual({ type: 'ephemeral', ttl: '5m' });
  });

  it('mixed ttl markers: exactly one ttl marker, emitted deepest after all plain markers', async () => {
    let body: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(async (_url: unknown, init: { body?: string } = {}) => {
      body = JSON.parse(init.body ?? '{}');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        text: async () => '',
      };
    }) as never as typeof fetch;
    const p = new AnthropicProvider({ apiKey: 'k', fetchImpl });
    await p.complete(
      {
        model: 'm',
        maxTokens: 1,
        system: [
          { type: 'text', text: 'head', cache_control: { type: 'ephemeral' } },
          { type: 'text', text: 'tail', cache_control: { type: 'ephemeral' } },
        ],
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'q', cache_control: { type: 'ephemeral' } }] },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 't1',
                content: 'result body',
                cache_control: { type: 'ephemeral' },
              },
            ],
          },
        ],
        cache: { ttl: '1h' },
      },
      { signal: new AbortController().signal },
    );
    // Pin the documented emission contract (presets/anthropic.ts buildBody):
    // the configured cache.ttl lands on the DEEPEST marked block — the
    // conversation boundary, the prefix worth keeping across turn gaps — and
    // every other marker stays a plain { type: 'ephemeral' } (Anthropic's
    // 5-minute default). At most one ttl-bearing breakpoint exists per
    // request by construction, so no 1h/5m pair is ever emitted to order.
    const markers: Array<{ block: Record<string, unknown>; where: string }> = [];
    const wireSystem = body?.['system'] as Array<Record<string, unknown>>;
    wireSystem.forEach((block, i) => {
      if (block['cache_control']) markers.push({ block, where: `system[${String(i)}]` });
    });
    const wireMessages = body?.['messages'] as Array<{
      content: Array<Record<string, unknown>>;
    }>;
    wireMessages.forEach((message, mi) => {
      if (!Array.isArray(message.content)) return;
      message.content.forEach((block, bi) => {
        if (block['cache_control']) {
          markers.push({ block, where: `messages[${String(mi)}].content[${String(bi)}]` });
        }
      });
    });
    const ttlMarkers = markers.filter(
      (m) => (m.block['cache_control'] as Record<string, unknown>)['ttl'] != null,
    );
    expect(ttlMarkers).toHaveLength(1);
    expect(markers.indexOf(ttlMarkers[0]!)).toBe(markers.length - 1);
    expect(ttlMarkers[0]!.where).toBe('messages[1].content[0]');
    expect(ttlMarkers[0]!.block['cache_control']).toEqual({ type: 'ephemeral', ttl: '1h' });
    for (const marker of markers) {
      if (marker !== ttlMarkers[0]) {
        expect(marker.block['cache_control']).toEqual({ type: 'ephemeral' });
      }
    }
  });

  it('uses Bearer auth for non-Anthropic baseUrls (kimi-for-coding etc.)', async () => {
    const spy = vi.fn(async (_url: unknown, init?: { headers?: Record<string, string> }) => ({
      ok: true,
      status: 200,
      headers: init?.headers,
      json: async () => ({
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      text: async () => '',
    }));
    const p = new AnthropicProvider({
      apiKey: 'sk-kimi-XYZ',
      baseUrl: 'https://api.kimi.com/coding/v1',
      fetchImpl: spy as never as typeof fetch,
    });
    await p.complete(
      { model: 'k2p6', messages: [{ role: 'user', content: 'x' }], maxTokens: 1 },
      { signal: new AbortController().signal },
    );
    const hdrs = (spy.mock.calls[0]![1] as { headers: Record<string, string> }).headers;
    expect(hdrs['authorization']).toBe('Bearer sk-kimi-XYZ');
    expect(hdrs['x-api-key']).toBeUndefined();
  });

  it('keeps x-api-key for default Anthropic baseUrl', async () => {
    const spy = vi.fn(async (_url: unknown, init?: { headers?: Record<string, string> }) => ({
      ok: true,
      status: 200,
      headers: init?.headers,
      json: async () => ({
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      text: async () => '',
    }));
    const p = new AnthropicProvider({
      apiKey: 'sk-ant-XYZ',
      fetchImpl: spy as never as typeof fetch,
    });
    await p.complete(
      { model: 'm', messages: [{ role: 'user', content: 'x' }], maxTokens: 1 },
      { signal: new AbortController().signal },
    );
    const hdrs = (spy.mock.calls[0]![1] as { headers: Record<string, string> }).headers;
    expect(hdrs['x-api-key']).toBe('sk-ant-XYZ');
    expect(hdrs['authorization']).toBeUndefined();
  });

  it('non-2xx with 500 is retryable', async () => {
    const fetchImpl = mockFetch({}, 500) as never as typeof fetch;
    const p = new AnthropicProvider({ apiKey: 'k', fetchImpl });
    await expect(
      p.complete(
        { model: 'm', messages: [{ role: 'user', content: 'x' }], maxTokens: 1 },
        { signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ status: 500, retryable: true });
  });

  it('uses correct URL for baseUrl already ending in /v1 (e.g. minimax models.dev)', async () => {
    let calledUrl = '';
    const fetchImpl = vi.fn(async (url: unknown) => {
      calledUrl = String(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        text: async () => '',
      };
    }) as never as typeof fetch;
    const p = new AnthropicProvider({
      apiKey: 'k',
      baseUrl: 'https://api.minimax.io/anthropic/v1',
      fetchImpl,
    });
    await p.complete(
      { model: 'm', messages: [{ role: 'user', content: 'x' }], maxTokens: 1 },
      { signal: new AbortController().signal },
    );
    expect(calledUrl).toBe('https://api.minimax.io/anthropic/v1/messages');
  });

  it('appends /v1/messages to bare host baseUrls', async () => {
    let calledUrl = '';
    const fetchImpl = vi.fn(async (url: unknown) => {
      calledUrl = String(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({ content: [], stop_reason: 'end_turn', usage: {} }),
        text: async () => '',
      };
    }) as never as typeof fetch;
    const p = new AnthropicProvider({
      apiKey: 'k',
      baseUrl: 'https://example.com',
      fetchImpl,
    });
    await p.complete(
      { model: 'm', messages: [{ role: 'user', content: 'x' }], maxTokens: 1 },
      { signal: new AbortController().signal },
    );
    expect(calledUrl).toBe('https://example.com/v1/messages');
  });

  it('accepts baseUrl with /v1/messages already', async () => {
    let calledUrl = '';
    const fetchImpl = vi.fn(async (url: unknown) => {
      calledUrl = String(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({ content: [], stop_reason: 'end_turn', usage: {} }),
        text: async () => '',
      };
    }) as never as typeof fetch;
    const p = new AnthropicProvider({
      apiKey: 'k',
      baseUrl: 'https://example.com/v1/messages',
      fetchImpl,
    });
    await p.complete(
      { model: 'm', messages: [{ role: 'user', content: 'x' }], maxTokens: 1 },
      { signal: new AbortController().signal },
    );
    expect(calledUrl).toBe('https://example.com/v1/messages');
  });

  it('wraps fetch network error in ProviderError(retryable)', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('boom')) as never as typeof fetch;
    const p = new AnthropicProvider({ apiKey: 'k', fetchImpl });
    await expect(
      p.complete(
        { model: 'm', messages: [{ role: 'user', content: 'x' }], maxTokens: 1 },
        { signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ status: 0, retryable: true });
  });

  it('strips non-Anthropic fields (tool_result.name, providerMeta) from blocks', async () => {
    const sse = [
      'event: message_start',
      'data: {"type":"message_start","message":{"model":"m","usage":{"input_tokens":1,"output_tokens":0}}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
    ].join('\n');
    let captured: Record<string, unknown> = {};
    const fetchImpl = (async (_url: string, init: { body?: string }) => {
      captured = JSON.parse(init.body ?? '{}');
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(c) {
            c.enqueue(new TextEncoder().encode(sse));
            c.close();
          },
        }),
        { status: 200 },
      );
    }) as never as typeof fetch;

    const p = new AnthropicProvider({ apiKey: 'k', fetchImpl });
    await p.complete(
      {
        model: 'm',
        maxTokens: 10,
        messages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'toolu_1',
                name: 'read',
                input: { p: 'x' },
                providerMeta: { a: 1 },
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_1',
                name: 'read',
                content: 'ok',
                is_error: false,
              },
            ],
          },
        ],
      },
      { signal: new AbortController().signal },
    );

    const msgs = captured['messages'] as Array<{ content: Array<Record<string, unknown>> }>;
    const toolUse = msgs[0]!.content[0]!;
    const toolResult = msgs[1]!.content[0]!;
    expect(toolUse).not.toHaveProperty('providerMeta');
    expect(toolResult).not.toHaveProperty('name');
    expect(toolResult).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'toolu_1',
      content: 'ok',
    });
  });

  it('sends top_k when topK is set', async () => {
    let captured: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(async (_url: unknown, init: { body?: string } = {}) => {
      captured = JSON.parse(init.body ?? '{}');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        text: async () => '',
      };
    }) as never as typeof fetch;
    const p = new AnthropicProvider({ apiKey: 'k', fetchImpl });
    await p.complete(
      { model: 'm', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100, topK: 40 },
      { signal: new AbortController().signal },
    );
    expect(captured?.['top_k']).toBe(40);
  });

  it('sends metadata.user_id when user is set', async () => {
    let captured: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(async (_url: unknown, init: { body?: string } = {}) => {
      captured = JSON.parse(init.body ?? '{}');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        text: async () => '',
      };
    }) as never as typeof fetch;
    const p = new AnthropicProvider({ apiKey: 'k', fetchImpl });
    await p.complete(
      { model: 'm', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100, user: 'user-abc' },
      { signal: new AbortController().signal },
    );
    expect(captured?.['metadata']).toEqual({ user_id: 'user-abc' });
  });

  it('sends thinking.enabled when reasoning is on', async () => {
    let captured: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(async (_url: unknown, init: { body?: string } = {}) => {
      captured = JSON.parse(init.body ?? '{}');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        text: async () => '',
      };
    }) as never as typeof fetch;
    const p = new AnthropicProvider({ apiKey: 'k', fetchImpl });
    await p.complete(
      {
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 8192,
        reasoning: { enabled: true, effort: 'high' },
      },
      { signal: new AbortController().signal },
    );
    expect(captured?.['thinking']).toMatchObject({ type: 'enabled' });
    expect((captured!['thinking'] as { budget_tokens: number }).budget_tokens).toBeGreaterThan(0);
  });

  it('treats an effort-only request as enable-with-budget (effort reaches the wire)', async () => {
    let captured: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(async (_url: unknown, init: { body?: string } = {}) => {
      captured = JSON.parse(init.body ?? '{}');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        text: async () => '',
      };
    }) as never as typeof fetch;
    const p = new AnthropicProvider({ apiKey: 'k', fetchImpl });
    // No `enabled` — the common case from the runtime effort dropdown. The
    // Anthropic wire has no effort enum, only budget_tokens, so effort-only
    // must map to enable + sized budget or it is a silent no-op.
    await p.complete(
      {
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 8192,
        reasoning: { effort: 'high' },
      },
      { signal: new AbortController().signal },
    );
    expect(captured?.['thinking']).toMatchObject({ type: 'enabled' });
    const budget = (captured!['thinking'] as { budget_tokens: number }).budget_tokens;
    expect(budget).toBeGreaterThanOrEqual(1024);
    // medium ⇒ 50% of 8192, high ⇒ 65% — effort actually changes the budget.
    await p.complete(
      {
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 8192,
        reasoning: { effort: 'medium' },
      },
      { signal: new AbortController().signal },
    );
    const medium = (captured!['thinking'] as { budget_tokens: number }).budget_tokens;
    expect(medium).toBeLessThan(budget);
  });

  it('omits thinking when the output cap cannot hold a legal budget', async () => {
    let captured: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(async (_url: unknown, init: { body?: string } = {}) => {
      captured = JSON.parse(init.body ?? '{}');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        text: async () => '',
      };
    }) as never as typeof fetch;
    const p = new AnthropicProvider({ apiKey: 'k', fetchImpl });
    // budget_tokens must be >= 1024 and < max_tokens — 100 satisfies neither.
    // Sending a fabricated budget would 400; omitting keeps the request valid.
    await p.complete(
      {
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 100,
        reasoning: { enabled: true, effort: 'high' },
      },
      { signal: new AbortController().signal },
    );
    expect(captured).not.toHaveProperty('thinking');
  });

  it('sends thinking.disabled when reasoning is off', async () => {
    let captured: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(async (_url: unknown, init: { body?: string } = {}) => {
      captured = JSON.parse(init.body ?? '{}');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        text: async () => '',
      };
    }) as never as typeof fetch;
    const p = new AnthropicProvider({ apiKey: 'k', fetchImpl });
    await p.complete(
      {
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 100,
        reasoning: { enabled: false },
      },
      { signal: new AbortController().signal },
    );
    expect(captured?.['thinking']).toEqual({ type: 'disabled' });
  });

  it('does not send unsupported params (frequencyPenalty, presencePenalty, seed, logprobs)', async () => {
    let captured: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(async (_url: unknown, init: { body?: string } = {}) => {
      captured = JSON.parse(init.body ?? '{}');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        text: async () => '',
      };
    }) as never as typeof fetch;
    const p = new AnthropicProvider({ apiKey: 'k', fetchImpl });
    await p.complete(
      {
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 100,
        frequencyPenalty: 0.5,
        presencePenalty: 0.5,
        seed: 42,
        logprobs: true,
      },
      { signal: new AbortController().signal },
    );
    expect(captured).not.toHaveProperty('frequency_penalty');
    expect(captured).not.toHaveProperty('presence_penalty');
    expect(captured).not.toHaveProperty('seed');
    expect(captured).not.toHaveProperty('logprobs');
    expect(captured).not.toHaveProperty('top_logprobs');
  });

  // ── maxTools ───────────────────────────────────────────────

  function toolList(names: string[]): import('@wrongstack/core/types').Tool[] {
    return names.map((name) => ({
      name,
      description: `Tool ${name}`,
      inputSchema: { type: 'object', properties: {} },
      permission: 'auto',
      mutating: false,
      async execute() {},
    }));
  }

  it('trims tools to maxTools limit on the wire', async () => {
    let captured: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(async (_url: unknown, init: { body?: string } = {}) => {
      captured = JSON.parse(init.body ?? '{}');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        text: async () => '',
      };
    }) as never as typeof fetch;
    const p = new AnthropicProvider({ apiKey: 'k', fetchImpl, maxTools: 2 });
    await p.complete(
      {
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 1,
        tools: toolList(['read', 'write', 'lint_gate_status', 'secret_scanner_test']),
      },
      { signal: new AbortController().signal },
    );
    const wireTools = captured?.['tools'] as Array<{ name: string }>;
    expect(wireTools).toHaveLength(2);
    const names = wireTools.map((t) => t.name);
    expect(names).toContain('read');
    expect(names).toContain('write');
    expect(names).not.toContain('lint_gate_status');
  });

  it('preserves all tools when under maxTools limit', async () => {
    let captured: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(async (_url: unknown, init: { body?: string } = {}) => {
      captured = JSON.parse(init.body ?? '{}');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        text: async () => '',
      };
    }) as never as typeof fetch;
    const p = new AnthropicProvider({ apiKey: 'k', fetchImpl, maxTools: 128 });
    await p.complete(
      {
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 1,
        tools: toolList(['read', 'write', 'bash']),
      },
      { signal: new AbortController().signal },
    );
    const wireTools = captured?.['tools'] as Array<{ name: string }>;
    expect(wireTools).toHaveLength(3);
  });
});
