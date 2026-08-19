import type { Tool } from '@wrongstack/core/types';
import { describe, expect, it, vi } from 'vitest';
import { isCompatibilityQuirks, OpenAICompatibleProvider } from '../src/openai-compatible.js';

// ── isCompatibilityQuirks (type guard) ────────────────────────────

describe('isCompatibilityQuirks', () => {
  it('returns true for undefined (no quirks)', () => {
    expect(isCompatibilityQuirks(undefined)).toBe(true);
  });

  it('returns false for null', () => {
    expect(isCompatibilityQuirks(null)).toBe(false);
  });

  it('returns false for non-object types', () => {
    expect(isCompatibilityQuirks('string')).toBe(false);
    expect(isCompatibilityQuirks(42)).toBe(false);
    expect(isCompatibilityQuirks(true)).toBe(false);
  });

  it('returns false for arrays', () => {
    expect(isCompatibilityQuirks([])).toBe(false);
  });

  it('returns true for empty object', () => {
    expect(isCompatibilityQuirks({})).toBe(true);
  });

  it('accepts valid boolean quirk keys', () => {
    expect(isCompatibilityQuirks({ stripCacheControl: true })).toBe(true);
    expect(isCompatibilityQuirks({ systemAsMessage: false })).toBe(true);
    expect(isCompatibilityQuirks({ flattenContentToString: true })).toBe(true);
    expect(isCompatibilityQuirks({ preserveToolCallIds: false })).toBe(true);
    expect(isCompatibilityQuirks({ parallelToolsDisabled: true })).toBe(true);
    expect(isCompatibilityQuirks({})).toBe(true);
    expect(isCompatibilityQuirks({ stripThinkTags: false })).toBe(true);
  });

  it('rejects unknown keys', () => {
    expect(isCompatibilityQuirks({ unknownKey: true })).toBe(false);
  });

  it('rejects non-boolean values for boolean keys', () => {
    expect(isCompatibilityQuirks({ stripCacheControl: 'yes' })).toBe(false);
    expect(isCompatibilityQuirks({ parallelToolsDisabled: 1 })).toBe(false);
  });

  it('accepts valid emptyToolCallContent values', () => {
    expect(isCompatibilityQuirks({ emptyToolCallContent: 'null' })).toBe(true);
    expect(isCompatibilityQuirks({ emptyToolCallContent: 'empty_string' })).toBe(true);
  });

  it('rejects invalid emptyToolCallContent values', () => {
    expect(isCompatibilityQuirks({ emptyToolCallContent: 'invalid' })).toBe(false);
    expect(isCompatibilityQuirks({ emptyToolCallContent: true })).toBe(false);
  });

  it('accepts valid thinkingParam values', () => {
    expect(isCompatibilityQuirks({ thinkingParam: 'zai-glm' })).toBe(true);
    expect(isCompatibilityQuirks({ thinkingParam: 'kimi-toggle' })).toBe(true);
    expect(isCompatibilityQuirks({ thinkingParam: 'always-on' })).toBe(true);
  });

  it('rejects invalid thinkingParam values', () => {
    expect(isCompatibilityQuirks({ thinkingParam: 'invalid' })).toBe(false);
    expect(isCompatibilityQuirks({ thinkingParam: true })).toBe(false);
  });

  it('accepts multiple valid keys at once', () => {
    expect(
      isCompatibilityQuirks({
        stripCacheControl: true,
        emptyToolCallContent: 'null',
        thinkingParam: 'always-on',
      }),
    ).toBe(true);
  });

  // ── maxTools ───────────────────────────────────────────────

  it('accepts valid maxTools values', () => {
    expect(isCompatibilityQuirks({ maxTools: 1 })).toBe(true);
    expect(isCompatibilityQuirks({ maxTools: 128 })).toBe(true);
    expect(isCompatibilityQuirks({ maxTools: 1000 })).toBe(true);
  });

  it('rejects non-positive maxTools values', () => {
    expect(isCompatibilityQuirks({ maxTools: 0 })).toBe(false);
    expect(isCompatibilityQuirks({ maxTools: -1 })).toBe(false);
  });

  it('rejects non-integer maxTools values', () => {
    expect(isCompatibilityQuirks({ maxTools: 2.5 })).toBe(false);
    expect(isCompatibilityQuirks({ maxTools: NaN })).toBe(false);
  });

  it('rejects non-number maxTools values', () => {
    expect(isCompatibilityQuirks({ maxTools: '128' })).toBe(false);
    expect(isCompatibilityQuirks({ maxTools: true })).toBe(false);
    expect(isCompatibilityQuirks({ maxTools: null })).toBe(false);
  });
});

