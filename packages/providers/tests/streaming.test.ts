import type { StreamEvent } from '@wrongstack/core';
import { describe, expect, it } from 'vitest';
import { AnthropicProvider } from '../src/anthropic.js';
import { GoogleProvider } from '../src/google.js';
import { OpenAIProvider } from '../src/openai.js';
import { OpenAICompatibleProvider } from '../src/openai-compatible.js';

function sseBody(events: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    pull(c) {
      c.enqueue(enc.encode(events));
      c.close();
    },
  });
}

function mockFetch(body: ReadableStream<Uint8Array>): typeof fetch {
  return (async () =>
    new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })) as never as typeof fetch;
}

describe('AnthropicProvider.stream', () => {
  it('parses canonical Anthropic SSE into StreamEvent[]', async () => {
    const sse = [
      'event: message_start',
      'data: {"type":"message_start","message":{"model":"claude-test","usage":{"input_tokens":12,"output_tokens":0}}}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}',
      '',
      'event: content_block_stop',
      'data: {"type":"content_block_stop","index":0}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
    ].join('\n');
    const provider = new AnthropicProvider({ apiKey: 'k', fetchImpl: mockFetch(sseBody(sse)) });
    const res = await provider.complete(
      { model: 'm', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 },
      { signal: new AbortController().signal },
    );
    expect(res.content).toEqual([{ type: 'text', text: 'Hello world' }]);
    expect(res.stopReason).toBe('end_turn');
    expect(res.usage).toEqual({
      input: 12,
      output: 7,
      cacheRead: undefined,
      cacheWrite: undefined,
    });
    expect(res.model).toBe('claude-test');
  });

  it('emits exactly one message_stop when Anthropic sends an explicit stop event', async () => {
    const sse = [
      'event: message_start',
      'data: {"type":"message_start","message":{"model":"claude-test","usage":{"input_tokens":1}}}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
    ].join('\n');
    const provider = new AnthropicProvider({ apiKey: 'k', fetchImpl: mockFetch(sseBody(sse)) });
    const events: StreamEvent[] = [];
    for await (const event of provider.stream(
      { model: 'm', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 },
      { signal: new AbortController().signal },
    )) {
      events.push(event);
    }
    expect(events.filter((e) => e.type === 'message_stop')).toHaveLength(1);
  });

  it('parses tool_use with partial JSON deltas', async () => {
    const sse = [
      'event: message_start',
      'data: {"type":"message_start","message":{"model":"m","usage":{"input_tokens":5}}}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"echo","input":{}}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"text\\":"}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"hi\\"}"}}',
      '',
      'event: content_block_stop',
      'data: {"type":"content_block_stop","index":0}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":4}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
    ].join('\n');
    const provider = new AnthropicProvider({ apiKey: 'k', fetchImpl: mockFetch(sseBody(sse)) });
    const res = await provider.complete(
      { model: 'm', messages: [{ role: 'user', content: 'go' }], maxTokens: 100 },
      { signal: new AbortController().signal },
    );
    expect(res.content).toEqual([
      { type: 'tool_use', id: 'toolu_1', name: 'echo', input: { text: 'hi' } },
    ]);
    expect(res.stopReason).toBe('tool_use');
  });
});

