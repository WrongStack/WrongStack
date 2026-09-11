import type { Request } from '@wrongstack/core/types';
import { describe, expect, it, vi } from 'vitest';
import { OpenCodeZenProvider } from '../src/opencode.js';

function sseBody(events: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    pull(controller) {
      controller.enqueue(enc.encode(events));
      controller.close();
    },
  });
}

const RESPONSES_SSE = [
  'data: {"type":"response.created","response":{"id":"r1","model":"gpt-5.6-sol"}}',
  '',
  'data: {"type":"response.output_item.added","item":{"type":"message","id":"m1","role":"assistant"}}',
  '',
  'data: {"type":"response.output_text.delta","delta":"responses-ok"}',
  '',
  'data: {"type":"response.output_item.done","item":{"type":"message","id":"m1"}}',
  '',
  'data: {"type":"response.completed","response":{"id":"r1","status":"completed","usage":{"input_tokens":5,"output_tokens":2}}}',
  '',
].join('\n');

const CHAT_SSE = [
  'data: {"model":"claude-sonnet-4-6","choices":[{"delta":{"content":"chat-ok"},"finish_reason":null}]}',
  '',
  'data: {"model":"claude-sonnet-4-6","choices":[{"delta":{},"finish_reason":"stop"}]}',
  '',
  'data: [DONE]',
  '',
].join('\n');

const baseReq: Request = {
  model: 'gpt-5.6-sol',
  system: [{ type: 'text', text: 'Refine the request.' }],
  messages: [{ role: 'user', content: 'fix parser' }],
  maxTokens: 128,
  reasoning: { effort: 'low' },
};

describe('OpenCodeZenProvider', () => {
  it('uses /responses and parses its terminal envelope when catalog metadata selects it', async () => {
    let capturedUrl = '';
    let capturedBody: Record<string, unknown> = {};
    const provider = new OpenCodeZenProvider({
      apiKey: 'zen-key',
      baseUrl: 'https://opencode.ai/zen/v1',
      models: [
        {
          id: 'gpt-5.6-sol',
          name: 'Responses model',
          provider: { npm: '@ai-sdk/openai' },
        },
      ],
      fetchImpl: (async (url: string, init: { body?: string }) => {
        capturedUrl = url;
        capturedBody = JSON.parse(init.body ?? '{}') as Record<string, unknown>;
        return new Response(sseBody(RESPONSES_SSE), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }) as never as typeof fetch,
    });

    const response = await provider.complete(baseReq, {
      signal: new AbortController().signal,
    });

    expect(capturedUrl).toBe('https://opencode.ai/zen/v1/responses');
    expect(capturedBody).toMatchObject({
      model: 'gpt-5.6-sol',
      stream: true,
      instructions: 'Refine the request.',
      max_output_tokens: 128,
      reasoning: { effort: 'low', summary: 'auto' },
    });
    expect(capturedBody['input']).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'fix parser' }] },
    ]);
    expect(response.content).toEqual([{ type: 'text', text: 'responses-ok' }]);
    expect(response.stopReason).toBe('end_turn');
  });

  it('keeps compatible models on /chat/completions', async () => {
    let capturedUrl = '';
    const provider = new OpenCodeZenProvider({
      apiKey: 'zen-key',
      baseUrl: 'https://opencode.ai/zen/v1',
      fetchImpl: (async (url: string) => {
        capturedUrl = url;
        return new Response(sseBody(CHAT_SSE), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }) as never as typeof fetch,
    });

    const response = await provider.complete(
      { ...baseReq, model: 'glm-5', reasoning: undefined },
      { signal: new AbortController().signal },
    );

    expect(capturedUrl).toBe('https://opencode.ai/zen/v1/chat/completions');
    expect(response.content).toEqual([{ type: 'text', text: 'chat-ok' }]);
  });

  it('routes all four transports from models.dev per-model SDK metadata', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
      calls.push({
        url: String(input),
        headers: Object.fromEntries(
          Object.entries(init?.headers ?? {}).map(([key, value]) => [
            key.toLowerCase(),
            String(value),
          ]),
        ),
      });
      return new Response('', { status: 200 });
    }) as never as typeof fetch;
    const provider = new OpenCodeZenProvider({
      apiKey: 'zen-key',
      baseUrl: 'https://opencode.ai/zen/v1',
      headers: { 'x-tenant-id': 'tenant-42' },
      fetchImpl,
      models: [
        { id: 'custom-responses', name: 'Responses', provider: { npm: '@ai-sdk/openai' } },
        { id: 'custom-messages', name: 'Messages', provider: { npm: '@ai-sdk/anthropic' } },
        { id: 'custom-google', name: 'Google', provider: { npm: '@ai-sdk/google' } },
        {
          id: 'gpt-5.6-sol',
          name: 'Compatible override',
          provider: { npm: '@ai-sdk/openai-compatible' },
        },
      ],
    });

    const signal = new AbortController().signal;
    for (const model of ['custom-responses', 'custom-messages', 'custom-google', 'gpt-5.6-sol']) {
      for await (const _event of provider.stream({ ...baseReq, model }, { signal })) {
        // URL/header assertions inspect the captured request.
      }
    }

    expect(calls.map((call) => call.url)).toEqual([
      'https://opencode.ai/zen/v1/responses',
      'https://opencode.ai/zen/v1/messages',
      'https://opencode.ai/zen/v1/models/custom-google:streamGenerateContent?alt=sse',
      'https://opencode.ai/zen/v1/chat/completions',
    ]);
    expect(calls.every((call) => call.headers['x-tenant-id'] === 'tenant-42')).toBe(true);
    expect(calls[0]?.headers['authorization']).toBe('Bearer zen-key');
    expect(calls[1]?.headers['x-api-key']).toBe('zen-key');
    expect(calls[2]?.headers['x-goog-api-key']).toBe('zen-key');
    expect(calls[3]?.headers['authorization']).toBe('Bearer zen-key');
  });
});
