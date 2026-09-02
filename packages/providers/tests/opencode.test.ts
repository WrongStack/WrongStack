import type { Request } from '@wrongstack/core/types';
import { describe, expect, it } from 'vitest';
import { OpenCodeZenProvider, usesResponsesEndpoint } from '../src/opencode.js';

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
  it.each(['gpt-5', 'gpt-5.4', 'gpt-5.6-sol', 'GPT-5-mini'])(
    'routes %s through the Responses endpoint',
    (model) => {
      expect(usesResponsesEndpoint(model)).toBe(true);
    },
  );

  it.each(['gpt-4.1', 'claude-sonnet-4-6', 'glm-5'])('keeps %s on Chat Completions', (model) => {
    expect(usesResponsesEndpoint(model)).toBe(false);
  });

  it('uses /responses and parses its terminal envelope for GPT-5 models', async () => {
    let capturedUrl = '';
    let capturedBody: Record<string, unknown> = {};
    const provider = new OpenCodeZenProvider({
      apiKey: 'zen-key',
      baseUrl: 'https://opencode.ai/zen/v1',
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

  it('keeps non-GPT models on /chat/completions', async () => {
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
      { ...baseReq, model: 'claude-sonnet-4-6', reasoning: undefined },
      { signal: new AbortController().signal },
    );

    expect(capturedUrl).toBe('https://opencode.ai/zen/v1/chat/completions');
    expect(response.content).toEqual([{ type: 'text', text: 'chat-ok' }]);
  });
});