describe('OpenAIProvider.stream', () => {
  it('parses OpenAI chat.completion chunks into StreamEvent[]', async () => {
    const sse = [
      'data: {"id":"x","model":"gpt-test","choices":[{"index":0,"delta":{"content":"Hi"}}]}',
      '',
      'data: {"id":"x","choices":[{"index":0,"delta":{"content":" there"}}]}',
      '',
      'data: {"id":"x","choices":[{"index":0,"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":3}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    const provider = new OpenAIProvider({ apiKey: 'k', fetchImpl: mockFetch(sseBody(sse)) });
    const res = await provider.complete(
      { model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 },
      { signal: new AbortController().signal },
    );
    expect(res.content).toEqual([{ type: 'text', text: 'Hi there' }]);
    expect(res.stopReason).toBe('end_turn');
    expect(res.usage).toEqual({ input: 10, output: 3, cacheRead: undefined });
    expect(res.model).toBe('gpt-test');
  });

  it('splits DeepSeek cache hit and miss tokens for pricing', async () => {
    const sse = [
      'data: {"id":"x","model":"deepseek-chat","choices":[{"index":0,"delta":{"content":"ok"}}]}',
      '',
      'data: {"id":"x","choices":[{"index":0,"finish_reason":"stop"}],"usage":{"prompt_tokens":1000,"completion_tokens":20,"prompt_cache_hit_tokens":800,"prompt_cache_miss_tokens":200}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    const provider = new OpenAIProvider({ apiKey: 'k', fetchImpl: mockFetch(sseBody(sse)) });
    const res = await provider.complete(
      { model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 },
      { signal: new AbortController().signal },
    );
    expect(res.usage).toEqual({ input: 200, output: 20, cacheRead: 800 });
  });

  it('parses tool_calls with arguments streamed in chunks', async () => {
    const sse = [
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"echo","arguments":"{\\"text\\":"}}]}}]}',
      '',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"hi\\"}"}}]}}]}',
      '',
      'data: {"choices":[{"index":0,"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":7,"completion_tokens":4}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    const provider = new OpenAIProvider({ apiKey: 'k', fetchImpl: mockFetch(sseBody(sse)) });
    const res = await provider.complete(
      { model: 'm', messages: [{ role: 'user', content: 'go' }], maxTokens: 100 },
      { signal: new AbortController().signal },
    );
    expect(res.content).toEqual([
      { type: 'tool_use', id: 'call_1', name: 'echo', input: { text: 'hi' } },
    ]);
    expect(res.stopReason).toBe('tool_use');
  });

  it('keeps tool_call argument fragments that arrive before id/name metadata', async () => {
    const sse = [
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"text\\":"}}]}}]}',
      '',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_late","function":{"name":"echo","arguments":"\\"hi\\"}"}}]}}]}',
      '',
      'data: {"choices":[{"index":0,"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":7,"completion_tokens":4}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    const provider = new OpenAIProvider({ apiKey: 'k', fetchImpl: mockFetch(sseBody(sse)) });
    const res = await provider.complete(
      { model: 'm', messages: [{ role: 'user', content: 'go' }], maxTokens: 100 },
      { signal: new AbortController().signal },
    );
    expect(res.content).toEqual([
      { type: 'tool_use', id: 'call_late', name: 'echo', input: { text: 'hi' } },
    ]);
    expect(res.stopReason).toBe('tool_use');
  });

  it('synthesizes an id for streamed tool_calls that never carry one', async () => {
    // Some OpenAI-compatible servers emit tool calls with a name + arguments
    // but no `id`. The call must still dispatch (with a synthesized id)
    // rather than being silently dropped.
    const sse = [
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"name":"echo","arguments":"{\\"text\\":\\"hi\\"}"}}]}}]}',
      '',
      'data: {"choices":[{"index":0,"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":7,"completion_tokens":4}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    const provider = new OpenAIProvider({ apiKey: 'k', fetchImpl: mockFetch(sseBody(sse)) });
    const res = await provider.complete(
      { model: 'm', messages: [{ role: 'user', content: 'go' }], maxTokens: 100 },
      { signal: new AbortController().signal },
    );
    expect(res.content).toHaveLength(1);
    const block = res.content[0] as { type: string; id: string; name: string; input: unknown };
    expect(block.type).toBe('tool_use');
    expect(block.name).toBe('echo');
    expect(block.input).toEqual({ text: 'hi' });
    expect(block.id).toMatch(/^call_/);
    expect(res.stopReason).toBe('tool_use');
  });
});

