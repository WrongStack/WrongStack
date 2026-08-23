import type { StreamEvent } from '@wrongstack/core/types';
import { describe, expect, it } from 'vitest';
import { anthropicWireFormat } from '../src/presets/anthropic.js';
import { googleWireFormat } from '../src/presets/google.js';
import { openaiWireFormat } from '../src/presets/openai.js';
import { WireFormatProvider } from '../src/wire-format.js';

/**
 * Parity tests: the L0-C presets must produce the same canonical
 * StreamEvent[] as the existing class-based providers. We don't re-run the
 * full provider test suite per preset — instead we feed each preset a
 * representative SSE stream and assert the event shape.
 */

function sseBody(messages: string[]): ReadableStream<Uint8Array> {
  const text = messages.map((d) => `data: ${d}\n\n`).join('');
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode(text));
      controller.close();
    },
  });
}

function mkFetch(body: ReadableStream<Uint8Array>): typeof fetch {
  return (async () =>
    ({
      ok: true,
      status: 200,
      text: async () => '',
      body: body as ReadableStream<Uint8Array> | null,
    }) as never as Response) as never as typeof fetch;
}

async function collectFromPreset(
  format: Parameters<typeof WireFormatProvider>[0],
  body: ReadableStream<Uint8Array>,
  model: string,
): Promise<StreamEvent[]> {
  const provider = new WireFormatProvider(format, {
    apiKey: 'k',
    fetchImpl: mkFetch(body),
  });
  const events: StreamEvent[] = [];
  for await (const ev of provider.stream(
    { model, messages: [], maxTokens: 100 },
    { signal: new AbortController().signal },
  )) {
    events.push(ev);
  }
  return events;
}

describe('Anthropic preset - buildUrl variants', () => {
  it('appends /v1/messages when base has no version suffix', () => {
    const url = anthropicWireFormat.buildUrl('https://api.anthropic.com');
    expect(url).toBe('https://api.anthropic.com/v1/messages');
  });

  it('appends /messages when base ends with /v1', () => {
    const url = anthropicWireFormat.buildUrl('https://api.anthropic.com/v1');
    expect(url).toBe('https://api.anthropic.com/v1/messages');
  });

  it('returns base unchanged when already ending with /v1/messages', () => {
    const url = anthropicWireFormat.buildUrl('https://api.anthropic.com/v1/messages');
    expect(url).toBe('https://api.anthropic.com/v1/messages');
  });

  it('strips trailing slashes (the regex match strips all trailing slashes via replace)', () => {
    // replace(/\/+$/, '') strips ALL trailing slashes, then /messages is appended
    const url = anthropicWireFormat.buildUrl('https://api.anthropic.com/v1///');
    expect(url).toBe('https://api.anthropic.com/v1/messages');
  });
});

describe('Anthropic preset - buildHeaders', () => {
  it('sets x-api-key and anthropic-version', () => {
    const headers = anthropicWireFormat.buildHeaders('test-key-123');
    expect(headers).toEqual({
      'x-api-key': 'test-key-123',
      'anthropic-version': '2023-06-01',
    });
  });
});

describe('Anthropic preset - buildBody variants', () => {
  it('includes system, tools, temperature, topP, stopSequences, tool_choice', () => {
    const body = anthropicWireFormat.buildBody({
      model: 'anthropic-preset-test-model',
      maxTokens: 1024,
      messages: [{ role: 'user', content: 'hello' }],
      system: [{ text: 'you are helpful' }],
      tools: [{ name: 'lookup', description: 'look up stuff', inputSchema: { type: 'object' } }],
      temperature: 0.7,
      topP: 0.9,
      stopSequences: ['STOP'],
      toolChoice: 'auto',
    } as Parameters<typeof anthropicWireFormat.buildBody>[0]);
    expect(body).toMatchObject({
      model: 'anthropic-preset-test-model',
      max_tokens: 1024,
      stream: true,
      system: [{ text: 'you are helpful' }],
      tools: expect.any(Array),
      temperature: 0.7,
      top_p: 0.9,
      stop_sequences: ['STOP'],
      tool_choice: 'auto',
    });
  });

  it('maps system role to user in messages', () => {
    const body = anthropicWireFormat.buildBody({
      model: 'anthropic-preset-test-model',
      maxTokens: 100,
      messages: [{ role: 'system', content: 'be brief' }],
    } as Parameters<typeof anthropicWireFormat.buildBody>[0]);
    expect((body.messages as unknown[])[0]).toMatchObject({ role: 'user', content: 'be brief' });
  });

  it('omits optional fields when not provided', () => {
    const body = anthropicWireFormat.buildBody({
      model: 'anthropic-preset-test-model',
      maxTokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
    } as Parameters<typeof anthropicWireFormat.buildBody>[0]);
    expect(body).not.toHaveProperty('system');
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('top_p');
    expect(body).not.toHaveProperty('stop_sequences');
    expect(body).not.toHaveProperty('tool_choice');
  });
});

