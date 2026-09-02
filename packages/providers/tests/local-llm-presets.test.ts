import type { StreamEvent } from '@wrongstack/core/types';
import { describe, expect, it } from 'vitest';
import {
  createLocalLlmPreset,
  lmstudioWireFormat,
  ollamaWireFormat,
  vllmWireFormat,
} from '../src/presets/local-llm.js';
import { WireFormatProvider } from '../src/wire-format.js';

/**
 * The local-LLM presets (Ollama, vLLM, LM Studio) all share an
 * OpenAI-compatible wire — what differs is the default base URL, the
 * auth header, and a small set of body extras. These tests cover the
 * shape of each preset plus the underlying factory.
 */

// --- Test helpers ----------------------------------------------------------

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
      body,
    }) as never as Response) as never as typeof fetch;
}

async function collectFromPreset(
  format: Parameters<typeof WireFormatProvider>[0],
  body: ReadableStream<Uint8Array>,
  model: string,
  apiKey = 'test-key',
): Promise<StreamEvent[]> {
  const provider = new WireFormatProvider(format, {
    apiKey,
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

// --- Shared factory: createLocalLlmPreset ----------------------------------

describe('createLocalLlmPreset', () => {
  it('produces a wire format that is openai-compatible', () => {
    const p = createLocalLlmPreset({ id: 'x', defaultBaseUrl: 'http://x' });
    expect(p.family).toBe('openai-compatible');
    expect(p.id).toBe('x');
    expect(p.capabilities.streaming).toBe(true);
  });

  it('uses max_tokens (legacy field) in the request body', () => {
    const p = createLocalLlmPreset({ id: 'x', defaultBaseUrl: 'http://x' });
    const body = p.buildBody({
      model: 'm',
      maxTokens: 256,
      messages: [{ role: 'user', content: 'hi' }],
    } as Parameters<typeof p.buildBody>[0]);
    expect(body).toMatchObject({ max_tokens: 256 });
    expect(body).not.toHaveProperty('max_completion_tokens');
  });

  it('omits Authorization header when noAuth is true', () => {
    const p = createLocalLlmPreset({
      id: 'no-auth',
      defaultBaseUrl: 'http://x',
      noAuth: true,
    });
    expect(p.buildHeaders('irrelevant-key')).toEqual({});
  });

  it('sends a Bearer header with the supplied key when noAuth is false', () => {
    const p = createLocalLlmPreset({ id: 'bearer', defaultBaseUrl: 'http://x' });
    expect(p.buildHeaders('sk-local')).toEqual({ authorization: 'Bearer sk-local' });
  });

  it('falls back to a placeholder Bearer when key is empty and auth is enabled', () => {
    // vLLM/LM Studio may have auth disabled, in which case they ignore the
    // header. The preset must still emit one so we never ship malformed
    // headers when callers pass an empty key.
    const p = createLocalLlmPreset({ id: 'bearer', defaultBaseUrl: 'http://x' });
    expect(p.buildHeaders('')).toEqual({ authorization: 'Bearer no-key' });
  });

  it('merges bodyExtras but never lets them shadow canonical fields', () => {
    const p = createLocalLlmPreset({
      id: 'x',
      defaultBaseUrl: 'http://x',
      bodyExtras: {
        keep_alive: '5m',
        // Attempted shadow attacks — must be ignored.
        model: 'attacker-model',
        messages: 'attacker',
        max_tokens: 999_999,
      },
    });
    const body = p.buildBody({
      model: 'real-model',
      maxTokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
    } as Parameters<typeof p.buildBody>[0]);
    expect(body).toMatchObject({
      model: 'real-model',
      max_tokens: 100,
      keep_alive: '5m',
    });
    expect(body['messages']).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('builds the OpenAI-compatible chat completions URL with sensible variants', () => {
    const p = createLocalLlmPreset({ id: 'x', defaultBaseUrl: 'http://x' });
    expect(p.buildUrl('http://localhost:11434')).toBe('http://localhost:11434/v1/chat/completions');
    expect(p.buildUrl('http://localhost:11434/v1')).toBe(
      'http://localhost:11434/v1/chat/completions',
    );
    expect(p.buildUrl('http://localhost:11434/v1/chat/completions')).toBe(
      'http://localhost:11434/v1/chat/completions',
    );
    expect(p.buildUrl('http://localhost:11434/v1///')).toBe(
      'http://localhost:11434/v1/chat/completions',
    );
  });

  it('passes tool definitions through to the body in OpenAI shape', () => {
    const p = createLocalLlmPreset({ id: 'x', defaultBaseUrl: 'http://x' });
    const body = p.buildBody({
      model: 'm',
      maxTokens: 100,
      messages: [],
      tools: [{ name: 'lookup', description: 'look up', inputSchema: { type: 'object' } }],
      toolChoice: { name: 'lookup' },
    } as Parameters<typeof p.buildBody>[0]);
    expect(body).toMatchObject({
      tools: [
        {
          type: 'function',
          function: { name: 'lookup', description: 'look up' },
        },
      ],
      tool_choice: { type: 'function', function: { name: 'lookup' } },
    });
  });
});

// --- Ollama preset ---------------------------------------------------------

describe('Ollama preset', () => {
  it('identifies as openai-compatible with the right id and default base URL', () => {
    expect(ollamaWireFormat.id).toBe('ollama');
    expect(ollamaWireFormat.family).toBe('openai-compatible');
    expect(ollamaWireFormat.defaultBaseUrl).toBe('http://localhost:11434/v1');
  });

  it('sends no Authorization header (Ollama rejects auth by default)', () => {
    expect(ollamaWireFormat.buildHeaders('anything')).toEqual({});
  });

  it('injects keep_alive by default', () => {
    const body = ollamaWireFormat.buildBody({
      model: 'llama3.1:8b',
      maxTokens: 256,
      messages: [{ role: 'user', content: 'hi' }],
    } as Parameters<typeof ollamaWireFormat.buildBody>[0]);
    expect(body).toMatchObject({ keep_alive: '5m' });
  });

  it('streams text + tool_call + finish_reason into canonical events', async () => {
    const events = await collectFromPreset(
      ollamaWireFormat,
      sseBody([
        JSON.stringify({ model: 'llama3.1:8b', choices: [{ delta: { content: 'hi ' } }] }),
        JSON.stringify({ choices: [{ delta: { content: 'there' } }] }),
        JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_a',
                    function: { name: 'lookup', arguments: '{"q":' },
                  },
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
          choices: [{ delta: {}, finish_reason: 'stop' }],
        }),
        // Ollama frequently omits usage on the final chunk — keep it absent.
        '[DONE]',
      ]),
      'llama3.1:8b',
    );

    const start = events.find((e) => e.type === 'message_start');
    expect((start as { model: string }).model).toBe('llama3.1:8b');

    const texts = events.filter((e) => e.type === 'text_delta');
    expect(texts.map((e) => (e as { text: string }).text).join('')).toBe('hi there');

    const tStart = events.find((e) => e.type === 'tool_use_start');
    expect(tStart).toEqual({ type: 'tool_use_start', id: 'call_a', name: 'lookup' });

    const tStop = events.find((e) => e.type === 'tool_use_stop');
    expect((tStop as { input: unknown }).input).toEqual({ q: 'x' });

    const stop = events.find((e) => e.type === 'message_stop');
    expect(stop).toBeDefined();
    expect((stop as { stopReason: string }).stopReason).toBe('end_turn');
  });

  it('synthesizes message_stop when upstream closes without [DONE] or finish_reason', async () => {
    // Real Ollama streams often terminate abruptly after a final content chunk.
    const events = await collectFromPreset(
      ollamaWireFormat,
      sseBody([JSON.stringify({ model: 'llama3', choices: [{ delta: { content: 'answer' } }] })]),
      'llama3',
    );
    expect(events.some((e) => e.type === 'text_delta')).toBe(true);
    const stop = events.find((e) => e.type === 'message_stop');
    expect(stop).toBeDefined();
    // No finish_reason ever appeared → default stop reason.
    expect((stop as { stopReason: string }).stopReason).toBe('end_turn');
  });

  it('extracts usage when Ollama does emit it', async () => {
    const events = await collectFromPreset(
      ollamaWireFormat,
      sseBody([
        JSON.stringify({ model: 'llama3', choices: [{ delta: { content: 'x' } }] }),
        JSON.stringify({
          choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 12, completion_tokens: 3 },
        }),
        '[DONE]',
      ]),
      'llama3',
    );
    const stop = events.find((e) => e.type === 'message_stop');
    expect((stop as { usage: { input: number; output: number } }).usage).toEqual({
      input: 12,
      output: 3,
    });
  });
});

// --- vLLM preset -----------------------------------------------------------

describe('vLLM preset', () => {
  it('identifies with the vLLM id and default port 8000', () => {
    expect(vllmWireFormat.id).toBe('vllm');
    expect(vllmWireFormat.defaultBaseUrl).toBe('http://localhost:8000/v1');
    expect(vllmWireFormat.family).toBe('openai-compatible');
  });

  it('sends a Bearer header (vLLM may have auth enabled)', () => {
    expect(vllmWireFormat.buildHeaders('any-key')).toEqual({
      authorization: 'Bearer any-key',
    });
  });

  it('advertises a larger default context window than Ollama/LM Studio', () => {
    expect(vllmWireFormat.capabilities.maxContext).toBe(32_768);
  });

  it('maps length finish_reason to max_tokens stop reason', async () => {
    const events = await collectFromPreset(
      vllmWireFormat,
      sseBody([
        JSON.stringify({ model: 'meta-llama/Llama-3-8B', choices: [{ delta: { content: 'x' } }] }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] }),
        '[DONE]',
      ]),
      'meta-llama/Llama-3-8B',
    );
    const stop = events.find((e) => e.type === 'message_stop');
    expect((stop as { stopReason: string }).stopReason).toBe('max_tokens');
  });

  it('tolerates a stream that closes abruptly without [DONE]', async () => {
    const events = await collectFromPreset(
      vllmWireFormat,
      sseBody([JSON.stringify({ model: 'm', choices: [{ delta: { content: 'x' } }] })]),
      'm',
    );
    const stop = events.find((e) => e.type === 'message_stop');
    expect(stop).toBeDefined();
  });
});