describe('GoogleProvider.stream', () => {
  it('parses Gemini SSE chunks with text parts', async () => {
    const sse = [
      'data: {"candidates":[{"content":{"parts":[{"text":"Hi"}],"role":"model"}}],"modelVersion":"gemini-test"}',
      '',
      'data: {"candidates":[{"content":{"parts":[{"text":" world"}],"role":"model"}}]}',
      '',
      'data: {"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":2}}',
      '',
    ].join('\n');
    const provider = new GoogleProvider({ apiKey: 'k', fetchImpl: mockFetch(sseBody(sse)) });
    const res = await provider.complete(
      { model: 'gemini-test', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 },
      { signal: new AbortController().signal },
    );
    expect(res.content).toEqual([{ type: 'text', text: 'Hi world' }]);
    expect(res.stopReason).toBe('end_turn');
    expect(res.usage).toEqual({ input: 3, output: 2, cacheRead: undefined });
    expect(res.model).toBe('gemini-test');
  });

  it('emits tool_use for functionCall parts', async () => {
    const sse = [
      'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"echo","args":{"text":"hi"}}}],"role":"model"}}],"modelVersion":"gemini-test"}',
      '',
      'data: {"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":1}}',
      '',
    ].join('\n');
    const provider = new GoogleProvider({ apiKey: 'k', fetchImpl: mockFetch(sseBody(sse)) });
    const res = await provider.complete(
      { model: 'gemini-test', messages: [{ role: 'user', content: 'go' }], maxTokens: 100 },
      { signal: new AbortController().signal },
    );
    expect(res.content).toHaveLength(1);
    expect(res.content[0]).toMatchObject({ type: 'tool_use', name: 'echo', input: { text: 'hi' } });
  });
});

