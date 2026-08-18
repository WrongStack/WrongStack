/**
 * Coverage tests for openai-responses.ts (new file, 0% coverage).
 */

import { ProviderError } from '@wrongstack/core/types';
import { describe, expect, it, vi } from 'vitest';

describe('OpenAIResponsesProvider', () => {
  it('constructs with basic options', async () => {
    const { OpenAIResponsesProvider } = await import('../src/openai-responses.js');
    const p = new OpenAIResponsesProvider({
      id: 'my-openai',
      apiKey: 'sk-xxx',
      baseUrl: 'https://api.openai.com/v1',
    });
    expect(p.id).toBe('my-openai');
    expect(p.capabilities).toBeDefined();
  });

  it('buildUrl normalizes with /v1/responses suffix', async () => {
    const { OpenAIResponsesProvider } = await import('../src/openai-responses.js');
    const p = new OpenAIResponsesProvider({
      id: 't',
      apiKey: 'k',
      baseUrl: 'https://api.openai.com/v1',
    });
    // Access buildUrl via the protected method — use complete() to trigger it
    const url = (p as any).buildUrl({ model: 'gpt-4' });
    expect(url).toBe('https://api.openai.com/v1/responses');
  });

  it('buildUrl appends /responses when base does not end with versioned path', async () => {
    const { OpenAIResponsesProvider } = await import('../src/openai-responses.js');
    const p = new OpenAIResponsesProvider({
      id: 't',
      apiKey: 'k',
      baseUrl: 'https://api.example.com',
    });
    const url = (p as any).buildUrl({ model: 'gpt-4' });
    expect(url).toBe('https://api.example.com/v1/responses');
  });

  it('buildUrl returns base unchanged when it already ends with /responses', async () => {
    const { OpenAIResponsesProvider } = await import('../src/openai-responses.js');
    const p = new OpenAIResponsesProvider({
      id: 't',
      apiKey: 'k',
      baseUrl: 'https://api.example.com/v1/responses',
    });
    const url = (p as any).buildUrl({ model: 'gpt-4' });
    expect(url).toBe('https://api.example.com/v1/responses');
  });

  it('buildHeaders returns auth and extra headers', async () => {
    const { OpenAIResponsesProvider } = await import('../src/openai-responses.js');
    const p = new OpenAIResponsesProvider({
      id: 't',
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      headers: { 'X-Custom': 'value' },
    });
    const h = (p as any).buildHeaders({ model: 'gpt-4' });
    expect(h.authorization).toBe('Bearer sk-test');
    expect(h['X-Custom']).toBe('value');
  });

  it('buildHeaders filters caller-supplied auth/content-type/accept (case-insensitive)', async () => {
    // Regression: OpenAIResponsesProvider.buildHeaders used to spread
    // `...this.extraHeaders` AFTER the provider's `authorization: Bearer …`,
    // so caller keys like `Authorization` / `Content-Type` / `Accept` would
    // override auth and the SSE content-type. HTTP header names are
    // case-insensitive, so the filter has to compare lowercased keys
    // against the protected set — a literal `delete headers.authorization`
    // would miss `Authorization`, `AUTHORIZATION`, etc.
    const { OpenAIResponsesProvider } = await import('../src/openai-responses.js');
    const p = new OpenAIResponsesProvider({
      id: 't',
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      headers: {
        'x-tenant-id': 'tenant-42',
        // Mixed-case caller keys exercise the case-insensitive protected set.
        authorization: ['Bearer', 'should-be-ignored'].join(' '),
        Authorization: ['Bearer', 'should-be-ignored'].join(' '),
        'content-type': 'text/html',
        'Content-Type': 'text/html',
        accept: 'text/html',
        Accept: 'text/html',
      },
    });
    const h = (p as any).buildHeaders({ model: 'gpt-4' });
    // Caller identity / routing headers survive.
    expect(h['x-tenant-id']).toBe('tenant-42');
    // Provider-required auth + content-type + accept always win, regardless
    // of the case the caller used.
    expect(h.authorization).toBe('Bearer sk-test');
    expect(h['content-type']).toBe('application/json');
    expect(h.accept).toBe('text/event-stream');
  });

  it('buildBody includes instructions when system is present', async () => {
    const { OpenAIResponsesProvider } = await import('../src/openai-responses.js');
    const p = new OpenAIResponsesProvider({
      id: 't',
      apiKey: 'k',
      baseUrl: 'https://api.openai.com/v1',
    });
    const body = (p as any).buildBody(
      {
        model: 'gpt-4',
        system: [{ text: 'You are helpful.' }],
        messages: [{ role: 'user', content: 'hello' }],
        maxTokens: 500,
        temperature: 0.7,
        reasoning: { effort: 'medium', enabled: true },
      },
      { capabilities: {} },
    );
    expect(body.model).toBe('gpt-4');
    expect(body.stream).toBe(true);
    expect(body.instructions).toBe('You are helpful.');
    expect(body.max_output_tokens).toBe(500);
    expect(body.temperature).toBe(0.7);
    expect(body.reasoning).toEqual({ effort: 'medium', summary: 'auto' });
  });

  it('buildBody omits instructions when system is absent', async () => {
    const { OpenAIResponsesProvider } = await import('../src/openai-responses.js');
    const p = new OpenAIResponsesProvider({
      id: 't',
      apiKey: 'k',
      baseUrl: 'https://api.openai.com/v1',
    });
    const body = (p as any).buildBody(
      { model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] },
      { capabilities: {} },
    );
    expect(body.instructions).toBeUndefined();
  });

  it('buildBody includes tools when provided', async () => {
    const { OpenAIResponsesProvider } = await import('../src/openai-responses.js');
    const p = new OpenAIResponsesProvider({
      id: 't',
      apiKey: 'k',
      baseUrl: 'https://api.openai.com/v1',
    });
    const body = (p as any).buildBody(
      {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'calc' }],
        tools: [{ name: 'calc', description: 'calculator', inputSchema: {} }],
        toolChoice: undefined,
      },
      { capabilities: {} },
    );
    expect(body.tools).toBeDefined();
    expect(body.parallel_tool_calls).toBe(true);
    expect(body.tool_choice).toBe('auto');
  });

  it('buildBody uses "required" tool_choice', async () => {
    const { OpenAIResponsesProvider } = await import('../src/openai-responses.js');
    const p = new OpenAIResponsesProvider({
      id: 't',
      apiKey: 'k',
      baseUrl: 'https://api.openai.com/v1',
    });
    const body = (p as any).buildBody(
      {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'calc' }],
        tools: [{ name: 'calc', description: 'calculator', inputSchema: {} }],
        toolChoice: 'required',
      },
      { capabilities: {} },
    );
    expect(body.tool_choice).toBe('required');
  });

  it('buildBody omits reasoning when reasoning.enabled is false', async () => {
    const { OpenAIResponsesProvider } = await import('../src/openai-responses.js');
    const p = new OpenAIResponsesProvider({
      id: 't',
      apiKey: 'k',
      baseUrl: 'https://api.openai.com/v1',
    });
    const body = (p as any).buildBody(
      {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'hi' }],
        reasoning: { effort: 'medium', enabled: false },
      },
      { capabilities: {} },
    );
    expect(body.reasoning).toBeUndefined();
  });

  it('supportedResponsesEffort passes valid efforts through', async () => {
    const mod = await import('../src/openai-responses.js');
    // Access via an instance method that uses supportedResponsesEffort
    const p = new mod.OpenAIResponsesProvider({
      id: 't',
      apiKey: 'k',
      baseUrl: 'https://api.openai.com/v1',
    });
    // 'xhigh' should be valid
    const body = (p as any).buildBody(
      {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'hi' }],
        reasoning: { effort: 'xhigh', enabled: true },
      },
      { capabilities: {} },
    );
    expect(body.reasoning).toEqual({ effort: 'xhigh', summary: 'auto' });
  });

  it('parseStream delegates to parseOpenAIResponsesStream', async () => {
    const { OpenAIResponsesProvider } = await import('../src/openai-responses.js');
    const p = new OpenAIResponsesProvider({
      id: 'my-provider',
      apiKey: 'k',
      baseUrl: 'https://api.openai.com/v1',
    });
    const result = (p as any).parseStream(null, 'gpt-4');
    // Should be an async iterable
    expect(result[Symbol.asyncIterator]).toBeDefined();
  });

  it('translateError creates ProviderError with the provider id', async () => {
    const { OpenAIResponsesProvider } = await import('../src/openai-responses.js');
    const p = new OpenAIResponsesProvider({
      id: 'custom-id',
      apiKey: 'k',
      baseUrl: 'https://api.openai.com/v1',
    });
    const err = (p as any).translateError(
      401,
      'unauthorized',
      new Headers({ 'content-type': 'text/plain' }),
    );
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.status).toBe(401);
    expect(err.recoverable).toBe(false);
  });

  it('supports custom fetchImpl', async () => {
    const { OpenAIResponsesProvider } = await import('../src/openai-responses.js');
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => '',
      body: new ReadableStream({
        start(ctrl) {
          ctrl.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          ctrl.close();
        },
      }),
    } as never as Response);
    const p = new OpenAIResponsesProvider({
      id: 'custom-fetch',
      apiKey: 'k',
      baseUrl: 'https://api.openai.com/v1',
      fetchImpl,
    });
    const result = await p.complete(
      { model: 'gpt-4', messages: [{ role: 'user', content: 'hello' }], maxTokens: 10 },
      { signal: new AbortController().signal },
    );
    expect(fetchImpl).toHaveBeenCalled();
    expect(result.stopReason).toBe('end_turn');
  });
});