// --- LM Studio preset ------------------------------------------------------

describe('LM Studio preset', () => {
  it('identifies with the LM Studio id and default port 1234', () => {
    expect(lmstudioWireFormat.id).toBe('lmstudio');
    expect(lmstudioWireFormat.defaultBaseUrl).toBe('http://localhost:1234/v1');
    expect(lmstudioWireFormat.family).toBe('openai-compatible');
  });

  it('sends a Bearer header', () => {
    expect(lmstudioWireFormat.buildHeaders('lmstudio-key')).toEqual({
      authorization: 'Bearer lmstudio-key',
    });
  });

  it('parses an OpenAI-style tool call stream end-to-end', async () => {
    const events = await collectFromPreset(
      lmstudioWireFormat,
      sseBody([
        JSON.stringify({
          model: 'qwen2.5-7b',
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 'lm_1', function: { name: 'search', arguments: '{"q":' } },
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
          usage: { prompt_tokens: 5, completion_tokens: 2 },
        }),
        '[DONE]',
      ]),
      'qwen2.5-7b',
    );
    const tStart = events.find((e) => e.type === 'tool_use_start');
    expect(tStart).toEqual({ type: 'tool_use_start', id: 'lm_1', name: 'search' });
    const tStop = events.find((e) => e.type === 'tool_use_stop');
    expect((tStop as { input: unknown }).input).toEqual({ q: 'x' });
    const stop = events.find((e) => e.type === 'message_stop');
    expect((stop as { stopReason: string }).stopReason).toBe('tool_use');
  });
});