describe('thinking-mode round-trip', () => {
  it('AnthropicProvider captures thinking + signature blocks for echo-back', async () => {
    // Anthropic extended thinking emits a `thinking` content_block before
    // the text/tool_use, with both `thinking_delta` chunks and a single
    // `signature_delta`. Both must round-trip on the next request or the
    // API returns 400 "content[].thinking in the thinking mode must be
    // passed back to the API".
    const sse = [
      'event: message_start',
      'data: {"type":"message_start","message":{"model":"anthropic-test-model","usage":{"input_tokens":3}}}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Let me think"}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" carefully."}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig-xyz"}}',
      '',
      'event: content_block_stop',
      'data: {"type":"content_block_stop","index":0}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"42"}}',
      '',
      'event: content_block_stop',
      'data: {"type":"content_block_stop","index":1}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
    ].join('\n');
    const provider = new AnthropicProvider({ apiKey: 'k', fetchImpl: mockFetch(sseBody(sse)) });
    const res = await provider.complete(
      { model: 'm', messages: [{ role: 'user', content: 'compute' }], maxTokens: 100 },
      { signal: new AbortController().signal },
    );
    expect(res.content).toHaveLength(2);
    // Thinking block MUST come first — Anthropic rejects assistant
    // messages where it doesn't precede other content.
    expect(res.content[0]).toEqual({
      type: 'thinking',
      thinking: 'Let me think carefully.',
      signature: 'sig-xyz',
    });
    expect(res.content[1]).toEqual({ type: 'text', text: '42' });
  });

  it('OpenAIProvider captures top-level delta.reasoning_content as ThinkingBlock', async () => {
    // DeepSeek streams chain-of-thought via `delta.reasoning_content` at
    // the TOP level of the delta — NOT inside tool_calls (the previous
    // implementation looked in the wrong place and lost the blob).
    const sse = [
      'data: {"id":"x","choices":[{"index":0,"delta":{"reasoning_content":"working..."}}]}',
      '',
      'data: {"id":"x","choices":[{"index":0,"delta":{"reasoning_content":" almost there"}}]}',
      '',
      'data: {"id":"x","choices":[{"index":0,"delta":{"content":"42"}}]}',
      '',
      'data: {"id":"x","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    const provider = new OpenAIProvider({ apiKey: 'k', fetchImpl: mockFetch(sseBody(sse)) });
    const res = await provider.complete(
      { model: 'deepseek-reasoner', messages: [{ role: 'user', content: 'q' }], maxTokens: 100 },
      { signal: new AbortController().signal },
    );
    expect(res.content).toHaveLength(2);
    expect(res.content[0]).toEqual({ type: 'thinking', thinking: 'working... almost there' });
    expect(res.content[1]).toEqual({ type: 'text', text: '42' });
  });

  it('OpenAIProvider closes thinking before emitting tool_use_start when both arrive (lines 202-203)', async () => {
    // Lines 202-203: when tool_calls arrive while thinkingOpen is true,
    // we must emit thinking_stop before tool_use_start.
    const sse = [
      'data: {"id":"x","choices":[{"index":0,"delta":{"reasoning_content":"thinking..."}}]}',
      '',
      // tool_calls arrive while thinkingOpen is true — must close thinking first
      'data: {"id":"x","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"echo","arguments":"{\\"x\\":1}"}}]}}]}',
      '',
      'data: {"id":"x","choices":[{"index":0,"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    const provider = new OpenAIProvider({ apiKey: 'k', fetchImpl: mockFetch(sseBody(sse)) });
    const res = await provider.complete(
      { model: 'm', messages: [{ role: 'user', content: 'go' }], maxTokens: 100 },
      { signal: new AbortController().signal },
    );
    // Both thinking and tool should appear
    expect(res.content).toHaveLength(2);
    expect(res.content[0]).toEqual({ type: 'thinking', thinking: 'thinking...' });
    expect(res.content[1]).toMatchObject({ type: 'tool_use', id: 'c1', name: 'echo' });
  });

  it('OpenAIProvider yields thinking_stop at end-of-stream when thinkingOpen is true (line 277)', async () => {
    // Line 276-278: if thinkingOpen is still true when the stream ends,
    // we must yield thinking_stop before message_stop.
    const sse = [
      'data: {"id":"x","choices":[{"index":0,"delta":{"reasoning_content":"ongoing thought"}}]}',
      '',
      // Stream ends WITHOUT a final content/text event — thinking still open
      'data: {"id":"x","choices":[{"index":0,"finish_reason":"end_turn"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    const provider = new OpenAIProvider({ apiKey: 'k', fetchImpl: mockFetch(sseBody(sse)) });
    const events: StreamEvent[] = [];
    for await (const ev of provider.stream(
      { model: 'm', messages: [{ role: 'user', content: 'x' }], maxTokens: 100 },
      { signal: new AbortController().signal },
    )) {
      events.push(ev);
    }
    const stopIdx = events.findIndex((e) => e.type === 'thinking_stop');
    expect(stopIdx).toBeGreaterThan(0); // thinking_stop appears after thinking_start/delta
    // Should not have text after the thinking block
    expect(events.filter((e) => e.type === 'text_delta')).toHaveLength(0);
  });

  it('OpenAIProvider emits tool_use_stop for entries that never had tool_use_start (line 281-282)', async () => {
    // Line 281-282: when id/name arrive in a later chunk (after arguments already
    // populated argBuf), emittedStart is still false when we process that chunk,
    // so we emit tool_use_start + tool_use_stop at end-of-stream.
    const sse = [
      // First chunk: index 0 with arguments but NO id/name (emittedStart stays false)
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"x\\":"}}]}}]}',
      '',
      // Second chunk: same index but id/name arrive here
      'data: {"id":"x","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c_late","function":{"name":"echo","arguments":"\\"hi\\""}}]}}]}',
      '',
      'data: {"id":"x","choices":[{"index":0,"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    const provider = new OpenAIProvider({ apiKey: 'k', fetchImpl: mockFetch(sseBody(sse)) });
    const res = await provider.complete(
      { model: 'm', messages: [{ role: 'user', content: 'go' }], maxTokens: 100 },
      { signal: new AbortController().signal },
    );
    // Should produce exactly one tool_use block with id/name from the second chunk
    expect(res.content).toHaveLength(1);
    const tool = res.content[0] as { type: string; id?: string; name?: string };
    expect(tool.type).toBe('tool_use');
    expect(tool.id).toBe('c_late');
    expect(tool.name).toBe('echo');
  });
});

describe('OpenAICompatibleProvider stripThinkTags quirk', () => {
  /** Enqueue each string as its own stream chunk so tag-splitting is exercised. */
  function chunkedBody(chunks: string[]): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    let i = 0;
    return new ReadableStream({
      pull(c) {
        if (i < chunks.length) {
          c.enqueue(enc.encode(chunks[i++] ?? ''));
        } else {
          c.close();
        }
      },
    });
  }

  async function run(
    chunks: string[],
    quirks?: { stripThinkTags?: boolean },
  ): Promise<{ content: StreamEvent[]; events: StreamEvent[] }> {
    const provider = new OpenAICompatibleProvider({
      id: 'omniroute',
      apiKey: 'k',
      baseUrl: 'http://localhost/v1',
      quirks,
      fetchImpl: mockFetch(chunkedBody(chunks)),
    });
    const events: StreamEvent[] = [];
    for await (const ev of provider.stream(
      { model: 'm', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 },
      { signal: new AbortController().signal },
    )) {
      events.push(ev);
    }
    // Rebuild the canonical content blocks from the collected events so we
    // assert on the same stream the agent loop would consume (single read —
    // the mock body can only be consumed once).
    const content: StreamEvent[] = [];
    let text = '';
    let thinking = '';
    const flushText = (): void => {
      if (text) {
        content.push({ type: 'text', text } as unknown as StreamEvent);
        text = '';
      }
    };
    const flushThinking = (): void => {
      if (thinking) {
        content.push({ type: 'thinking', thinking } as unknown as StreamEvent);
        thinking = '';
      }
    };
    for (const ev of events) {
      if (ev.type === 'text_delta') {
        flushThinking();
        text += ev.text;
      } else if (ev.type === 'thinking_delta') {
        flushText();
        thinking += ev.text;
      } else if (ev.type === 'thinking_stop') {
        flushThinking();
      }
    }
    flushThinking();
    flushText();
    return { content, events };
  }

  it('drops a stray leaked </think> with no opener (the omniroute artifact)', async () => {
    const { content } = await run(
      [
        'data: {"choices":[{"index":0,"delta":{"content":"</think>"}}]}\n\n',
        'data: {"choices":[{"index":0,"delta":{"content":"The answer is 42."}}]}\n\n',
        'data: {"choices":[{"index":0,"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n',
        'data: [DONE]\n\n',
      ],
      { stripThinkTags: true },
    );
    expect(content).toEqual([{ type: 'text', text: 'The answer is 42.' }]);
  });

  it('leaves the </think> in place when the quirk is off', async () => {
    const { content } = await run([
      'data: {"choices":[{"index":0,"delta":{"content":"</think>"}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":"The answer is 42."}}]}\n\n',
      'data: {"choices":[{"index":0,"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n',
      'data: [DONE]\n\n',
    ]);
    expect(content).toEqual([{ type: 'text', text: '</think>The answer is 42.' }]);
  });

  it('routes a full <think>…</think> block to the thinking channel', async () => {
    const { content, events } = await run(
      [
        'data: {"choices":[{"index":0,"delta":{"content":"<think>reasoning here</think>visible answer"}}]}\n\n',
        'data: {"choices":[{"index":0,"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n',
        'data: [DONE]\n\n',
      ],
      { stripThinkTags: true },
    );
    expect(content).toEqual([
      { type: 'thinking', thinking: 'reasoning here' },
      { type: 'text', text: 'visible answer' },
    ]);
    expect(events.some((e) => e.type === 'thinking_delta')).toBe(true);
  });

  it('recognises a tag split across stream chunks', async () => {
    const { content } = await run(
      [
        'data: {"choices":[{"index":0,"delta":{"content":"<thi"}}]}\n\n',
        'data: {"choices":[{"index":0,"delta":{"content":"nk>hidden</thi"}}]}\n\n',
        'data: {"choices":[{"index":0,"delta":{"content":"nk>shown"}}]}\n\n',
        'data: {"choices":[{"index":0,"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n',
        'data: [DONE]\n\n',
      ],
      { stripThinkTags: true },
    );
    expect(content).toEqual([
      { type: 'thinking', thinking: 'hidden' },
      { type: 'text', text: 'shown' },
    ]);
  });

  it('flushes a never-completed partial tag as literal text at stream end', async () => {
    const { content } = await run(
      [
        'data: {"choices":[{"index":0,"delta":{"content":"done<"}}]}\n\n',
        'data: {"choices":[{"index":0,"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n',
        'data: [DONE]\n\n',
      ],
      { stripThinkTags: true },
    );
    expect(content).toEqual([{ type: 'text', text: 'done<' }]);
  });
});
