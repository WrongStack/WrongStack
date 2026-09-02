import { describe, expect, it, vi } from 'vitest';
import { GoogleProvider } from '../src/google.js';

function mockFetch(json: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => json,
    text: async () => JSON.stringify(json),
  } as never as Response);
}

describe('GoogleProvider', () => {
  // Content-parsing tests live in streaming.test.ts since complete() wraps
  // stream() internally. This file covers headers, URLs, errors, and the
  // request-body shape.

  it('non-2xx becomes ProviderError', async () => {
    const fetchImpl = mockFetch({ error: 'bad' }, 400) as never as typeof fetch;
    const p = new GoogleProvider({ apiKey: 'k', fetchImpl });
    await expect(
      p.complete(
        { model: 'm', messages: [{ role: 'user', content: 'x' }], maxTokens: 1 },
        { signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('requires apiKey', () => {
    expect(() => new GoogleProvider({ apiKey: '' })).toThrow(/apiKey required/);
  });

  it('marks 429 and 5xx as retryable', async () => {
    const fetchImpl = mockFetch({}, 503) as never as typeof fetch;
    const p = new GoogleProvider({ apiKey: 'k', fetchImpl });
    await expect(
      p.complete(
        { model: 'm', messages: [{ role: 'user', content: 'x' }], maxTokens: 1 },
        { signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ status: 503, retryable: true });
  });

  it('translates system, tool, tool_result through wire format', async () => {
    let body: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(async (_url: unknown, init: { body?: string } = {}) => {
      body = JSON.parse(init.body ?? '{}');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [
            { content: { role: 'model', parts: [{ text: 'k' }] }, finishReason: 'stop' },
          ],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
        }),
        text: async () => '',
      };
    }) as never as typeof fetch;
    const p = new GoogleProvider({ apiKey: 'k', fetchImpl });
    await p.complete(
      {
        model: 'gemini-2.5-flash',
        maxTokens: 50,
        temperature: 0.5,
        topP: 0.9,
        stopSequences: ['<end>'],
        system: [{ type: 'text', text: 'be terse' }],
        messages: [
          { role: 'user', content: 'see this' },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'reading' },
              { type: 'tool_use', id: 'tu1', name: 'read', input: { path: 'a' } },
            ],
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'data' }],
          },
        ],
        tools: [
          {
            name: 'read',
            description: 'read',
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
    expect(body?.['systemInstruction']).toEqual({ parts: [{ text: 'be terse' }] });
    const contents = body?.['contents'] as Array<{ role: string; parts: unknown[] }>;
    expect(contents.find((c) => c.role === 'model')).toBeDefined();
    // Tool results are inlined into the user turn with functionResponse parts
    // (Gemini API spec) — not as a separate 'function' role. This was a bug
    // where all-non-text user messages were silently dropped; now fixed.
    const userWithFn = contents.find(
      (c) =>
        c.role === 'user' &&
        (c.parts as unknown[]).some(
          (p) => typeof p === 'object' && 'functionResponse' in (p as object),
        ),
    );
    expect(userWithFn).toBeDefined();
    const tools = body?.['tools'] as Array<{ functionDeclarations: unknown[] }>;
    expect(tools[0]?.functionDeclarations).toHaveLength(1);
    const cfg = body?.['generationConfig'] as Record<string, unknown>;
    expect(cfg['temperature']).toBe(0.5);
    expect(cfg['stopSequences']).toEqual(['<end>']);
  });

  it('translates base64 image to inlineData part', async () => {
    let body: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(async (_url: unknown, init: { body?: string } = {}) => {
      body = JSON.parse(init.body ?? '{}');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] } }],
          usageMetadata: {},
        }),
        text: async () => '',
      };
    }) as never as typeof fetch;
    const p = new GoogleProvider({ apiKey: 'k', fetchImpl });
    await p.complete(
      {
        model: 'gemini',
        maxTokens: 1,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'see' },
              { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAA' } },
            ],
          },
        ],
      },
      { signal: new AbortController().signal },
    );
    const contents = body?.['contents'] as Array<{ parts: Array<Record<string, unknown>> }>;
    const userParts = contents[0]!.parts;
    const inline = userParts.find((p) => p['inlineData']);
    expect(inline?.['inlineData']).toEqual({ mimeType: 'image/jpeg', data: 'AAA' });
  });

  it('echoes thought_signature back on subsequent assistant tool_use parts', async () => {
    let body: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(async (_url: unknown, init: { body?: string } = {}) => {
      body = JSON.parse(init.body ?? '{}');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{ content: { role: 'model', parts: [{ text: 'k' }] } }],
          usageMetadata: {},
        }),
        text: async () => '',
      };
    }) as never as typeof fetch;
    const p = new GoogleProvider({ apiKey: 'k', fetchImpl });
    await p.complete(
      {
        model: 'gemini',
        maxTokens: 1,
        messages: [
          { role: 'user', content: 'do it' },
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'tu1',
                name: 'read',
                input: { path: 'a' },
                providerMeta: { 'google.thoughtSignature': 'SIG-BLOB-123' },
              },
            ],
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'tu1', name: 'read', content: 'ok' }],
          },
        ],
        tools: [
          {
            name: 'read',
            description: 'read',
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
    const contents = body?.['contents'] as Array<{
      role: string;
      parts: Array<Record<string, unknown>>;
    }>;
    const modelTurn = contents.find((c) => c.role === 'model');
    const fc = modelTurn?.parts.find((p) => p['functionCall']);
    expect(fc?.['thoughtSignature']).toBe('SIG-BLOB-123');
  });

  it('strips JSON-Schema keywords Gemini rejects (additionalProperties, $schema, default, allOf)', async () => {
    let body: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(async (_url: unknown, init: { body?: string } = {}) => {
      body = JSON.parse(init.body ?? '{}');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] } }],
          usageMetadata: {},
        }),
        text: async () => '',
      };
    }) as never as typeof fetch;
    const p = new GoogleProvider({ apiKey: 'k', fetchImpl });
    await p.complete(
      {
        model: 'gemini',
        maxTokens: 1,
        messages: [{ role: 'user', content: 'x' }],
        tools: [
          {
            name: 'edit',
            description: 'edit',
            permission: 'auto',
            mutating: true,
            async execute() {
              return '';
            },
            inputSchema: {
              type: 'object',
              $schema: 'http://json-schema.org/draft-07/schema#',
              additionalProperties: false,
              required: ['path'],
              properties: {
                path: { type: 'string', description: 'where' },
                opts: {
                  type: 'object',
                  additionalProperties: false,
                  default: {},
                  properties: {
                    nested: { type: 'string', allOf: [{ minLength: 1 }] },
                  },
                },
                tags: {
                  type: 'array',
                  items: { type: 'string', $ref: '#/defs/Tag' },
                },
              },
            } as Record<string, unknown>,
          },
        ],
      },
      { signal: new AbortController().signal },
    );
    const tools = body?.['tools'] as Array<{
      functionDeclarations: Array<{ parameters: Record<string, unknown> }>;
    }>;
    const params = tools[0]!.functionDeclarations[0]!.parameters;
    // Top-level forbidden keys are gone
    expect(params['additionalProperties']).toBeUndefined();
    expect(params['$schema']).toBeUndefined();
    // Allowed keys survive
    expect(params['type']).toBe('object');
    expect(params['required']).toEqual(['path']);
    const props = params['properties'] as Record<string, Record<string, unknown>>;
    expect(props['path']).toEqual({ type: 'string', description: 'where' });
    // Nested object also sanitized
    expect(props['opts']?.['additionalProperties']).toBeUndefined();
    expect(props['opts']?.['default']).toBeUndefined();
    const nested = (
      props['opts']?.['properties'] as Record<string, Record<string, unknown>> | undefined
    )?.['nested'];
    expect(nested?.['allOf']).toBeUndefined();
    expect(nested?.['type']).toBe('string');
    // Array items sanitized
    expect((props['tags']?.['items'] as Record<string, unknown>)?.['$ref']).toBeUndefined();
    expect((props['tags']?.['items'] as Record<string, unknown>)?.['type']).toBe('string');
  });

  it('sends topK, candidateCount in generationConfig', async () => {
    let captured: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(async (_url: unknown, init: { body?: string } = {}) => {
      captured = JSON.parse(init.body ?? '{}');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [
            { content: { role: 'model', parts: [{ text: 'k' }] }, finishReason: 'stop' },
          ],
          usageMetadata: {},
        }),
        text: async () => '',
      };
    }) as never as typeof fetch;
    const p = new GoogleProvider({ apiKey: 'k', fetchImpl });
    await p.complete(
      {
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 100,
        topK: 40,
        candidateCount: 3,
      },
      { signal: new AbortController().signal },
    );
    const cfg = captured?.['generationConfig'] as Record<string, unknown>;
    expect(cfg['topK']).toBe(40);
    expect(cfg['candidateCount']).toBe(3);
  });

  it('sends frequencyPenalty, presencePenalty, seed in generationConfig', async () => {
    let captured: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(async (_url: unknown, init: { body?: string } = {}) => {
      captured = JSON.parse(init.body ?? '{}');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [
            { content: { role: 'model', parts: [{ text: 'k' }] }, finishReason: 'stop' },
          ],
          usageMetadata: {},
        }),
        text: async () => '',
      };
    }) as never as typeof fetch;
    const p = new GoogleProvider({ apiKey: 'k', fetchImpl });
    await p.complete(
      {
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 100,
        frequencyPenalty: 0.5,
        presencePenalty: 0.3,
        seed: 42,
      },
      { signal: new AbortController().signal },
    );
    const cfg = captured?.['generationConfig'] as Record<string, unknown>;
    expect(cfg['frequencyPenalty']).toBe(0.5);
    expect(cfg['presencePenalty']).toBe(0.3);
    expect(cfg['seed']).toBe(42);
  });

  it('sends logprobs in generationConfig when set', async () => {
    let captured: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(async (_url: unknown, init: { body?: string } = {}) => {
      captured = JSON.parse(init.body ?? '{}');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [
            { content: { role: 'model', parts: [{ text: 'k' }] }, finishReason: 'stop' },
          ],
          usageMetadata: {},
        }),
        text: async () => '',
      };
    }) as never as typeof fetch;
    const p = new GoogleProvider({ apiKey: 'k', fetchImpl });
    await p.complete(
      { model: 'm', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100, logprobs: true },
      { signal: new AbortController().signal },
    );
    const cfg = captured?.['generationConfig'] as Record<string, unknown>;
    expect(cfg['logprobs']).toBe(true);
  });

  it('maps reasoning to real thinkingConfig fields (never a bogus type field)', async () => {
    let captured: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(async (_url: unknown, init: { body?: string } = {}) => {
      captured = JSON.parse(init.body ?? '{}');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [
            { content: { role: 'model', parts: [{ text: 'k' }] }, finishReason: 'stop' },
          ],
          usageMetadata: {},
        }),
        text: async () => '',
      };
    }) as never as typeof fetch;
    const p = new GoogleProvider({ apiKey: 'k', fetchImpl });

    // Gemini 3 + effort → thinkingLevel (the API's real field).
    await p.complete(
      {
        model: 'gemini-3-pro',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 4096,
        reasoning: { effort: 'high' },
      },
      { signal: new AbortController().signal },
    );
    let cfg = (captured as Record<string, unknown>)?.['generationConfig'] as Record<
      string,
      unknown
    >;
    expect(cfg['thinkingConfig']).toEqual({ thinkingLevel: 'high' });

    // Gemini 3 + explicit off → minimal (no off value in the level enum).
    await p.complete(
      {
        model: 'gemini-3-flash',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 4096,
        reasoning: { enabled: false },
      },
      { signal: new AbortController().signal },
    );
    cfg = (captured as Record<string, unknown>)?.['generationConfig'] as Record<string, unknown>;
    expect(cfg['thinkingConfig']).toEqual({ thinkingLevel: 'minimal' });

    // Gemini 2.5 + effort → thinkingBudget derived from the output cap.
    await p.complete(
      {
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 4096,
        reasoning: { effort: 'medium' },
      },
      { signal: new AbortController().signal },
    );
    cfg = (captured as Record<string, unknown>)?.['generationConfig'] as Record<string, unknown>;
    const thinking = cfg['thinkingConfig'] as { thinkingBudget?: number };
    expect(typeof thinking?.thinkingBudget).toBe('number');
    expect(thinking.thinkingBudget).toBeGreaterThanOrEqual(1024);

    // Gemini 2.5 Flash + explicit off → budget 0 (documented off switch).
    await p.complete(
      {
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 4096,
        reasoning: { enabled: false },
      },
      { signal: new AbortController().signal },
    );
    cfg = (captured as Record<string, unknown>)?.['generationConfig'] as Record<string, unknown>;
    expect(cfg['thinkingConfig']).toEqual({ thinkingBudget: 0 });

    // Gemini 2.5 Pro + explicit off → omit: Pro-tier rejects budget 0 with a
    // 400; leaving thinking on is better than failing the request.
    await p.complete(
      {
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 4096,
        reasoning: { enabled: false },
      },
      { signal: new AbortController().signal },
    );
    cfg = (captured as Record<string, unknown>)?.['generationConfig'] as Record<string, unknown>;
    expect(cfg).not.toHaveProperty('thinkingConfig');

    // enabled:true with no effort → dynamic is the API default; send nothing.
    await p.complete(
      {
        model: 'gemini-3-pro',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 4096,
        reasoning: { enabled: true },
      },
      { signal: new AbortController().signal },
    );
    cfg = (captured as Record<string, unknown>)?.['generationConfig'] as Record<string, unknown>;
    expect(cfg).not.toHaveProperty('thinkingConfig');

    // Unknown generation → nothing (never guess a knob).
    await p.complete(
      {
        model: 'gemma-2-2b-it',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 4096,
        reasoning: { effort: 'high' },
      },
      { signal: new AbortController().signal },
    );
    cfg = (captured as Record<string, unknown>)?.['generationConfig'] as Record<string, unknown>;
    expect(cfg).not.toHaveProperty('thinkingConfig');
  });

  it('sends responseMimeType when responseFormat is json_schema', async () => {
    let captured: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(async (_url: unknown, init: { body?: string } = {}) => {
      captured = JSON.parse(init.body ?? '{}');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [
            { content: { role: 'model', parts: [{ text: '{}' }] }, finishReason: 'stop' },
          ],
          usageMetadata: {},
        }),
        text: async () => '',
      };
    }) as never as typeof fetch;
    const p = new GoogleProvider({ apiKey: 'k', fetchImpl });
    await p.complete(
      {
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 100,
        responseFormat: {
          type: 'json_schema',
          jsonSchema: { name: 'p', schema: { type: 'object' } },
        },
      },
      { signal: new AbortController().signal },
    );
    const cfg = captured?.['generationConfig'] as Record<string, unknown>;
    expect(cfg['responseMimeType']).toBe('application/json');
    expect(cfg['responseSchema']).toEqual({ type: 'object' });
  });

  it('sends safetySettings when set', async () => {
    let captured: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(async (_url: unknown, init: { body?: string } = {}) => {
      captured = JSON.parse(init.body ?? '{}');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [
            { content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'stop' },
          ],
          usageMetadata: {},
        }),
        text: async () => '',
      };
    }) as never as typeof fetch;
    const p = new GoogleProvider({ apiKey: 'k', fetchImpl });
    await p.complete(
      {
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 100,
        safetySettings: [
          { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_LOW_AND_ABOVE' },
        ],
      },
      { signal: new AbortController().signal },
    );
    expect(captured?.['safetySettings']).toEqual([
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_LOW_AND_ABOVE' },
    ]);
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
          candidates: [
            { content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'stop' },
          ],
          usageMetadata: {},
        }),
        text: async () => '',
      };
    }) as never as typeof fetch;
    const p = new GoogleProvider({ apiKey: 'k', fetchImpl, maxTools: 2 });
    await p.complete(
      {
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 1,
        tools: toolList(['read', 'write', 'lint_gate_status', 'secret_scanner_test']),
      },
      { signal: new AbortController().signal },
    );
    const toolsWrapper = captured?.['tools'] as Array<{
      functionDeclarations: Array<{ name: string }>;
    }>;
    expect(toolsWrapper).toBeDefined();
    const wireTools = toolsWrapper[0]!.functionDeclarations;
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
          candidates: [
            { content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'stop' },
          ],
          usageMetadata: {},
        }),
        text: async () => '',
      };
    }) as never as typeof fetch;
    const p = new GoogleProvider({ apiKey: 'k', fetchImpl, maxTools: 128 });
    await p.complete(
      {
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 1,
        tools: toolList(['read', 'write', 'bash']),
      },
      { signal: new AbortController().signal },
    );
    const toolsWrapper = captured?.['tools'] as Array<{
      functionDeclarations: Array<{ name: string }>;
    }>;
    expect(toolsWrapper[0]!.functionDeclarations).toHaveLength(3);
  });
});
