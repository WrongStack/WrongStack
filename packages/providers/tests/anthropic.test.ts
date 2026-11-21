import { describe, expect, it, vi } from 'vitest';
import { AnthropicProvider } from '../src/anthropic.js';
import { resetEffortSupport } from '../src/effort-support.js';

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
    // The conversation boundary (tool_result marker) carries the 1h ttl, and
    // the earlier system marker is promoted to 1h so wire order never places
    // 1h after an implicit 5m marker (which Anthropic rejects with 400).
    // Unmarked system blocks remain unmarked (no forced tail marker).
    const messages = body?.['messages'] as Array<{ content: Array<Record<string, unknown>> }>;
    expect(messages[0]?.content[0]?.['cache_control']).toEqual({ type: 'ephemeral', ttl: '1h' });
    const wireSystem = body?.['system'] as Array<Record<string, unknown>>;
    expect(wireSystem[0]?.['cache_control']).toEqual({ type: 'ephemeral', ttl: '1h' });
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

  it('promotes earlier 5m/plain markers to 1h when deepest marker uses 1h ttl', async () => {
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
          {
            role: 'user',
            content: [{ type: 'text', text: 'q', cache_control: { type: 'ephemeral' } }],
          },
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
    // Anthropic rejects a 1h breakpoint placed after a 5m (or omitted-ttl)
    // breakpoint. When cache.ttl === '1h' lands on the deepest marker, every
    // preceding marker is promoted to 1h so TTL order is non-increasing.
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
    expect(markers).toHaveLength(4);
    for (const marker of markers) {
      expect(marker.block['cache_control']).toEqual({ type: 'ephemeral', ttl: '1h' });
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

  it('picks the auth header by the upstream host behind a WrongProxy mount', async () => {
    const headersFor = async (baseUrl: string): Promise<Record<string, string>> => {
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
        apiKey: 'key',
        baseUrl,
        fetchImpl: spy as never as typeof fetch,
      });
      await p.complete(
        { model: 'm', messages: [{ role: 'user', content: 'x' }], maxTokens: 1 },
        { signal: new AbortController().signal },
      );
      return (spy.mock.calls[0]![1] as { headers: Record<string, string> }).headers;
    };

    // The proxy forwards headers untouched: Anthropic behind it still needs x-api-key.
    const anthropic = await headersFor('http://localhost:3444/proxy/api.anthropic.com/v1');
    expect(anthropic['x-api-key']).toBe('key');
    expect(anthropic['authorization']).toBeUndefined();

    const compatible = await headersFor('http://localhost:3444/proxy/api.kimi.com/coding/v1');
    expect(compatible['authorization']).toBe('Bearer key');
    expect(compatible['x-api-key']).toBeUndefined();
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

  it('sends thinking.adaptive + output_config.effort for Claude 5 and Claude 4.6+ models', async () => {
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

    for (const model of [
      'claude-opus-5-5',
      'claude-sonnet-5-5',
      'claude-fable-5-2',
      'claude-opus-4-6',
      'claude-opus-4-7',
      'anthropic/claude-opus-5-5',
    ]) {
      await p.complete(
        {
          model,
          messages: [{ role: 'user', content: 'hi' }],
          maxTokens: 8192,
          temperature: 0.4,
          topP: 0.9,
          topK: 40,
          reasoning: { enabled: true, effort: 'high' },
        },
        { signal: new AbortController().signal },
      );
      expect(captured?.['thinking']).toEqual({ type: 'adaptive' });
      expect(captured?.['output_config']).toEqual({ effort: 'high' });
      expect(captured).not.toHaveProperty('temperature');
      expect(captured).not.toHaveProperty('top_p');
      expect(captured).not.toHaveProperty('top_k');
    }

    // Effort-only request without explicit enabled still enables adaptive thinking
    await p.complete(
      {
        model: 'claude-sonnet-5-5',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 512,
        reasoning: { effort: 'xhigh' },
      },
      { signal: new AbortController().signal },
    );
    expect(captured?.['thinking']).toEqual({ type: 'adaptive' });
    expect(captured?.['output_config']).toEqual({ effort: 'xhigh' });

    // `minimal` maps to Anthropic's lowest valid effort (`low`)
    await p.complete(
      {
        model: 'claude-fable-5-2',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 4096,
        reasoning: { effort: 'minimal' },
      },
      { signal: new AbortController().signal },
    );
    expect(captured?.['thinking']).toEqual({ type: 'adaptive' });
    expect(captured?.['output_config']).toEqual({ effort: 'low' });

    // Enabled without explicit effort omits output_config
    await p.complete(
      {
        model: 'claude-opus-5-5',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 4096,
        reasoning: { enabled: true },
      },
      { signal: new AbortController().signal },
    );
    expect(captured?.['thinking']).toEqual({ type: 'adaptive' });
    expect(captured).not.toHaveProperty('output_config');

    // Disabled / effort: 'none' sends thinking.disabled without output_config
    await p.complete(
      {
        model: 'claude-opus-5-5',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 4096,
        reasoning: { effort: 'none' },
      },
      { signal: new AbortController().signal },
    );
    expect(captured?.['thinking']).toEqual({ type: 'disabled' });
    expect(captured).not.toHaveProperty('output_config');
  });

  it('keeps legacy thinking.enabled + budget_tokens for Claude 4.0–4.5 and 3.7 models', async () => {
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

    for (const model of [
      'claude-3-7-sonnet-20250219',
      'claude-sonnet-4-20250514',
      'claude-opus-4-1',
      'claude-sonnet-4-5-20250929',
    ]) {
      await p.complete(
        {
          model,
          messages: [{ role: 'user', content: 'hi' }],
          maxTokens: 8192,
          reasoning: { enabled: true, effort: 'high' },
        },
        { signal: new AbortController().signal },
      );
      expect(captured?.['thinking']).toMatchObject({ type: 'enabled' });
      expect(captured).not.toHaveProperty('output_config');
    }
  });

  it('learns and retries without output_config.effort when a 400 rejects it', async () => {
    resetEffortSupport();
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_url: unknown, init: { body?: string } = {}) => {
      bodies.push(JSON.parse(init.body ?? '{}'));
      if (bodies.length === 1) {
        return {
          ok: false,
          status: 400,
          text: async () =>
            JSON.stringify({
              type: 'error',
              error: {
                type: 'invalid_request_error',
                message: 'output_config.effort: unsupported value "xhigh"',
              },
            }),
        };
      }
      const enc = new TextEncoder();
      const sse = [
        `data: ${JSON.stringify({ type: 'message_start', message: { model: 'claude-opus-5-5', usage: { input_tokens: 1 } } })}\n\n`,
        `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } })}\n\n`,
        `data: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
      ].join('');
      return {
        ok: true,
        status: 200,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(enc.encode(sse));
            controller.close();
          },
        }),
        text: async () => '',
      };
    }) as never as typeof fetch;

    try {
      const p = new AnthropicProvider({ apiKey: 'k', fetchImpl });
      await p.complete(
        {
          model: 'claude-opus-5-5',
          messages: [{ role: 'user', content: 'hi' }],
          maxTokens: 4096,
          reasoning: { enabled: true, effort: 'xhigh' },
        },
        { signal: new AbortController().signal },
      );
      expect(bodies).toHaveLength(2);
      expect(bodies[0]?.['thinking']).toEqual({ type: 'adaptive' });
      expect(bodies[0]?.['output_config']).toEqual({ effort: 'xhigh' });
      expect(bodies[1]?.['thinking']).toEqual({ type: 'adaptive' });
      expect(bodies[1]).not.toHaveProperty('output_config');
    } finally {
      resetEffortSupport();
    }
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

  function toolList(names: string[]): import('@wrongstack/contracts/types').Tool[] {
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