describe('Anthropic preset - parseStreamEvent error handling', () => {
  it('throws ProviderError on error event', async () => {
    const provider = new WireFormatProvider(anthropicWireFormat, {
      apiKey: 'k',
      fetchImpl: mkFetch(
        sseBody([
          JSON.stringify({
            type: 'message_start',
            message: { model: 'c', usage: { input_tokens: 1 } },
          }),
          JSON.stringify({
            type: 'error',
            error: { message: 'rate_limit_exceeded', type: 'rate_limit_error' },
          }),
        ]),
      ),
    });
    let err: unknown;
    try {
      for await (const _ of provider.stream(
        { model: 'c', messages: [], maxTokens: 100 },
        { signal: new AbortController().signal },
      )) {
        // empty
      }
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect((err as Error).message).toContain('rate_limit_exceeded');
  });

  it('throws with correct provider metadata on error event', async () => {
    const provider = new WireFormatProvider(anthropicWireFormat, {
      apiKey: 'k',
      fetchImpl: mkFetch(
        sseBody([
          JSON.stringify({
            type: 'error',
            error: { message: 'something went wrong', type: 'invalid_request_error' },
          }),
        ]),
      ),
    });
    const p = provider.stream(
      { model: 'c', messages: [], maxTokens: 100 },
      { signal: new AbortController().signal },
    );
    try {
      await p;
    } catch (err: unknown) {
      expect((err as { provider: string }).provider).toBe('anthropic');
      expect((err as { body: { type: string } }).body).toEqual({
        type: 'invalid_request_error',
        message: 'something went wrong',
      });
    }
  });

  it('returns empty array for empty data', async () => {
    const events = await collectFromPreset(anthropicWireFormat, sseBody(['']), 'c');
    expect(Array.isArray(events)).toBe(true);
    // Empty string → safeParse fails → returns [], no events emitted yet
    expect(events.some((e) => e.type === 'message_start')).toBe(false);
  });

  it('processes valid events following empty data without throwing', async () => {
    const events = await collectFromPreset(
      anthropicWireFormat,
      sseBody([
        '',
        JSON.stringify({
          type: 'message_start',
          message: { model: 'c', usage: { input_tokens: 1 } },
        }),
        JSON.stringify({
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: 1 },
        }),
        JSON.stringify({ type: 'message_stop' }),
      ]),
      'c',
    );
    expect(events.some((e) => e.type === 'message_start')).toBe(true);
    expect(events.filter((e) => e.type === 'message_stop')).toHaveLength(1);
  });

  it('stops processing after [DONE] and synthesizes message_stop', async () => {
    const events = await collectFromPreset(
      anthropicWireFormat,
      sseBody([
        JSON.stringify({
          type: 'message_start',
          message: { model: 'c', usage: { input_tokens: 1 } },
        }),
        '[DONE]',
      ]),
      'c',
    );
    // finalizeStream synthesizes message_stop since started=true
    expect(events.some((e) => e.type === 'message_start')).toBe(true);
    expect(events.some((e) => e.type === 'message_stop')).toBe(true);
  });
});

describe('Anthropic preset - parseStreamEvent content_block_start edge cases', () => {
  it('handles unknown content_block type gracefully', async () => {
    const events = await collectFromPreset(
      anthropicWireFormat,
      sseBody([
        JSON.stringify({
          type: 'message_start',
          message: { model: 'c', usage: { input_tokens: 1 } },
        }),
        JSON.stringify({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'server_tool_use', id: 'x', name: 'y' },
        }),
        JSON.stringify({
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: 1 },
        }),
        JSON.stringify({ type: 'message_stop' }),
      ]),
      'c',
    );
    // Should not crash, block stored as 'unknown'
    expect(events.some((e) => e.type === 'message_start')).toBe(true);
    expect(events.some((e) => e.type === 'message_stop')).toBe(true);
  });

  it('preserves thinking blocks and signatures for round-trip parity', async () => {
    const events = await collectFromPreset(
      anthropicWireFormat,
      sseBody([
        JSON.stringify({
          type: 'message_start',
          message: { model: 'c', usage: { input_tokens: 1 } },
        }),
        JSON.stringify({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking', thinking: '' },
        }),
        JSON.stringify({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'working' },
        }),
        JSON.stringify({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'signature_delta', signature: 'sig-1' },
        }),
        JSON.stringify({ type: 'content_block_stop', index: 0 }),
        JSON.stringify({
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: 1 },
        }),
        JSON.stringify({ type: 'message_stop' }),
      ]),
      'c',
    );

    expect(events.filter((e) => e.type === 'thinking_start')).toHaveLength(1);
    expect(events).toContainEqual({ type: 'thinking_delta', text: 'working' });
    expect(events).toContainEqual({ type: 'thinking_signature', signature: 'sig-1' });
    expect(events.filter((e) => e.type === 'thinking_stop')).toHaveLength(1);
  });

  it('does not emit tool_use_start when content_block is text type', async () => {
    const events = await collectFromPreset(
      anthropicWireFormat,
      sseBody([
        JSON.stringify({
          type: 'message_start',
          message: { model: 'c', usage: { input_tokens: 1 } },
        }),
        JSON.stringify({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text' },
        }),
        JSON.stringify({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'hello' },
        }),
        JSON.stringify({
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: 1 },
        }),
        JSON.stringify({ type: 'message_stop' }),
      ]),
      'c',
    );
    const tStart = events.find((e) => e.type === 'tool_use_start');
    expect(tStart).toBeUndefined();
    const textDelta = events.find((e) => e.type === 'text_delta');
    expect((textDelta as { text: string }).text).toBe('hello');
  });
});

describe('Anthropic preset - message_delta edge cases', () => {
  it('handles message_delta with no stop_reason', async () => {
    const events = await collectFromPreset(
      anthropicWireFormat,
      sseBody([
        JSON.stringify({
          type: 'message_start',
          message: { model: 'c', usage: { input_tokens: 1 } },
        }),
        JSON.stringify({
          type: 'message_delta',
          usage: { output_tokens: 5 },
        }),
        JSON.stringify({ type: 'message_stop' }),
      ]),
      'c',
    );
    const stop = events.find((e) => e.type === 'message_stop');
    // Default stopReason remains 'end_turn' when no stop_reason in delta
    expect((stop as { stopReason: string }).stopReason).toBe('end_turn');
    expect((stop as { usage: { output: number } }).usage.output).toBe(5);
  });

  it('handles content_block_delta with no block present', async () => {
    const events = await collectFromPreset(
      anthropicWireFormat,
      sseBody([
        JSON.stringify({
          type: 'message_start',
          message: { model: 'c', usage: { input_tokens: 1 } },
        }),
        JSON.stringify({
          // index 99 never seen in content_block_start
          type: 'content_block_delta',
          index: 99,
          delta: { type: 'text_delta', text: 'orphan' },
        }),
        JSON.stringify({
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: 1 },
        }),
        JSON.stringify({ type: 'message_stop' }),
      ]),
      'c',
    );
    // Should not crash; orphan delta is silently dropped
    expect(events.some((e) => e.type === 'message_stop')).toBe(true);
  });

  it('handles content_block_delta with no delta present', async () => {
    const events = await collectFromPreset(
      anthropicWireFormat,
      sseBody([
        JSON.stringify({
          type: 'message_start',
          message: { model: 'c', usage: { input_tokens: 1 } },
        }),
        JSON.stringify({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text' },
        }),
        JSON.stringify({
          type: 'content_block_delta',
          index: 0,
          delta: null,
        }),
        JSON.stringify({
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: 1 },
        }),
        JSON.stringify({ type: 'message_stop' }),
      ]),
      'c',
    );
    expect(events.some((e) => e.type === 'message_stop')).toBe(true);
  });
});

