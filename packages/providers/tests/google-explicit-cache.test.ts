import type { Request } from '@wrongstack/core/types';
import { describe, expect, it } from 'vitest';
import { GoogleProvider } from '../src/google.js';

function gemSSE(): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const data =
    'data: {"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":1}}\n\n';
  return new ReadableStream({
    pull(c) {
      c.enqueue(enc.encode(data));
      c.close();
    },
  });
}

interface Call {
  url: string;
  body: Record<string, unknown>;
}

function makeProvider(createOk = true) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: { body?: string }) => {
    calls.push({ url, body: JSON.parse(init.body ?? '{}') });
    if (url.endsWith('/cachedContents')) {
      return {
        ok: createOk,
        status: createOk ? 200 : 400,
        json: async () => (createOk ? { name: 'cachedContents/abc123' } : { error: 'too small' }),
        text: async () => '',
      };
    }
    return new Response(gemSSE(), { status: 200 });
  }) as never as typeof fetch;
  const provider = new GoogleProvider({ apiKey: 'k', fetchImpl });
  return { provider, calls };
}

const req = (over?: Partial<Request>): Request =>
  ({
    model: 'gemini-2.5-pro',
    maxTokens: 100,
    messages: [{ role: 'user', content: 'hi' }],
    system: [{ type: 'text', text: 'a large stable system prompt' }],
    cache: { geminiExplicit: true, key: 'ws-x' },
    ...over,
  }) as Request;

const signal = () => new AbortController().signal;

describe('GoogleProvider explicit cached-content', () => {
  it('creates a cachedContents resource and references it, omitting the inline system', async () => {
    const { provider, calls } = makeProvider();
    await provider.complete(req(), { signal: signal() });

    expect(calls).toHaveLength(2);
    const [create, generate] = calls;
    expect(create!.url).toMatch(/\/cachedContents$/);
    expect(create!.body['systemInstruction']).toBeDefined();
    expect(create!.body['ttl']).toBe('3600s');
    expect(create!.body['model']).toBe('models/gemini-2.5-pro');

    expect(generate!.url).toContain(':streamGenerateContent');
    expect(generate!.body['cachedContent']).toBe('cachedContents/abc123');
    expect(generate!.body).not.toHaveProperty('systemInstruction');
  });

  it('does nothing special when the flag is off (inline system, no create call)', async () => {
    const { provider, calls } = makeProvider();
    await provider.complete(req({ cache: { key: 'ws-x' } }), { signal: signal() });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain(':streamGenerateContent');
    expect(calls[0]!.body['systemInstruction']).toBeDefined();
    expect(calls[0]!.body).not.toHaveProperty('cachedContent');
  });

  it('falls back to an inline request when cache creation fails and negative-caches the failure', async () => {
    const { provider, calls } = makeProvider(false);
    await provider.complete(req(), { signal: signal() });
    await provider.complete(req(), { signal: signal() });

    // 1st request: create attempted (failed) + inline generate.
    // 2nd request: negative-cached → immediately inline generate without re-attempting create!
    expect(calls).toHaveLength(3);
    expect(calls[0]!.url).toMatch(/\/cachedContents$/);
    expect(calls[1]!.url).toContain(':streamGenerateContent');
    expect(calls[2]!.url).toContain(':streamGenerateContent');
    expect(calls[1]!.body['systemInstruction']).toBeDefined();
    expect(calls[2]!.body['systemInstruction']).toBeDefined();
  });

  it('reuses a live cache resource across requests (single create)', async () => {
    const { provider, calls } = makeProvider();
    await provider.complete(req(), { signal: signal() });
    await provider.complete(req(), { signal: signal() });

    const creates = calls.filter((c) => c.url.endsWith('/cachedContents'));
    const generates = calls.filter((c) => c.url.includes(':streamGenerateContent'));
    expect(creates).toHaveLength(1); // cached by prefix hash
    expect(generates).toHaveLength(2);
    expect(generates.every((g) => g.body['cachedContent'] === 'cachedContents/abc123')).toBe(true);
  });

  it('creates a new resource when a same-named tool changes schema', async () => {
    const { provider, calls } = makeProvider();
    const firstTool = {
      name: 'lookup',
      description: 'lookup by string',
      inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
    };
    const secondTool = {
      name: 'lookup',
      description: 'lookup by numeric id',
      inputSchema: { type: 'object', properties: { id: { type: 'number' } } },
    };

    await provider.complete(req({ tools: [firstTool] }), { signal: signal() });
    await provider.complete(req({ tools: [secondTool] }), { signal: signal() });

    expect(calls.filter((c) => c.url.endsWith('/cachedContents'))).toHaveLength(2);
  });
});
