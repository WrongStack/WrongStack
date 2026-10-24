/**
 * History built on one wire must stay sendable on another (`/model` switch,
 * fallback hop), and wire-specific payloads must survive their own round trip.
 */
import type { Message, StreamEvent } from '@wrongstack/contracts/types';
import { describe, expect, it } from 'vitest';
import { convertMessages } from '../src/ai-gateway.js';
import { makeProviderFromConfig } from '../src/index.js';
import { parseOpenAIResponsesStream } from '../src/openai-codex.js';
import { ANTHROPIC_REDACTED_THINKING_META, anthropicWireFormat } from '../src/presets/anthropic.js';
import { googleWireFormat } from '../src/presets/google.js';
import { messagesToOpenAI } from '../src/tool-format/to-openai.js';

function sse(frames: unknown[]): ReadableStream<Uint8Array> {
  const text = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('');
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

describe('AI Gateway providerOptions from foreign-wire history', () => {
  it('drops flat (non-namespaced) providerMeta the AI SDK schema would reject', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'thinking',
            thinking: 'hm',
            signature: 'sig-1',
            providerMeta: { 'codex.reasoningId': 'rs_1' },
          },
          {
            type: 'tool_use',
            id: 't1',
            name: 'ls',
            input: {},
            providerMeta: { 'google.thoughtSignature': 'abc', vertex: { x: 1 } },
          },
        ],
      },
    ];
    const [assistant] = convertMessages(messages) as Array<{
      content: Array<Record<string, unknown>>;
    }>;
    const [reasoning, call] = assistant?.content ?? [];
    // No namespaced meta left → the Anthropic signature fallback applies.
    expect(reasoning?.['providerOptions']).toEqual({ anthropic: { signature: 'sig-1' } });
    expect(call?.['providerOptions']).toEqual({ vertex: { x: 1 } });
  });
});

describe('Anthropic redacted_thinking round trip', () => {
  it('captures the opaque data and sends it back as a redacted_thinking block', () => {
    const state = anthropicWireFormat.createStreamState('c');
    const events: StreamEvent[] = anthropicWireFormat.parseStreamEvent(
      {
        event: 'content_block_start',
        data: JSON.stringify({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'redacted_thinking', data: 'ENCRYPTED' },
        }),
      },
      state,
    );
    expect(events).toEqual([
      { type: 'thinking_start', providerMeta: { [ANTHROPIC_REDACTED_THINKING_META]: 'ENCRYPTED' } },
    ]);

    const body = anthropicWireFormat.buildBody(
      {
        model: 'claude-x',
        maxTokens: 4096,
        messages: [
          { role: 'user', content: 'hi' },
          {
            role: 'assistant',
            content: [
              {
                type: 'thinking',
                thinking: '',
                providerMeta: { [ANTHROPIC_REDACTED_THINKING_META]: 'ENCRYPTED' },
              },
              { type: 'tool_use', id: 't1', name: 'ls', input: {} },
            ],
          },
        ],
      },
      { capabilities: anthropicWireFormat.capabilities, providerId: 'anthropic' },
    );
    const assistant = (body['messages'] as Array<{ content: unknown[] }>)[1];
    expect(assistant?.content[0]).toEqual({ type: 'redacted_thinking', data: 'ENCRYPTED' });
  });
});

describe('Responses stream terminal envelopes', () => {
  it('accepts response.done as a terminal event with usage', async () => {
    const events: StreamEvent[] = [];
    for await (const ev of parseOpenAIResponsesStream(
      sse([
        { type: 'response.created', response: { model: 'gpt-5' } },
        { type: 'response.output_text.delta', delta: 'ok' },
        {
          type: 'response.done',
          response: { status: 'completed', usage: { input_tokens: 3, output_tokens: 1 } },
        },
      ]),
      'gpt-5',
    )) {
      events.push(ev);
    }
    expect(events.at(-1)).toMatchObject({ type: 'message_stop', stopReason: 'end_turn' });
  });

  it('raises a failed response.done', async () => {
    const run = async () => {
      for await (const _ of parseOpenAIResponsesStream(
        sse([
          {
            type: 'response.done',
            response: { status: 'failed', error: { code: 'server_error', message: 'boom' } },
          },
        ]),
        'gpt-5',
      )) {
        // drain
      }
    };
    await expect(run()).rejects.toMatchObject({ retryable: true });
  });
});

describe('keyless local providers', () => {
  it.each(['ollama', 'omniroute', 'lmstudio', 'vllm'])(
    '%s saved without a key still builds',
    (id) => {
      expect(() =>
        makeProviderFromConfig(id, {
          family: 'openai-compatible',
          baseUrl: 'http://localhost:11434/v1',
        } as never),
      ).not.toThrow();
    },
  );

  it('a remote provider without a key is still rejected', () => {
    expect(() =>
      makeProviderFromConfig('my-remote', {
        family: 'openai-compatible',
        baseUrl: 'https://api.example.com/v1',
      } as never),
    ).toThrow(/requires an API key/);
  });
});

describe('tool call ids on the Chat Completions wire', () => {
  it('rewrites over-long foreign ids consistently for the call and its result', () => {
    const longId = `mcp__some_server__a_really_long_tool_name_here_1a2b3c4d`;
    const wire = messagesToOpenAI(undefined, [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: longId, name: 'x', input: {} }],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: longId, content: 'ok' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_short', name: 'x', input: {} }],
      },
    ]);
    const callId = wire[0]?.tool_calls?.[0]?.id ?? '';
    expect(callId.length).toBeLessThanOrEqual(40);
    expect(wire[1]?.tool_call_id).toBe(callId);
    expect(wire[2]?.tool_calls?.[0]?.id).toBe('call_short');
  });

  it('Gemini mints ids within the limit regardless of tool name length', () => {
    const state = googleWireFormat.createStreamState('g');
    const events = googleWireFormat.parseStreamEvent(
      {
        event: 'message',
        data: JSON.stringify({
          candidates: [
            { content: { parts: [{ functionCall: { name: 'n'.repeat(64), args: {} } }] } },
          ],
        }),
      },
      state,
    );
    const start = events.find((e) => e.type === 'tool_use_start') as { id: string };
    expect(start.id.length).toBeLessThanOrEqual(40);
  });

  it('Gemini resolves functionResponse.name from prior tool_use when tool_result omits name (F117)', () => {
    const body = googleWireFormat.buildBody(
      {
        model: 'gemini-2.5-pro',
        maxTokens: 1024,
        messages: [
          { role: 'user', content: 'List files' },
          {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'call_abc123', name: 'list_dir', input: { path: '.' } },
            ],
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'call_abc123', content: '["a.ts"]' }],
          },
        ],
      },
      { capabilities: googleWireFormat.capabilities, providerId: 'google' },
    );
    const contents = body['contents'] as Array<{
      role: string;
      parts: Array<{ functionResponse?: { name: string } }>;
    }>;
    expect(contents[2]?.parts[0]?.functionResponse?.name).toBe('list_dir');
  });
});