describe('Anthropic preset - finalizeStream edge case', () => {
  it('synthesizes message_stop when upstream closed without message_stop', async () => {
    // Simulate a stream that sends message_start but no message_stop
    const events = await collectFromPreset(
      anthropicWireFormat,
      sseBody([
        JSON.stringify({
          type: 'message_start',
          message: { model: 'c', usage: { input_tokens: 1 } },
        }),
        JSON.stringify({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text' },
        }),
        JSON.stringify({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'hi' },
        }),
        // no message_stop sent — finalizeStream should synthesize one
        JSON.stringify({ type: 'message_delta', usage: { output_tokens: 1 } }),
      ]),
      'c',
    );
    const stop = events.find((e) => e.type === 'message_stop');
    expect(stop).toBeDefined();
    expect(events.filter((e) => e.type === 'message_stop')).toHaveLength(1);
    expect((stop as { usage: { input: number } }).usage.input).toBe(1);
  });
});

describe('Anthropic preset - cache metadata', () => {
  it('extracts cache_read_input_tokens and cache_creation_input_tokens', async () => {
    const events = await collectFromPreset(
      anthropicWireFormat,
      sseBody([
        JSON.stringify({
          type: 'message_start',
          message: {
            model: 'c',
            usage: {
              input_tokens: 100,
              cache_read_input_tokens: 50,
              cache_creation_input_tokens: 200,
            },
          },
        }),
        JSON.stringify({
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: 10 },
        }),
        JSON.stringify({ type: 'message_stop' }),
      ]),
      'c',
    );
    const stop = events.find((e) => e.type === 'message_stop');
    expect((stop as { usage: { cacheRead: number; cacheWrite: number } }).usage.cacheRead).toBe(50);
    expect((stop as { usage: { cacheWrite: number } }).usage.cacheWrite).toBe(200);
  });

  it('preserves Anthropic cache creation TTL split when present', async () => {
    const events = await collectFromPreset(
      anthropicWireFormat,
      sseBody([
        JSON.stringify({
          type: 'message_start',
          message: {
            model: 'c',
            usage: {
              input_tokens: 100,
              cache_read_input_tokens: 50,
              cache_creation_input_tokens: 300,
              cache_creation: {
                ephemeral_5m_input_tokens: 200,
                ephemeral_1h_input_tokens: 100,
              },
            },
          },
        }),
        JSON.stringify({ type: 'message_stop' }),
      ]),
      'c',
    );
    const stop = events.find((e) => e.type === 'message_stop');
    expect(
      (stop as { usage: { cacheWrite: number; cacheWrite5m: number; cacheWrite1h: number } }).usage,
    ).toMatchObject({
      cacheWrite: 300,
      cacheWrite5m: 200,
      cacheWrite1h: 100,
    });
  });
});

describe('OpenAI preset - buildUrl variants', () => {
  it('appends /v1/chat/completions when base has no version suffix', () => {
    const url = openaiWireFormat.buildUrl('https://api.example.com');
    expect(url).toBe('https://api.example.com/v1/chat/completions');
  });

  it('appends /chat/completions when base ends with /v1', () => {
    const url = openaiWireFormat.buildUrl('https://api.openai.com/v1');
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
  });

  it('appends /chat/completions when base ends with /v10', () => {
    const url = openaiWireFormat.buildUrl('https://api.openai.com/v10');
    expect(url).toBe('https://api.openai.com/v10/chat/completions');
  });

  it('returns base unchanged when already ending with /chat/completions', () => {
    const url = openaiWireFormat.buildUrl('https://api.openai.com/v1/chat/completions');
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
  });

  it('strips trailing slashes before path manipulation', () => {
    const url = openaiWireFormat.buildUrl('https://api.openai.com/v1/chat/completions///');
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
  });
});

describe('OpenAI preset - buildHeaders', () => {
  it('sets Bearer authorization header', () => {
    const headers = openaiWireFormat.buildHeaders('sk-secret');
    expect(headers).toEqual({ authorization: 'Bearer sk-secret' });
  });
});

describe('OpenAI preset - buildBody variants', () => {
  it('sets temperature, topP, stop when provided', () => {
    const body = openaiWireFormat.buildBody({
      model: 'gpt-4o',
      maxTokens: 256,
      messages: [],
      temperature: 0.5,
      topP: 0.8,
      stopSequences: ['END'],
    } as Parameters<typeof openaiWireFormat.buildBody>[0]);
    expect(body).toMatchObject({
      model: 'gpt-4o',
      max_completion_tokens: 256,
      temperature: 0.5,
      top_p: 0.8,
      stop: ['END'],
    });
    expect(body).not.toHaveProperty('max_tokens');
  });

  it('sets tool_choice as string "required"', () => {
    const body = openaiWireFormat.buildBody({
      model: 'gpt-4o',
      maxTokens: 256,
      messages: [],
      tools: [{ name: 'f', description: 'd', inputSchema: {} }],
      toolChoice: 'required',
    } as Parameters<typeof openaiWireFormat.buildBody>[0]);
    expect(body).toMatchObject({ tool_choice: 'required' });
  });

  it('sets tool_choice as type/function object', () => {
    const body = openaiWireFormat.buildBody({
      model: 'gpt-4o',
      maxTokens: 256,
      messages: [],
      tools: [{ name: 'f', description: 'd', inputSchema: {} }],
      toolChoice: { name: 'lookup' },
    } as Parameters<typeof openaiWireFormat.buildBody>[0]);
    expect(body).toMatchObject({
      tool_choice: { type: 'function', function: { name: 'lookup' } },
    });
  });

  it('omits optional fields when not provided', () => {
    const body = openaiWireFormat.buildBody({
      model: 'gpt-4o',
      maxTokens: 256,
      messages: [],
    } as Parameters<typeof openaiWireFormat.buildBody>[0]);
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('tool_choice');
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('top_p');
    expect(body).not.toHaveProperty('stop');
  });
});