function mockFetchSpy() {
  return vi.fn(async (_url: unknown, init?: { headers?: Record<string, string> }) => {
    return {
      ok: true,
      status: 200,
      headers: init?.headers,
      json: async () => ({
        model: 'm',
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
      text: async () => '',
      body: null as ReadableStream<Uint8Array> | NodeJS.ReadableStream | null,
    };
  });
}

/** A fetch that streams a single SSE `data:` frame then closes. */
function sseFetch(frames: string[]): typeof fetch {
  const text = frames.map((d) => `data: ${d}\n\n`).join('');
  return (async () =>
    ({
      ok: true,
      status: 200,
      text: async () => '',
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(text));
          controller.close();
        },
      }),
    }) as never as Response) as never as typeof fetch;
}

describe('OpenAICompatibleProvider', () => {
  it('injects custom headers on each request', async () => {
    const spy = mockFetchSpy();
    const p = new OpenAICompatibleProvider({
      id: 'groq',
      apiKey: 'sk-x',
      baseUrl: 'https://api.groq.com/openai/v1',
      headers: { 'x-custom': '1' },
      fetchImpl: spy as never as typeof fetch,
    });
    await p.complete(
      { model: 'm', messages: [{ role: 'user', content: 'hi' }], maxTokens: 1 },
      { signal: new AbortController().signal },
    );
    const [, init] = spy.mock.calls[0]!;
    expect((init!.headers as Record<string, string>)['x-custom']).toBe('1');
    expect((init!.headers as Record<string, string>)['authorization']).toMatch(/Bearer sk-x/);
  });

  it('buildHeaders filters caller-supplied auth/content-type/accept (case-insensitive)', async () => {
    // Regression: OpenAICompatibleProvider.buildHeaders used to spread
    // `...this.extraHeaders` AFTER `super.buildHeaders(req)`, so caller keys
    // like `Authorization` / `Content-Type` / `Accept` would override auth
    // and the SSE content-type. HTTP header names are case-insensitive, so
    // the filter has to compare lowercased keys against the protected set —
    // a literal `delete headers.authorization` would miss `Authorization`,
    // `AUTHORIZATION`, etc.
    const spy = mockFetchSpy();
    const p = new OpenAICompatibleProvider({
      id: 'groq',
      apiKey: 'sk-x',
      baseUrl: 'https://api.groq.com/openai/v1',
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
      fetchImpl: spy as never as typeof fetch,
    });
    await p.complete(
      { model: 'm', messages: [{ role: 'user', content: 'hi' }], maxTokens: 1 },
      { signal: new AbortController().signal },
    );
    const [, init] = spy.mock.calls[0]!;
    const headers = init!.headers as Record<string, string>;
    // Caller identity / routing headers survive.
    expect(headers['x-tenant-id']).toBe('tenant-42');
    // Provider-required auth + content-type + accept always win, regardless
    // of the case the caller used.
    expect(headers['authorization']).toMatch(/Bearer sk-x/);
    expect(headers['content-type']).toBe('application/json');
    expect(headers['accept']).toBe('text/event-stream');
  });

  it('recovers input tokens from total_tokens when prompt_tokens is absent (MiniMax)', async () => {
    // MiniMax (api.minimax.io) streams usage with only total_tokens +
    // completion_tokens. Deriving input = total − completion keeps the context
    // meter and ↑ sent-token counter from collapsing to 0.
    const p = new OpenAICompatibleProvider({
      id: 'minimax',
      apiKey: 'k',
      baseUrl: 'https://api.minimax.io/v1',
      fetchImpl: sseFetch([
        JSON.stringify({
          model: 'MiniMax-M3',
          choices: [{ delta: { content: 'hi' } }],
        }),
        JSON.stringify({
          model: 'MiniMax-M3',
          choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: { total_tokens: 5200, completion_tokens: 200 },
        }),
        '[DONE]',
      ]),
    });
    const res = await p.complete(
      { model: 'MiniMax-M3', messages: [{ role: 'user', content: 'hi' }], maxTokens: 16 },
      { signal: new AbortController().signal },
    );
    expect(res.usage).toMatchObject({ input: 5000, output: 200 });
  });

  it('honours capabilities override', () => {
    const p = new OpenAICompatibleProvider({
      id: 'xai',
      apiKey: 'k',
      baseUrl: 'https://api.x.ai/v1',
      capabilities: { vision: false, maxContext: 32_000 },
    });
    expect(p.capabilities.vision).toBe(false);
    expect(p.capabilities.maxContext).toBe(32_000);
  });

  it('disables parallel tools when quirk set', () => {
    const p = new OpenAICompatibleProvider({
      id: 'cerebras',
      apiKey: 'k',
      baseUrl: 'https://api.cerebras.ai/v1',
      quirks: { parallelToolsDisabled: true },
    });
    expect(p.capabilities.parallelTools).toBe(false);
  });

  it('honours urlOverride for non-standard URL structures', async () => {
    const spy = mockFetchSpy();
    const p = new OpenAICompatibleProvider({
      id: 'custom',
      apiKey: 'k',
      baseUrl: 'https://api.example.com',
      urlOverride: (baseUrl, _req) => baseUrl + '/v2/chat',
      fetchImpl: spy as never as typeof fetch,
    });
    await p.complete(
      { model: 'm', messages: [{ role: 'user', content: 'hi' }], maxTokens: 1 },
      { signal: new AbortController().signal },
    );
    const [url] = spy.mock.calls[0]!;
    expect(url).toBe('https://api.example.com/v2/chat');
  });

  it('keeps the legacy max_tokens field (compatible endpoints reject max_completion_tokens) (#10)', async () => {
    let captured: Record<string, unknown> | undefined;
    const spy = vi.fn(async (_url: unknown, init: { body?: string } = {}) => {
      captured = JSON.parse(init.body ?? '{}');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          model: 'm',
          choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        text: async () => '',
      };
    }) as never as typeof fetch;
    const p = new OpenAICompatibleProvider({
      id: 'groq',
      apiKey: 'k',
      baseUrl: 'https://api.groq.com/openai/v1',
      fetchImpl: spy,
    });
    await p.complete(
      { model: 'm', messages: [{ role: 'user', content: 'hi' }], maxTokens: 128 },
      { signal: new AbortController().signal },
    );
    expect(captured?.['max_tokens']).toBe(128);
    expect(captured?.['max_completion_tokens']).toBeUndefined();
  });

  it('maps Z.AI disabled thinking and compatibility effort aliases', async () => {
    let captured: Record<string, unknown> | undefined;
    const spy = vi.fn(async (_url: unknown, init: { body?: string } = {}) => {
      captured = JSON.parse(init.body ?? '{}');
      return {
        ok: true,
        status: 200,
        json: async () => ({ model: 'm', choices: [], usage: {} }),
        text: async () => '',
      };
    }) as never as typeof fetch;
    const p = new OpenAICompatibleProvider({
      id: 'zai',
      apiKey: 'k',
      baseUrl: 'https://api.z.ai/api/paas/v4',
      quirks: { thinkingParam: 'zai-glm' },
      fetchImpl: spy,
    });
    await p.complete(
      {
        model: 'glm-5.2',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 1,
        reasoning: { enabled: true, effort: 'medium' },
      },
      { signal: new AbortController().signal },
    );
    expect(captured?.['reasoning_effort']).toBe('high');

    await p.complete(
      {
        model: 'glm-5.2',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 1,
        reasoning: { enabled: false },
      },
      { signal: new AbortController().signal },
    );
    expect(captured?.['thinking']).toEqual({ type: 'disabled' });
  });

  it('does not send disabled thinking to always-on compatible models', async () => {
    let captured: Record<string, unknown> | undefined;
    const spy = vi.fn(async (_url: unknown, init: { body?: string } = {}) => {
      captured = JSON.parse(init.body ?? '{}');
      return {
        ok: true,
        status: 200,
        json: async () => ({ model: 'm', choices: [], usage: {} }),
        text: async () => '',
      };
    }) as never as typeof fetch;
    const p = new OpenAICompatibleProvider({
      id: 'moonshot',
      apiKey: 'k',
      baseUrl: 'https://api.moonshot.ai/v1',
      quirks: { thinkingParam: 'always-on' },
      fetchImpl: spy,
    });
    await p.complete(
      {
        model: 'kimi-k2.7-code',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 1,
        reasoning: { enabled: false },
      },
      { signal: new AbortController().signal },
    );
    expect(captured?.['thinking']).toBeUndefined();
  });

  it('maps the effort levels the base builder drops onto reasoning_effort (#14)', async () => {
    let captured: Record<string, unknown> | undefined;
    const spy = vi.fn(async (_url: unknown, init: { body?: string } = {}) => {
      captured = JSON.parse(init.body ?? '{}');
      return {
        ok: true,
        status: 200,
        json: async () => ({ model: 'm', choices: [], usage: {} }),
        text: async () => '',
      };
    }) as never as typeof fetch;
    const p = new OpenAICompatibleProvider({
      id: 'deepseek',
      apiKey: 'k',
      baseUrl: 'https://api.deepseek.com/v1',
      fetchImpl: spy,
    });
    // `max` is outside OpenAI's accepted set, so the base builder dropped it
    // entirely before this fix; it now collapses onto `high`.
    await p.complete(
      {
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 1,
        reasoning: { effort: 'max' },
      },
      { signal: new AbortController().signal },
    );
    expect(captured?.['reasoning_effort']).toBe('high');

    // `minimal` collapses onto `low`.
    await p.complete(
      {
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 1,
        reasoning: { effort: 'minimal' },
      },
      { signal: new AbortController().signal },
    );
    expect(captured?.['reasoning_effort']).toBe('low');
  });

  it('leaves base-handled efforts untouched and skips when reasoning is disabled (#14)', async () => {
    let captured: Record<string, unknown> | undefined;
    const spy = vi.fn(async (_url: unknown, init: { body?: string } = {}) => {
      captured = JSON.parse(init.body ?? '{}');
      return {
        ok: true,
        status: 200,
        json: async () => ({ model: 'm', choices: [], usage: {} }),
        text: async () => '',
      };
    }) as never as typeof fetch;
    const p = new OpenAICompatibleProvider({
      id: 'deepseek',
      apiKey: 'k',
      baseUrl: 'https://api.deepseek.com/v1',
      fetchImpl: spy,
    });
    // medium is in OpenAI's set — emitted verbatim by the base builder, not remapped.
    await p.complete(
      {
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 1,
        reasoning: { effort: 'medium' },
      },
      { signal: new AbortController().signal },
    );
    expect(captured?.['reasoning_effort']).toBe('medium');

    // An out-of-set effort with reasoning explicitly disabled is not injected.
    await p.complete(
      {
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 1,
        reasoning: { enabled: false, effort: 'max' },
      },
      { signal: new AbortController().signal },
    );
    expect(captured?.['reasoning_effort']).toBeUndefined();
  });

  it('suppresses reasoning_effort under tools uniformly on policy-less gateways', async () => {
    // The old chain was inverted: with tools present the base builder dropped
    // low/medium/high/none while the generic fill re-added minimal/xhigh/max
    // as mapped extremes. Now EVERY effort level is dropped under tools for a
    // generic (policy-less) endpoint, including the mapped ones.
    let captured: Record<string, unknown> | undefined;
    const spy = vi.fn(async (_url: unknown, init: { body?: string } = {}) => {
      captured = JSON.parse(init.body ?? '{}');
      return {
        ok: true,
        status: 200,
        json: async () => ({ model: 'm', choices: [], usage: {} }),
        text: async () => '',
      };
    }) as never as typeof fetch;
    const p = new OpenAICompatibleProvider({
      id: 'some-generic-gateway', // no requestPolicy, no thinkingParam quirk
      apiKey: 'k',
      baseUrl: 'https://gateway.example.com/v1',
      fetchImpl: spy,
    });
    const tools = [{ name: 'read', description: 'Read', inputSchema: {} }];

    // Verbatim-level effort: dropped under tools.
    await p.complete(
      { model: 'm', messages: [{ role: 'user', content: 'hi' }], maxTokens: 1, reasoning: { effort: 'medium' }, tools },
      { signal: new AbortController().signal },
    );
    expect(captured).not.toHaveProperty('reasoning_effort');

    // Mapped-level effort (max → high via the generic fill): ALSO dropped.
    await p.complete(
      { model: 'm', messages: [{ role: 'user', content: 'hi' }], maxTokens: 1, reasoning: { effort: 'max' }, tools },
      { signal: new AbortController().signal },
    );
    expect(captured).not.toHaveProperty('reasoning_effort');

    // Without tools the mapped fill still reaches the wire.
    await p.complete(
      { model: 'm', messages: [{ role: 'user', content: 'hi' }], maxTokens: 1, reasoning: { effort: 'max' } },
      { signal: new AbortController().signal },
    );
    expect(captured?.['reasoning_effort']).toBe('high');
  });

  it('keeps reasoning_effort under tools for zai-glm quirk providers', async () => {
    // The zai-glm quirk writes a deliberate Z.AI-contract mapping; the gateway
    // suppression must not undo it.
    let captured: Record<string, unknown> | undefined;
    const spy = vi.fn(async (_url: unknown, init: { body?: string } = {}) => {
      captured = JSON.parse(init.body ?? '{}');
      return {
        ok: true,
        status: 200,
        json: async () => ({ model: 'm', choices: [], usage: {} }),
        text: async () => '',
      };
    }) as never as typeof fetch;
    const p = new OpenAICompatibleProvider({
      id: 'zai',
      apiKey: 'k',
      baseUrl: 'https://api.z.ai/api/paas/v4',
      quirks: { thinkingParam: 'zai-glm' },
      fetchImpl: spy,
    });
    await p.complete(
      {
        model: 'glm-5.2',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 1,
        reasoning: { enabled: true, effort: 'medium' },
        tools: [{ name: 'read', description: 'Read', inputSchema: {} }],
      },
      { signal: new AbortController().signal },
    );
    expect(captured?.['reasoning_effort']).toBe('high');
  });

  it('works without custom headers', async () => {
    const spy = mockFetchSpy();
    const p = new OpenAICompatibleProvider({
      id: 'plain',
      apiKey: 'k',
      baseUrl: 'https://example.com/v1',
      fetchImpl: spy as never as typeof fetch,
    });
    const res = await p.complete(
      { model: 'm', messages: [{ role: 'user', content: 'hi' }], maxTokens: 1 },
      { signal: new AbortController().signal },
    );
    expect(res.stopReason).toBe('end_turn');
  });

  // ── maxTools ───────────────────────────────────────────────

  function captureBodySpy(): { spy: typeof fetch; getBody: () => Record<string, unknown> } {
    let captured: Record<string, unknown> | undefined;
    const spy = vi.fn(async (_url: unknown, init: { body?: string } = {}) => {
      captured = JSON.parse(init.body ?? '{}');
      return {
        ok: true,
        status: 200,
        json: async () => ({ model: 'm', choices: [], usage: {} }),
        text: async () => '',
      };
    }) as never as typeof fetch;
    return { spy, getBody: () => captured ?? {} };
  }

  function toolList(names: string[]): Tool[] {
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
    const { spy, getBody } = captureBodySpy();
    const p = new OpenAICompatibleProvider({
      id: 'capped-proxy',
      apiKey: 'k',
      baseUrl: 'https://proxy.example.test/v1',
      quirks: { maxTools: 3 },
      fetchImpl: spy,
    });
    await p.complete(
      {
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 1,
        tools: toolList(['read', 'write', 'bash', 'lint_gate_status', 'secret_scanner_test']),
      },
      { signal: new AbortController().signal },
    );
    const wireTools = getBody()['tools'] as Array<{ function: { name: string } }>;
    expect(wireTools).toHaveLength(3);
    const names = wireTools.map((t) => t.function.name);
    expect(names).toContain('read');
    expect(names).toContain('write');
    expect(names).toContain('bash');
    expect(names).not.toContain('lint_gate_status');
  });

  it('preserves all tools when under maxTools limit', async () => {
    const { spy, getBody } = captureBodySpy();
    const p = new OpenAICompatibleProvider({
      id: 'capped-proxy',
      apiKey: 'k',
      baseUrl: 'https://proxy.example.test/v1',
      quirks: { maxTools: 128 },
      fetchImpl: spy,
    });
    const tools = toolList(['read', 'write', 'bash']);
    await p.complete(
      {
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 1,
        tools,
      },
      { signal: new AbortController().signal },
    );
    const wireTools = getBody()['tools'] as Array<{ function: { name: string } }>;
    expect(wireTools).toHaveLength(3);
  });

  it('falls back to auto tool_choice when the chosen tool is filtered out', async () => {
    const { spy, getBody } = captureBodySpy();
    const p = new OpenAICompatibleProvider({
      id: 'capped-proxy',
      apiKey: 'k',
      baseUrl: 'https://proxy.example.test/v1',
      quirks: { maxTools: 1 },
      fetchImpl: spy,
    });
    await p.complete(
      {
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 1,
        tools: toolList(['read', 'lint_gate_status']),
        toolChoice: { type: 'tool', name: 'lint_gate_status' },
      },
      { signal: new AbortController().signal },
    );
    // Only 'read' survives (priority 0); toolChoice fell back to 'auto'.
    expect(getBody()['tool_choice']).toBe('auto');
    const wireTools = getBody()['tools'] as Array<{ function: { name: string } }>;
    expect(wireTools).toHaveLength(1);
    expect(wireTools[0]!.function.name).toBe('read');
  });

  it('keeps tool_choice when the chosen tool survives filtering', async () => {
    const { spy, getBody } = captureBodySpy();
    const p = new OpenAICompatibleProvider({
      id: 'capped-proxy',
      apiKey: 'k',
      baseUrl: 'https://proxy.example.test/v1',
      quirks: { maxTools: 2 },
      fetchImpl: spy,
    });
    await p.complete(
      {
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 1,
        tools: toolList(['read', 'write', 'lint_gate_status']),
        toolChoice: { type: 'tool', name: 'write' },
      },
      { signal: new AbortController().signal },
    );
    const tc = getBody()['tool_choice'] as { function: { name: string } };
    expect(tc.function.name).toBe('write');
  });
});
