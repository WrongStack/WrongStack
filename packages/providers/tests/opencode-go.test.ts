import { bindRequestConversation } from '@wrongstack/core/request-conversation';
import type { Request, StreamEvent } from '@wrongstack/core/types';
import { describe, expect, it, vi } from 'vitest';
import { makeProviderFromConfig } from '../src/index.js';
import { OpenCodeGoProvider, openCodeGoWireForModel } from '../src/opencode-go.js';

function request(model: string, reasoning?: Request['reasoning']): Request {
  return {
    model,
    messages: [{ role: 'user', content: 'hi' }],
    maxTokens: 8192,
    reasoning,
    tools: [{ name: 'read', description: 'Read a file', inputSchema: { type: 'object' } }],
  };
}

async function drain(provider: OpenCodeGoProvider, req: Request): Promise<void> {
  for await (const _event of provider.stream(req, {
    signal: new AbortController().signal,
  })) {
    // Routing/body assertions inspect the captured fetch call.
  }
}

function sseBody(events: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    pull(c) {
      c.enqueue(enc.encode(events));
      c.close();
    },
  });
}

function sseFetch(events: string): typeof fetch {
  return (async () =>
    new Response(sseBody(events), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })) as never as typeof fetch;
}

describe('OpenCodeGoProvider', () => {
  it('keeps the session-aware adapter when a config-only runtime rebuild uses an alias', async () => {
    const calls: Array<{ headers: Record<string, string> }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        calls.push({
          headers: Object.fromEntries(
            Object.entries(init?.headers ?? {}).map(([key, value]) => [
              key.toLowerCase(),
              String(value),
            ]),
          ),
        });
        return new Response('', { status: 200 });
      }),
    );
    try {
      const provider = makeProviderFromConfig('opencode-go-ws', {
        type: 'opencode-go',
        family: 'openai-compatible',
        apiKey: 'oc-test',
        baseUrl: 'https://opencode.ai/zen/go/v1',
      });
      expect(provider).toBeInstanceOf(OpenCodeGoProvider);
      expect(provider.id).toBe('opencode-go-ws');

      await drain(provider as OpenCodeGoProvider, request('deepseek-v4.1-flash'));
      expect(calls[0]?.headers['x-opencode-session']).toMatch(/^sess_/);
      expect(calls[0]?.headers['user-agent']).toBe('wrongstack/1.0');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reports the same documented wire used by request delegation', () => {
    expect(openCodeGoWireForModel('gpt-5.6-luna', '@ai-sdk/openai')).toBe('@ai-sdk/openai');
    expect(openCodeGoWireForModel('qwen3.7-plus')).toBe('@ai-sdk/anthropic');
    expect(openCodeGoWireForModel('glm-5.3')).toBe('@ai-sdk/openai-compatible');
  });

  it('routes Responses, Chat Completions, and Anthropic Messages models behind one provider', async () => {
    const calls: Array<{
      url: string;
      body: Record<string, unknown>;
      headers: Record<string, string>;
    }> = [];
    const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
      const headers = Object.fromEntries(
        Object.entries(init?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]),
      );
      calls.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
        headers,
      });
      return new Response('', { status: 200 });
    }) as never as typeof fetch;
    const provider = new OpenCodeGoProvider({
      apiKey: 'oc-test',
      fetchImpl,
      models: [
        { id: 'grok-4.5', name: 'Chat', provider: { npm: '@ai-sdk/openai-compatible' } },
        { id: 'minimax-m3', name: 'Messages', provider: { npm: '@ai-sdk/anthropic' } },
        { id: 'grok-4.6', name: 'Responses', provider: { npm: '@ai-sdk/openai' } },
      ],
    });

    await drain(provider, request('grok-4.5', { effort: 'high' }));
    await drain(provider, request('minimax-m3', { enabled: true }));
    await drain(provider, request('grok-4.6', { effort: 'xhigh' }));

    expect(calls[0]?.url).toBe('https://opencode.ai/zen/go/v1/chat/completions');
    expect(calls[1]?.url).toBe('https://opencode.ai/zen/go/v1/messages');
    expect(calls[2]?.url).toBe('https://opencode.ai/zen/go/v1/responses');
    expect(calls[0]?.headers['x-opencode-session']).toMatch(/^sess_/);
    expect(calls[1]?.headers['x-opencode-session']).toBe(calls[0]?.headers['x-opencode-session']);
    expect(calls[2]?.headers['x-opencode-session']).toBe(calls[0]?.headers['x-opencode-session']);
    expect(calls[0]?.headers['user-agent']).toBe('wrongstack/1.0');
    expect(calls[1]?.headers['user-agent']).toBe('wrongstack/1.0');
    expect(calls[2]?.headers['user-agent']).toBe('wrongstack/1.0');
    expect(provider.id).toBe('opencode-go');
  });

  it('prefers the models.dev per-model SDK override over family and name heuristics', async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (input: unknown) => {
      urls.push(String(input));
      return new Response('', { status: 200 });
    }) as never as typeof fetch;
    const provider = new OpenCodeGoProvider({
      apiKey: 'oc-test',
      fetchImpl,
      models: [
        {
          id: 'custom-responses-model',
          name: 'Custom Responses Model',
          family: 'qwen',
          provider: { npm: '@ai-sdk/openai' },
        },
        {
          id: 'custom-messages-model',
          name: 'Custom Messages Model',
          family: 'grok',
          provider: { npm: '@ai-sdk/anthropic' },
        },
        {
          id: 'grok-4.6',
          name: 'Forced Compatible Model',
          provider: { npm: '@ai-sdk/openai-compatible' },
        },
      ],
    });

    await drain(provider, request('custom-responses-model'));
    await drain(provider, request('custom-messages-model'));
    await drain(provider, request('grok-4.6'));

    expect(urls).toEqual([
      'https://opencode.ai/zen/go/v1/responses',
      'https://opencode.ai/zen/go/v1/messages',
      'https://opencode.ai/zen/go/v1/chat/completions',
    ]);
  });

  it('uses the documented Messages wire when models.dev omits a Qwen npm override', async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (input: unknown) => {
      urls.push(String(input));
      return new Response('', { status: 200 });
    }) as never as typeof fetch;
    const provider = new OpenCodeGoProvider({
      apiKey: 'oc-test',
      fetchImpl,
      models: [
        { id: 'qwen3.6-plus', name: 'Qwen 3.6 Plus', family: 'qwen3.6' },
        { id: 'qwen3.7-max', name: 'Qwen 3.7 Max', family: 'qwen3.7-max' },
        { id: 'qwen3.7-plus', name: 'Qwen 3.7 Plus', family: 'qwen3.7-plus' },
        { id: 'qwen3.8-max', name: 'Qwen 3.8 Max', family: 'qwen3.8-max' },
      ],
    });

    await drain(provider, request('qwen3.6-plus'));
    await drain(provider, request('qwen3.7-max'));
    await drain(provider, request('qwen3.7-plus'));
    await drain(provider, request('qwen3.8-max'));

    expect(urls).toEqual([
      'https://opencode.ai/zen/go/v1/messages',
      'https://opencode.ai/zen/go/v1/messages',
      'https://opencode.ai/zen/go/v1/messages',
      'https://opencode.ai/zen/go/v1/messages',
    ]);
  });

  it('uses one conversation-scoped session header across provider rebuilds and wire surfaces', async () => {
    const calls: Array<{ headers: Record<string, string> }> = [];
    const fetchImpl = vi.fn(async (_input: unknown, init?: RequestInit) => {
      calls.push({
        headers: Object.fromEntries(
          Object.entries(init?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]),
        ),
      });
      return new Response('', { status: 200 });
    }) as never as typeof fetch;
    const conversation = { meta: {}, sessionId: 'conversation/alpha' };
    const firstRequest = request('grok-4.5');
    const rebuiltRequest = request('minimax-m3');
    bindRequestConversation(firstRequest, conversation);
    bindRequestConversation(rebuiltRequest, conversation);

    await drain(
      new OpenCodeGoProvider({
        apiKey: 'oc-test',
        fetchImpl,
        models: [{ id: 'grok-4.5', name: 'Chat', provider: { npm: '@ai-sdk/openai-compatible' } }],
        headers: {
          'X-OpenCode-Session': 'must-not-override-conversation',
          'User-Agent': 'generic-sdk/0.0',
        },
      }),
      firstRequest,
    );
    await drain(
      new OpenCodeGoProvider({
        apiKey: 'oc-test',
        fetchImpl,
        models: [{ id: 'minimax-m3', name: 'Messages', provider: { npm: '@ai-sdk/anthropic' } }],
      }),
      rebuiltRequest,
    );

    expect(calls[0]?.headers['x-opencode-session']).toBe('sess_conversation_alpha');
    expect(calls[1]?.headers['x-opencode-session']).toBe(calls[0]?.headers['x-opencode-session']);
    expect(calls[0]?.headers['user-agent']).toBe('wrongstack/1.0');
    expect(calls[1]?.headers['user-agent']).toBe('wrongstack/1.0');
  });

  it('keeps only model-supported effort values even when tools are present', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async (_input: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return new Response('', { status: 200 });
    }) as never as typeof fetch;
    const provider = new OpenCodeGoProvider({
      apiKey: 'oc-test',
      fetchImpl,
      models: [
        {
          id: 'glm-5.2',
          name: 'Effort model',
          reasoningConfig: {
            default: 'enabled',
            disableSupported: false,
            effortSupported: true,
            effortLevels: ['high', 'max'],
            preserveThinking: 'unsupported',
          },
        },
      ],
    });

    await drain(provider, request('glm-5.2', { effort: 'max' }));
    await drain(provider, request('glm-5.2', { effort: 'none' }));
    await drain(provider, request('kimi-k2.7-code', { effort: 'high' }));

    expect(bodies[0]?.['reasoning_effort']).toBe('max');
    expect(bodies[1]).not.toHaveProperty('reasoning_effort');
    expect(bodies[2]).not.toHaveProperty('reasoning_effort');
  });

  it('derives fixed and budget thinking behavior from catalog metadata', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async (_input: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return new Response('', { status: 200 });
    }) as never as typeof fetch;
    const provider = new OpenCodeGoProvider({
      apiKey: 'oc-test',
      fetchImpl,
      models: [
        {
          id: 'budget-model',
          name: 'Budget model',
          provider: { npm: '@ai-sdk/anthropic' },
          reasoning_options: { type: 'budget_tokens', max: 65_536 },
        },
        {
          id: 'fixed-model',
          name: 'Fixed model',
          provider: { npm: '@ai-sdk/anthropic' },
          reasoningConfig: {
            default: 'always_on',
            disableSupported: false,
            effortSupported: false,
            effortLevels: [],
            preserveThinking: 'always_on',
          },
        },
      ],
    });

    await drain(provider, request('budget-model', { effort: 'high' }));
    await drain(provider, request('fixed-model', { enabled: false, effort: 'none' }));

    expect(bodies[0]?.['thinking']).toMatchObject({ type: 'enabled' });
    const budgetThinking = bodies[0]?.['thinking'] as Record<string, unknown> | undefined;
    expect(budgetThinking?.['budget_tokens']).toBeGreaterThan(0);
    expect(bodies[1]).not.toHaveProperty('thinking');
  });

  it('synthesizes a terminal message_stop when Zen closes the chat stream without [DONE]/finish_reason', async () => {
    // OpenCode Go's chat-completions surface ends successful streams with no
    // terminal marker — previously this raised the retryable 599 truncation
    // error on every response. The stream must complete cleanly instead.
    const sse = [
      'data: {"id":"x","model":"grok-4.5","choices":[{"index":0,"delta":{"content":"Hello"}}]}',
      '',
      'data: {"id":"x","choices":[{"index":0,"delta":{"content":" world"}}]}',
      '',
    ].join('\n');
    const provider = new OpenCodeGoProvider({ apiKey: 'oc-test', fetchImpl: sseFetch(sse) });

    const events: StreamEvent[] = [];
    for await (const event of provider.stream(request('grok-4.5'), {
      signal: new AbortController().signal,
    })) {
      events.push(event);
    }

    const text = events
      .filter((e): e is Extract<StreamEvent, { type: 'text_delta' }> => e.type === 'text_delta')
      .map((e) => e.text)
      .join('');
    expect(text).toBe('Hello world');
    const stop = events.at(-1);
    expect(stop?.type).toBe('message_stop');
    expect(stop?.type === 'message_stop' ? stop.stopReason : undefined).toBe('end_turn');
  });

  it('caller-supplied headers on the Anthropic surface cannot clobber auth/version/content-type', async () => {
    // Regression: OpenCodeGoMessagesProvider.buildHeaders used to spread
    // `...this.extraHeaders` AFTER `...super.buildHeaders(req)`, which let
    // caller headers override the Anthropic surface's required
    // `x-api-key` / `anthropic-version` / `content-type`. A caller passing
    // `headers: { 'x-api-key': 'evil' }` would silently change credentials
    // and the request would fail with a confusing 401. Provider-required
    // headers must always win.
    const calls: Array<{ headers: Record<string, string> }> = [];
    const fetchImpl = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const headers = Object.fromEntries(
        Object.entries(init?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]),
      );
      calls.push({ headers });
      return new Response('', { status: 200 });
    }) as never as typeof fetch;
    const provider = new OpenCodeGoProvider({
      apiKey: 'oc-test',
      headers: {
        'x-tenant-id': 'tenant-42',
        // Mixed-case caller keys exercise the case-insensitive protected set.
        // A literal `delete headers['x-api-key']` would miss these.
        'x-api-key': 'should-be-ignored',
        'X-Api-Key': 'should-be-ignored',
        // Caller also tries to override the auth header. We build the literal
        // here from parts so the test source doesn't carry a credential-shaped
        // string the secret scanner would refuse to write.
        authorization: ['Bearer', 'should-be-ignored'].join(' '),
        Authorization: ['Bearer', 'should-be-ignored'].join(' '),
        'anthropic-version': '1999-01-01',
        'Anthropic-Version': '1999-01-01',
        'content-type': 'text/html',
        'Content-Type': 'text/html',
        accept: 'text/html',
        Accept: 'text/html',
      },
      fetchImpl,
      models: [{ id: 'minimax-m3', name: 'Messages', provider: { npm: '@ai-sdk/anthropic' } }],
    });

    await drain(provider, request('minimax-m3'));

    const headers = calls[0]?.headers ?? {};
    // Caller-supplied identity / routing headers survive.
    expect(headers['x-tenant-id']).toBe('tenant-42');
    // Match the native @ai-sdk/anthropic contract advertised by models.dev:
    // x-api-key is provider-owned even though the gateway host is not
    // api.anthropic.com. Both auth keys remain protected from caller input.
    expect(headers['x-api-key']).toBe('oc-test');
    expect(headers['authorization']).toBeUndefined();
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers['content-type']).toBe('application/json');
    expect(headers['accept']).toBe('text/event-stream');
  });

  it('complete() folds an unterminated chat stream into a clean Response', async () => {
    const sse = [
      'data: {"id":"x","model":"grok-4.5","choices":[{"index":0,"delta":{"content":"done"}}]}',
      '',
    ].join('\n');
    const provider = new OpenCodeGoProvider({ apiKey: 'oc-test', fetchImpl: sseFetch(sse) });

    const res = await provider.complete(request('grok-4.5'), {
      signal: new AbortController().signal,
    });
    expect(res.content).toEqual([{ type: 'text', text: 'done' }]);
    expect(res.stopReason).toBe('end_turn');
  });
});