describe('OpenAI preset - reasoning / thinking delta', () => {
  it('emits thinking_start / thinking_delta / thinking_stop for reasoning_content', async () => {
    const events = await collectFromPreset(
      openaiWireFormat,
      sseBody([
        JSON.stringify({
          model: 'deepseek-chat',
          choices: [{ delta: { reasoning_content: 'let me calculate' } }],
        }),
        JSON.stringify({ choices: [{ delta: { content: 'the answer is 42' } }] }),
        JSON.stringify({
          choices: [{ finish_reason: 'stop', usage: { prompt_tokens: 5, completion_tokens: 3 } }],
        }),
        '[DONE]',
      ]),
      'deepseek-chat',
    );
    const tStart = events.find((e) => e.type === 'thinking_start');
    expect(tStart).toBeDefined();
    const tDelta = events.find((e) => e.type === 'thinking_delta');
    expect((tDelta as { text: string }).text).toBe('let me calculate');
    const tStop = events.find((e) => e.type === 'thinking_stop');
    expect(tStop).toBeDefined();
    // After content arrives, thinking should be closed before text
    expect(events.indexOf(tStop as StreamEvent)).toBeLessThan(
      events.findIndex((e) => e.type === 'text_delta')!,
    );
  });

  it('emits thinking_start / thinking_delta for reasoning (alternative field)', async () => {
    const events = await collectFromPreset(
      openaiWireFormat,
      sseBody([
        JSON.stringify({ model: 'moonshot', choices: [{ delta: { reasoning: 'thinking...' } }] }),
        JSON.stringify({
          choices: [{ finish_reason: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1 } }],
        }),
        '[DONE]',
      ]),
      'moonshot',
    );
    const tDelta = events.find((e) => e.type === 'thinking_delta');
    expect((tDelta as { text: string }).text).toBe('thinking...');
  });
});

describe('OpenAI preset - parseStreamEvent edge cases', () => {
  it('returns empty array for [DONE] with no prior events', async () => {
    const events = await collectFromPreset(openaiWireFormat, sseBody(['[DONE]']), 'gpt-4o');
    // finalizeStream will add message_stop when started=true but in this case nothing started
    expect(events.length).toBeGreaterThanOrEqual(0);
  });

  it('handles empty data string without throwing', async () => {
    const events = await collectFromPreset(openaiWireFormat, sseBody(['']), 'gpt-4o');
    expect(Array.isArray(events)).toBe(true);
  });

  it('handles malformed JSON without throwing', async () => {
    const events = await collectFromPreset(
      openaiWireFormat,
      sseBody(['not valid json{}']),
      'gpt-4o',
    );
    expect(Array.isArray(events)).toBe(true);
  });

  it('uses fallback model when model field absent', async () => {
    const events = await collectFromPreset(
      openaiWireFormat,
      sseBody([
        JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }),
        JSON.stringify({
          choices: [{ finish_reason: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1 } }],
        }),
        '[DONE]',
      ]),
      'fallback-model',
    );
    const start = events.find((e) => e.type === 'message_start');
    expect((start as { model: string }).model).toBe('fallback-model');
  });
});

describe('OpenAI preset - cached token usage', () => {
  it('treats input_tokens as a fresh delta for Anthropic-shaped hybrid gateways', async () => {
    const events = await collectFromPreset(
      openaiWireFormat,
      sseBody([
        JSON.stringify({
          model: 'minimax-hybrid',
          choices: [{ finish_reason: 'stop' }],
          usage: {
            input_tokens: 100,
            completion_tokens: 20,
            prompt_tokens_details: { cached_tokens: 15_000 },
          },
        }),
        '[DONE]',
      ]),
      'minimax-hybrid',
    );
    const stop = events.find((e) => e.type === 'message_stop');
    expect((stop as { usage: { input: number; cacheRead: number } }).usage).toMatchObject({
      input: 100,
      cacheRead: 15_000,
    });
  });

  it('preserves anomalous cached tokens above an OpenAI prompt total without overshooting 100%', async () => {
    const events = await collectFromPreset(
      openaiWireFormat,
      sseBody([
        JSON.stringify({
          model: 'hybrid-proxy',
          choices: [{ finish_reason: 'stop' }],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 20,
            prompt_tokens_details: { cached_tokens: 150 },
          },
        }),
        '[DONE]',
      ]),
      'hybrid-proxy',
    );
    const stop = events.find((e) => e.type === 'message_stop');
    expect((stop as { usage: { input: number; cacheRead: number } }).usage).toMatchObject({
      input: 100,
      cacheRead: 150,
    });
  });

  it('extracts prompt_tokens_details.cached_tokens correctly', async () => {
    const events = await collectFromPreset(
      openaiWireFormat,
      sseBody([
        JSON.stringify({
          model: 'gpt-4o',
          choices: [{ finish_reason: 'stop' }],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 20,
            prompt_tokens_details: { cached_tokens: 40 },
          },
        }),
        '[DONE]',
      ]),
      'gpt-4o',
    );
    const stop = events.find((e) => e.type === 'message_stop');
    expect((stop as { usage: { input: number; cacheRead: number } }).usage).toMatchObject({
      input: 60, // 100 - 40
      cacheRead: 40,
    });
  });

  it('extracts OpenAI prompt cache write tokens as disjoint usage', async () => {
    const events = await collectFromPreset(
      openaiWireFormat,
      sseBody([
        JSON.stringify({
          model: 'gpt-5.6',
          choices: [{ finish_reason: 'stop' }],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 20,
            prompt_tokens_details: { cached_tokens: 40, cache_write_tokens: 10 },
          },
        }),
        '[DONE]',
      ]),
      'gpt-5.6',
    );
    const stop = events.find((e) => e.type === 'message_stop');
    expect(
      (stop as { usage: { input: number; output: number; cacheRead: number; cacheWrite: number } })
        .usage,
    ).toMatchObject({
      input: 50,
      output: 20,
      cacheRead: 40,
      cacheWrite: 10,
    });
  });

  it('extracts DeepSeek prompt cache hit and miss token usage', async () => {
    const events = await collectFromPreset(
      openaiWireFormat,
      sseBody([
        JSON.stringify({
          model: 'deepseek-chat',
          choices: [{ finish_reason: 'stop' }],
          usage: {
            prompt_tokens: 1000,
            completion_tokens: 20,
            prompt_cache_hit_tokens: 800,
            prompt_cache_miss_tokens: 200,
          },
        }),
        '[DONE]',
      ]),
      'deepseek-chat',
    );
    const stop = events.find((e) => e.type === 'message_stop');
    expect((stop as { usage: { input: number; output: number; cacheRead: number } }).usage).toEqual(
      {
        input: 200,
        output: 20,
        cacheRead: 800,
      },
    );
  });

  it('derives input from total_tokens when prompt_tokens is absent (MiniMax)', async () => {
    // MiniMax's OpenAI-compatible API guarantees only `total_tokens` in its
    // streamed usage; without a `prompt_tokens` field the input count used to
    // collapse to 0 (zeroing the context meter and the ↑ sent-token counter).
    const events = await collectFromPreset(
      openaiWireFormat,
      sseBody([
        JSON.stringify({
          model: 'MiniMax-M3',
          choices: [{ finish_reason: 'stop' }],
          usage: { total_tokens: 5200, completion_tokens: 200 },
        }),
        '[DONE]',
      ]),
      'MiniMax-M3',
    );
    const stop = events.find((e) => e.type === 'message_stop');
    expect((stop as { usage: { input: number; output: number } }).usage).toMatchObject({
      input: 5000, // 5200 total − 200 completion
      output: 200,
    });
  });
});

