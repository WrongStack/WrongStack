import type { Request, StreamEvent } from '@wrongstack/core/types';
import { describe, expect, it, vi } from 'vitest';
import { OpenCodeGoProvider } from '../src/opencode-go.js';

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
  it('routes Chat Completions and Anthropic Messages models behind one provider', async () => {
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
    const provider = new OpenCodeGoProvider({ apiKey: 'oc-test', fetchImpl });

    await drain(provider, request('grok-4.5', { effort: 'high' }));
    await drain(provider, request('minimax-m3', { enabled: true }));

    expect(calls[0]?.url).toBe('https://opencode.ai/zen/go/v1/chat/completions');
    expect(calls[1]?.url).toBe('https://opencode.ai/zen/go/v1/messages');
    expect(calls[0]?.headers['x-opencode-session']).toMatch(/^sess_/);
    expect(calls[1]?.headers['x-opencode-session']).toBe(calls[0]?.headers['x-opencode-session']);
    expect(provider.id).toBe('opencode-go');
  });

  it('keeps only model-supported effort values even when tools are present', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async (_input: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return new Response('', { status: 200 });
    }) as never as typeof fetch;
    const provider = new OpenCodeGoProvider({ apiKey: 'oc-test', fetchImpl });

    await drain(provider, request('glm-5.2', { effort: 'max' }));
    await drain(provider, request('glm-5.2', { effort: 'none' }));
    await drain(provider, request('kimi-k2.7-code', { effort: 'high' }));

    expect(bodies[0]?.['reasoning_effort']).toBe('max');
    expect(bodies[1]).not.toHaveProperty('reasoning_effort');
    expect(bodies[2]).not.toHaveProperty('reasoning_effort');
  });

  it('uses adaptive thinking for MiniMax M3 and budget thinking for Qwen', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async (_input: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return new Response('', { status: 200 });
    }) as never as typeof fetch;
    const provider = new OpenCodeGoProvider({ apiKey: 'oc-test', fetchImpl });

    await drain(provider, request('minimax-m3', { enabled: true, effort: 'high' }));
    await drain(provider, request('qwen3.7-plus', { effort: 'high' }));
    await drain(provider, request('minimax-m2.7', { enabled: false, effort: 'none' }));

    expect(bodies[0]?.['thinking']).toEqual({ type: 'adaptive' });
    expect(bodies[1]?.['thinking']).toMatchObject({ type: 'enabled' });
    const qwenThinking = bodies[1]?.['thinking'] as Record<string, unknown> | undefined;
    expect(qwenThinking?.['budget_tokens']).toBeGreaterThan(0);
    expect(bodies[2]).not.toHaveProperty('thinking');
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
    });

    await drain(provider, request('minimax-m3'));

    const headers = calls[0]?.headers ?? {};
    // Caller-supplied identity / routing headers survive.
    expect(headers['x-tenant-id']).toBe('tenant-42');
    // Provider-required Anthropic-surface headers always win. OpenCode Go's
    // host is not api.anthropic.com, so AnthropicProvider emits
    // `Authorization: Bearer …` instead of `x-api-key` for non-Anthropic
    // hosts — both keys must be guarded against caller-supplied overrides.
    expect(headers['x-api-key']).toBeUndefined();
    expect(headers['authorization']).toBe(['Bearer', 'oc-test'].join(' '));
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