// --- Local-LLM presets: cross-cutting robustness ----------------------------

describe('Local-LLM presets - common edge cases', () => {
  const presets = [
    { name: 'ollama', format: ollamaWireFormat },
    { name: 'vllm', format: vllmWireFormat },
    { name: 'lmstudio', format: lmstudioWireFormat },
  ] as const;

  for (const { name, format } of presets) {
    describe(`${name}`, () => {
      it('ignores malformed SSE data without crashing', async () => {
        const events = await collectFromPreset(
          format,
          sseBody([
            'not-json-at-all',
            JSON.stringify({ model: 'm', choices: [{ delta: { content: 'ok' } }] }),
            JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
            '[DONE]',
          ]),
          'm',
        );
        const text = events.find((e) => e.type === 'text_delta');
        expect(text).toBeDefined();
      });

      it('emits a final message_stop on the [DONE] sentinel (terminal chunk)', async () => {
        const events = await collectFromPreset(
          format,
          sseBody([
            JSON.stringify({ model: 'm', choices: [{ delta: { content: 'x' } }] }),
            JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
            '[DONE]',
          ]),
          'm',
        );
        const stops = events.filter((e) => e.type === 'message_stop');
        expect(stops).toHaveLength(1);
        expect((stops[0] as { stopReason: string }).stopReason).toBe('end_turn');
      });

      it('uses the fallback model when upstream omits the model field', async () => {
        const events = await collectFromPreset(
          format,
          sseBody([
            JSON.stringify({ choices: [{ delta: { content: 'x' } }] }),
            JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
            '[DONE]',
          ]),
          'fallback-model-id',
        );
        const start = events.find((e) => e.type === 'message_start');
        expect((start as { model: string }).model).toBe('fallback-model-id');
      });

      it('omits temperature/top_p/stop from body when not provided', () => {
        const body = format.buildBody({
          model: 'm',
          maxTokens: 100,
          messages: [],
        } as Parameters<typeof format.buildBody>[0]);
        expect(body).not.toHaveProperty('temperature');
        expect(body).not.toHaveProperty('top_p');
        expect(body).not.toHaveProperty('stop');
        // `keep_alive` is a preset extra on Ollama only — make sure
        // the absence-of-others check is correct for all three.
        if (name !== 'ollama') {
          expect(body).not.toHaveProperty('keep_alive');
        }
      });
    });
  }
});