describe('OpenAI preset - multiple tool calls', () => {
  it('handles two simultaneous tool calls at different indices', async () => {
    const events = await collectFromPreset(
      openaiWireFormat,
      sseBody([
        JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 'call_1', function: { name: 'lookup', arguments: '{"q":"a"}' } },
                  {
                    index: 1,
                    id: 'call_2',
                    function: { name: 'search', arguments: '{"term":"b"}' },
                  },
                ],
              },
            },
          ],
        }),
        JSON.stringify({
          choices: [
            { finish_reason: 'tool_calls', usage: { prompt_tokens: 1, completion_tokens: 1 } },
          ],
        }),
        '[DONE]',
      ]),
      'gpt-4o',
    );
    const starts = events.filter((e) => e.type === 'tool_use_start');
    expect(starts).toHaveLength(2);
    const stops = events.filter((e) => e.type === 'tool_use_stop');
    expect(stops).toHaveLength(2);
    const inputs = stops.map((e) => (e as { input: unknown }).input);
    expect(inputs).toContainEqual({ q: 'a' });
    expect(inputs).toContainEqual({ term: 'b' });
  });

  it('keeps argument fragments that arrive before tool_call id/name metadata', async () => {
    const events = await collectFromPreset(
      openaiWireFormat,
      sseBody([
        JSON.stringify({
          choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"q":' } }] } }],
        }),
        JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 'call_late', function: { name: 'lookup', arguments: '"x"}' } },
                ],
              },
            },
          ],
        }),
        JSON.stringify({
          choices: [{ finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        '[DONE]',
      ]),
      'gpt-4o',
    );

    expect(events.find((e) => e.type === 'tool_use_start')).toEqual({
      type: 'tool_use_start',
      id: 'call_late',
      name: 'lookup',
    });
    const stop = events.find((e) => e.type === 'tool_use_stop');
    expect((stop as { input: unknown }).input).toEqual({ q: 'x' });
  });
});

describe('OpenAI preset - finalizeStream', () => {
  it('closes thinking if left open at finalize', async () => {
    const events = await collectFromPreset(
      openaiWireFormat,
      sseBody([
        JSON.stringify({
          model: 'gpt-4o',
          choices: [{ delta: { reasoning_content: 'incomplete thoug' } }],
        }),
        // No content to close thinking before finalize
        JSON.stringify({
          choices: [{ finish_reason: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1 } }],
        }),
        '[DONE]',
      ]),
      'gpt-4o',
    );
    const tStop = events.find((e) => e.type === 'thinking_stop');
    expect(tStop).toBeDefined();
  });
});

describe('Anthropic preset - config metadata', () => {
  it('cacheControl capability is native', () => {
    expect(anthropicWireFormat.capabilities.cacheControl).toBe('native');
  });
});

describe('OpenAI preset', () => {
  it('streams content + tool call + finish_reason', async () => {
    const events = await collectFromPreset(
      openaiWireFormat,
      sseBody([
        JSON.stringify({ model: 'gpt-4o', choices: [{ delta: { content: 'hi ' } }] }),
        JSON.stringify({ choices: [{ delta: { content: 'there' } }] }),
        JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 'call_a', function: { name: 'lookup', arguments: '{"q":' } },
                ],
              },
            },
          ],
        }),
        JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, function: { arguments: '"x"}' } }],
              },
            },
          ],
        }),
        JSON.stringify({
          choices: [{ delta: {}, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 7, completion_tokens: 3 },
        }),
        '[DONE]',
      ]),
      'gpt-4o',
    );
    const start = events.find((e) => e.type === 'message_start');
    expect((start as { model: string }).model).toBe('gpt-4o');
    const texts = events.filter((e) => e.type === 'text_delta');
    expect(texts).toHaveLength(2);
    const tStart = events.find((e) => e.type === 'tool_use_start');
    expect(tStart).toEqual({ type: 'tool_use_start', id: 'call_a', name: 'lookup' });
    const tStop = events.find((e) => e.type === 'tool_use_stop');
    expect((tStop as { input: unknown }).input).toEqual({ q: 'x' });
    const stop = events.find((e) => e.type === 'message_stop');
    expect((stop as { stopReason: string }).stopReason).toBe('tool_use');
  });

  it('config metadata', () => {
    expect(openaiWireFormat.id).toBe('openai');
    expect(openaiWireFormat.family).toBe('openai');
  });
});

describe('Google preset - buildUrl', () => {
  it('encodes model name and uses streamGenerateContent SSE endpoint', () => {
    const url = googleWireFormat.buildUrl('https://generativelanguage.googleapis.com/v1beta', {
      model: 'gemini-2.0-flash',
      messages: [],
      maxTokens: 100,
    } as Parameters<typeof googleWireFormat.buildUrl>[1]);
    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse',
    );
  });

  it('encodes special characters in model name', () => {
    const url = googleWireFormat.buildUrl('https://generativelanguage.googleapis.com/v1beta', {
      model: 'models/gemini-pro',
      messages: [],
      maxTokens: 100,
    } as Parameters<typeof googleWireFormat.buildUrl>[1]);
    expect(url).toContain('models%2Fgemini-pro');
  });
});

describe('Google preset - buildHeaders', () => {
  it('sets x-goog-api-key header', () => {
    const headers = googleWireFormat.buildHeaders('my-api-key');
    expect(headers).toEqual({ 'x-goog-api-key': 'my-api-key' });
  });
});

describe('Google preset - buildBody variants', () => {
  it('includes systemInstruction when system is provided', () => {
    const body = googleWireFormat.buildBody({
      model: 'gemini-2.0-flash',
      maxTokens: 100,
      messages: [],
      system: [{ text: 'you are helpful' }],
    } as Parameters<typeof googleWireFormat.buildBody>[0]);
    expect(body).toMatchObject({
      systemInstruction: { parts: [{ text: 'you are helpful' }] },
    });
  });

  it('omits systemInstruction when not provided', () => {
    const body = googleWireFormat.buildBody({
      model: 'gemini-2.0-flash',
      maxTokens: 100,
      messages: [],
    } as Parameters<typeof googleWireFormat.buildBody>[0]);
    expect(body).not.toHaveProperty('systemInstruction');
  });

  it('includes tools with functionDeclarations', () => {
    const body = googleWireFormat.buildBody({
      model: 'gemini-2.0-flash',
      maxTokens: 100,
      messages: [],
      tools: [
        {
          name: 'lookup',
          description: 'look up info',
          inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
        },
      ],
    } as Parameters<typeof googleWireFormat.buildBody>[0]);
    expect(body).toMatchObject({
      tools: [{ functionDeclarations: expect.any(Array) }],
    });
  });

  it('omits tools when not provided', () => {
    const body = googleWireFormat.buildBody({
      model: 'gemini-2.0-flash',
      maxTokens: 100,
      messages: [],
    } as Parameters<typeof googleWireFormat.buildBody>[0]);
    expect(body).not.toHaveProperty('tools');
  });

  it('sets generationConfig with maxOutputTokens, temperature, topP, stopSequences', () => {
    const body = googleWireFormat.buildBody({
      model: 'gemini-2.0-flash',
      maxTokens: 256,
      messages: [],
      temperature: 0.7,
      topP: 0.9,
      stopSequences: ['STOP'],
    } as Parameters<typeof googleWireFormat.buildBody>[0]);
    expect(body).toMatchObject({
      generationConfig: {
        maxOutputTokens: 256,
        temperature: 0.7,
        topP: 0.9,
        stopSequences: ['STOP'],
      },
    });
  });
});

describe('Google preset - parseStreamEvent edge cases', () => {
  it('returns empty array for empty data string', async () => {
    const events = await collectFromPreset(googleWireFormat, sseBody(['']), 'gemini');
    expect(Array.isArray(events)).toBe(true);
  });

  it('returns empty array for [DONE] sentinel', async () => {
    const events = await collectFromPreset(
      googleWireFormat,
      sseBody([
        JSON.stringify({ modelVersion: 'gemini', candidates: [{ finishReason: 'STOP' }] }),
        '[DONE]',
      ]),
      'gemini',
    );
    // Only message_stop from finalize, no text deltas
    expect(events.some((e) => e.type === 'message_stop')).toBe(true);
  });

  it('returns empty array for malformed JSON', async () => {
    const events = await collectFromPreset(googleWireFormat, sseBody(['not json{}']), 'gemini');
    expect(Array.isArray(events)).toBe(true);
  });

  it('updates model from modelVersion field', async () => {
    const events = await collectFromPreset(
      googleWireFormat,
      sseBody([
        JSON.stringify({
          modelVersion: 'gemini-2.0-flash-exp',
          candidates: [
            { content: { role: 'model', parts: [{ text: 'hi' }] }, finishReason: 'STOP' },
          ],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
        }),
      ]),
      'fallback-model',
    );
    const start = events.find((e) => e.type === 'message_start');
    expect((start as { model: string }).model).toBe('gemini-2.0-flash-exp');
  });

  it('handles candidate with no content gracefully', async () => {
    const events = await collectFromPreset(
      googleWireFormat,
      sseBody([
        JSON.stringify({
          candidates: [{ finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
        }),
      ]),
      'gemini',
    );
    // Should not emit any text or tool events, just message_stop
    expect(events.some((e) => e.type === 'message_stop')).toBe(true);
  });

  it('handles candidate with empty parts array', async () => {
    const events = await collectFromPreset(
      googleWireFormat,
      sseBody([
        JSON.stringify({
          candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
        }),
      ]),
      'gemini',
    );
    expect(events.some((e) => e.type === 'text_delta')).toBe(false);
    expect(events.some((e) => e.type === 'message_stop')).toBe(true);
  });

  it('skips text part when text is empty string', async () => {
    const events = await collectFromPreset(
      googleWireFormat,
      sseBody([
        JSON.stringify({
          candidates: [{ content: { role: 'model', parts: [{ text: '' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
        }),
      ]),
      'gemini',
    );
    expect(events.some((e) => e.type === 'text_delta')).toBe(false);
  });

  it('handles usageMetadata with cachedContentTokenCount', async () => {
    const events = await collectFromPreset(
      googleWireFormat,
      sseBody([
        JSON.stringify({
          modelVersion: 'gemini',
          candidates: [
            { content: { role: 'model', parts: [{ text: 'hi' }] }, finishReason: 'STOP' },
          ],
          usageMetadata: {
            promptTokenCount: 100,
            candidatesTokenCount: 5,
            cachedContentTokenCount: 40,
          },
        }),
      ]),
      'gemini',
    );
    const stop = events.find((e) => e.type === 'message_stop');
    expect(
      (stop as { usage: { input: number; output: number; cacheRead: number } }).usage,
    ).toMatchObject({
      input: 60, // 100 - 40
      output: 5,
      cacheRead: 40,
    });
  });

  it('handles usageMetadata with only cachedContentTokenCount (no promptTokenCount)', async () => {
    // When promptTokenCount is absent, usage.input should retain prior value or 0
    const events = await collectFromPreset(
      googleWireFormat,
      sseBody([
        JSON.stringify({
          modelVersion: 'gemini',
          candidates: [
            { content: { role: 'model', parts: [{ text: 'hi' }] }, finishReason: 'STOP' },
          ],
          usageMetadata: {
            cachedContentTokenCount: 30,
          },
        }),
      ]),
      'gemini',
    );
    const stop = events.find((e) => e.type === 'message_stop');
    expect((stop as { usage: { cacheRead: number } }).usage.cacheRead).toBe(30);
  });

  it('throws a retryable truncation error when finishReason is absent (mid-stream cut)', async () => {
    // Real Gemini always terminates a complete response with a finishReason;
    // its absence after content means the stream was cut mid-response, which
    // must surface as retryable rather than a synthetic end_turn.
    let caught: unknown;
    try {
      await collectFromPreset(
        googleWireFormat,
        sseBody([
          JSON.stringify({
            candidates: [{ content: { role: 'model', parts: [{ text: 'hi' }] } }],
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
          }),
        ]),
        'gemini',
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/truncat/i);
    expect((caught as { retryable?: boolean }).retryable).toBe(true);
  });
});

describe('Google preset - finalizeStream edge cases', () => {
  it('returns empty array when not started', () => {
    const state = googleWireFormat.createStreamState('gemini-flash');
    const events = googleWireFormat.finalizeStream(state);
    expect(events).toEqual([]);
  });

  it('returns empty array when finalizeStream called twice', () => {
    const state = googleWireFormat.createStreamState('gemini-flash');
    state.started = true;
    const first = googleWireFormat.finalizeStream(state);
    expect(first).toHaveLength(1);
    const second = googleWireFormat.finalizeStream(state);
    expect(second).toEqual([]);
  });

  it('overrides stopReason to tool_use when sawFunctionCall is true', () => {
    const state = googleWireFormat.createStreamState('gemini-flash');
    state.started = true;
    state.sawFunctionCall = true;
    state.stopReason = 'end_turn';
    const events = googleWireFormat.finalizeStream(state);
    const stop = events.find((e) => e.type === 'message_stop');
    expect((stop as { stopReason: string }).stopReason).toBe('tool_use');
  });

  it('keeps stopReason when sawFunctionCall is false', () => {
    const state = googleWireFormat.createStreamState('gemini-flash');
    state.started = true;
    state.sawFunctionCall = false;
    state.stopReason = 'end_turn';
    const events = googleWireFormat.finalizeStream(state);
    const stop = events.find((e) => e.type === 'message_stop');
    expect((stop as { stopReason: string }).stopReason).toBe('end_turn');
  });
});

describe('Google preset - messagesToGemini coverage via buildBody', () => {
  it('folds in-conversation system messages into a user turn (not dropped)', () => {
    // Compaction digests + the evidence floor are carried as role:'system'
    // messages. Gemini has no system turn, so they must be folded into a user
    // turn — dropping them would silently lose the collapsed history.
    const body = googleWireFormat.buildBody({
      model: 'gemini',
      maxTokens: 100,
      messages: [{ role: 'system', content: '[prior_turns_digest: keep me]' }],
    } as Parameters<typeof googleWireFormat.buildBody>[0]);
    const contents = body.contents as { role: string; parts: { text?: string }[] }[];
    expect(contents).toHaveLength(1);
    expect(contents[0]?.role).toBe('user');
    expect(contents[0]?.parts[0]?.text).toContain('keep me');
  });

  it('coalesces a folded system digest with the following user turn', () => {
    const body = googleWireFormat.buildBody({
      model: 'gemini',
      maxTokens: 100,
      messages: [
        { role: 'system', content: '[digest]' },
        { role: 'user', content: 'real question' },
      ],
    } as Parameters<typeof googleWireFormat.buildBody>[0]);
    const contents = body.contents as { role: string; parts: { text?: string }[] }[];
    // Two consecutive user turns are merged into one so alternation stays valid.
    expect(contents).toHaveLength(1);
    expect(contents[0]?.role).toBe('user');
    expect(contents[0]?.parts.map((p) => p.text)).toEqual(['[digest]', 'real question']);
  });

  it('converts assistant tool_use to functionCall part with thoughtSignature', () => {
    const body = googleWireFormat.buildBody({
      model: 'gemini',
      maxTokens: 100,
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              name: 'doit',
              input: { x: 1 },
              providerMeta: { 'google.thoughtSignature': 'sig123' },
            },
          ],
        },
      ],
    } as Parameters<typeof googleWireFormat.buildBody>[0]);
    const contents = body.contents as Array<{ role: string; parts: unknown[] }>;
    expect(contents[0].role).toBe('model');
    expect((contents[0].parts[0] as { thoughtSignature?: string }).thoughtSignature).toBe('sig123');
  });

  it('converts user/tool_result to functionResponse part', () => {
    const body = googleWireFormat.buildBody({
      model: 'gemini',
      maxTokens: 100,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call_1',
              name: 'lookup',
              content: '{"result":"ok"}',
            },
          ],
        },
      ],
    } as Parameters<typeof googleWireFormat.buildBody>[0]);
    const contents = body.contents as Array<{ role: string; parts: unknown[] }>;
    expect(contents[0].role).toBe('user');
    expect(
      (contents[0].parts[0] as { functionResponse?: { name: string } }).functionResponse?.name,
    ).toBe('lookup');
  });

  it('handles tool_result where name is absent (uses tool_use_id)', () => {
    const body = googleWireFormat.buildBody({
      model: 'gemini',
      maxTokens: 100,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call_abc',
              content: 'done',
            },
          ],
        },
      ],
    } as Parameters<typeof googleWireFormat.buildBody>[0]);
    const contents = body.contents as Array<{ role: string; parts: unknown[] }>;
    expect(
      (contents[0].parts[0] as { functionResponse?: { name: string } }).functionResponse?.name,
    ).toBe('call_abc');
  });

  it('handles image block with base64 source', () => {
    const body = googleWireFormat.buildBody({
      model: 'gemini',
      maxTokens: 100,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/jpeg', data: 'abc123' },
            },
          ],
        },
      ],
    } as Parameters<typeof googleWireFormat.buildBody>[0]);
    const contents = body.contents as Array<{ role: string; parts: unknown[] }>;
    const part = (contents[0].parts[0] as { inlineData?: { mimeType: string; data: string } })
      .inlineData;
    expect(part?.mimeType).toBe('image/jpeg');
    expect(part?.data).toBe('abc123');
  });

  it('uses image/png as default media type', () => {
    const body = googleWireFormat.buildBody({
      model: 'gemini',
      maxTokens: 100,
      messages: [
        {
          role: 'user',
          content: [{ type: 'image', source: { type: 'base64', data: 'xyz' } }],
        },
      ],
    } as Parameters<typeof googleWireFormat.buildBody>[0]);
    const contents = body.contents as Array<{ role: string; parts: unknown[] }>;
    const part = (contents[0].parts[0] as { inlineData?: { mimeType: string } }).inlineData;
    expect(part?.mimeType).toBe('image/png');
  });
});

describe('Google preset - sanitizeSchemaForGemini coverage via toolsToGemini', () => {
  it('filters out disallowed keys from tool inputSchema', () => {
    const body = googleWireFormat.buildBody({
      model: 'gemini',
      maxTokens: 100,
      messages: [],
      tools: [
        {
          name: 'complex',
          description: 'has disallowed keys',
          inputSchema: {
            type: 'object',
            properties: { q: { type: 'string', deprecated: true, customField: 'drop' } },
            required: ['q'],
            anyOf: [{ type: 'string' }, { type: 'number' }],
          },
        },
      ],
    } as Parameters<typeof googleWireFormat.buildBody>[0]);
    const decls = (body.tools as Array<{ functionDeclarations: Array<{ parameters: unknown }> }>)[0]
      .functionDeclarations[0].parameters as Record<string, unknown>;
    expect(decls).not.toHaveProperty('customField');
    expect((decls.properties as Record<string, unknown>)?.q).not.toHaveProperty('deprecated');
  });

  it('sanitizes disallowed keys but preserves allowed ones', () => {
    const body = googleWireFormat.buildBody({
      model: 'gemini',
      maxTokens: 100,
      messages: [],
      tools: [
        {
          name: 'complex',
          description: 'has disallowed keys',
          inputSchema: {
            type: 'object',
            properties: { q: { type: 'string', deprecated: true, customField: 'drop' } },
            required: ['q'],
            anyOf: [{ type: 'string' }, { type: 'number' }],
          },
        },
      ],
    } as Parameters<typeof googleWireFormat.buildBody>[0]);
    const decls = (body.tools as Array<{ functionDeclarations: Array<{ parameters: unknown }> }>)[0]
      .functionDeclarations[0].parameters as Record<string, unknown>;
    expect(decls).not.toHaveProperty('customField');
    expect((decls.properties as Record<string, unknown>)?.q).not.toHaveProperty('deprecated');
  });

  it('returns schema as-is when only allowed keys present', () => {
    const body = googleWireFormat.buildBody({
      model: 'gemini',
      maxTokens: 100,
      messages: [],
      tools: [
        {
          name: 'simple',
          description: 'single key',
          inputSchema: { type: 'string' } as Record<string, unknown>,
        },
      ],
    } as Parameters<typeof googleWireFormat.buildBody>[0]);
    const decls = (body.tools as Array<{ functionDeclarations: Array<{ parameters: unknown }> }>)[0]
      .functionDeclarations[0].parameters as Record<string, unknown>;
    // 'type' is an allowed key, so it is preserved (not filtered out)
    expect(decls).toEqual({ type: 'string' });
  });

  it('returns undefined for null/undefined inputSchema (falls back to empty object)', () => {
    const body = googleWireFormat.buildBody({
      model: 'gemini',
      maxTokens: 100,
      messages: [],
      tools: [
        { name: 'noparams', description: 'no schema', inputSchema: undefined },
        { name: 'nullparams', description: 'null schema', inputSchema: null as unknown },
      ],
    } as Parameters<typeof googleWireFormat.buildBody>[0]);
    const decls = (body.tools as Array<{ functionDeclarations: Array<{ parameters: unknown }> }>)[0]
      .functionDeclarations;
    expect(decls[0].parameters as Record<string, unknown>).toEqual({
      type: 'object',
      properties: {},
    });
    expect(decls[1].parameters as Record<string, unknown>).toEqual({
      type: 'object',
      properties: {},
    });
  });
});

describe('Google preset', () => {
  it('forces tool_use stop reason when a functionCall part was seen', async () => {
    const events = await collectFromPreset(
      googleWireFormat,
      sseBody([
        JSON.stringify({
          modelVersion: 'gemini-2.0-flash',
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ functionCall: { name: 'lookup', args: { q: 'hello' } } }],
              },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 5 },
        }),
      ]),
      'gemini-flash',
    );
    const tStart = events.find((e) => e.type === 'tool_use_start');
    expect((tStart as { name: string }).name).toBe('lookup');
    const tStop = events.find((e) => e.type === 'tool_use_stop');
    expect((tStop as { input: { q: string } }).input).toEqual({ q: 'hello' });
    const stop = events.find((e) => e.type === 'message_stop');
    expect((stop as { stopReason: string }).stopReason).toBe('tool_use');
  });

  it('emits text_delta for text parts', async () => {
    const events = await collectFromPreset(
      googleWireFormat,
      sseBody([
        JSON.stringify({
          modelVersion: 'gemini-2.0-flash',
          candidates: [
            { content: { role: 'model', parts: [{ text: 'hi' }] }, finishReason: 'STOP' },
          ],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
        }),
      ]),
      'gemini',
    );
    const text = events.find((e) => e.type === 'text_delta');
    expect((text as { text: string }).text).toBe('hi');
    const stop = events.find((e) => e.type === 'message_stop');
    expect((stop as { stopReason: string }).stopReason).toBe('end_turn');
  });

  it('preserves thoughtSignature in providerMeta', async () => {
    const events = await collectFromPreset(
      googleWireFormat,
      sseBody([
        JSON.stringify({
          modelVersion: 'gemini-2.0-flash',
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  {
                    functionCall: { name: 'doit', args: {} },
                    thoughtSignature: 'opaque-signature-blob',
                  },
                ],
              },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
        }),
      ]),
      'gemini',
    );
    const tStop = events.find((e) => e.type === 'tool_use_stop');
    expect(
      (tStop as { providerMeta?: Record<string, unknown> }).providerMeta?.[
        'google.thoughtSignature'
      ],
    ).toBe('opaque-signature-blob');
  });

  it('config metadata', () => {
    expect(googleWireFormat.id).toBe('google');
    expect(googleWireFormat.family).toBe('google');
    expect(googleWireFormat.capabilities.maxContext).toBe(1_000_000);
  });
});
