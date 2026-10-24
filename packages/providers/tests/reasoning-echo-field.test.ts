import type { Message } from '@wrongstack/contracts/types';
import { afterEach, describe, expect, it } from 'vitest';
import { isCompatibilityQuirks, OpenAICompatibleProvider } from '../src/openai-compatible.js';
import {
  learnReasoningEchoRefusal,
  refusedReasoningEchoField,
  resetReasoningEchoSupport,
  resolveReasoningEchoField,
} from '../src/reasoning-echo-support.js';
import { messagesToOpenAI } from '../src/tool-format/to-openai.js';

// The exact 400 Cerebras returns when an assistant turn carries `reasoning_content`.
const CEREBRAS_REFUSAL = JSON.stringify({
  message: "property 'messages.2.assistant.reasoning_content' is unsupported",
  type: 'invalid_request_error',
  param: 'messages.2.assistant.reasoning_content',
  code: 'wrong_api_format',
});

const HISTORY: Message[] = [
  { role: 'user', content: 'hi' },
  {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'let me think' },
      { type: 'text', text: 'hello' },
    ],
  },
  { role: 'user', content: 'again' },
];

function assistantOf(body: Record<string, unknown>): Record<string, unknown> {
  const messages = body['messages'] as Array<Record<string, unknown>>;
  const found = messages.find((m) => m['role'] === 'assistant');
  if (!found) throw new Error('no assistant message on the wire');
  return found;
}

function okStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(
        new TextEncoder().encode(
          'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        ),
      );
      c.close();
    },
  });
}

/** A strict endpoint: 400s (Cerebras wording) on any echo field it does not accept. */
function strictEndpoint(accepts: 'reasoning' | 'none', bodies: Array<Record<string, unknown>>) {
  return (async (_url: unknown, init: { body?: string } = {}) => {
    const body = JSON.parse(init.body ?? '{}') as Record<string, unknown>;
    bodies.push(body);
    const assistant = assistantOf(body);
    const refused =
      'reasoning_content' in assistant
        ? 'reasoning_content'
        : accepts === 'none' && 'reasoning' in assistant
          ? 'reasoning'
          : undefined;
    if (refused) {
      return {
        ok: false,
        status: 400,
        text: async (): Promise<string> =>
          JSON.stringify({
            message: `property 'messages.2.assistant.${refused}' is unsupported`,
            code: 'wrong_api_format',
          }),
      };
    }
    return { ok: true, status: 200, body: okStream(), text: async (): Promise<string> => '' };
  }) as never as typeof fetch;
}

afterEach(() => resetReasoningEchoSupport());

describe('messagesToOpenAI reasoning echo field', () => {
  it('defaults to reasoning_content (DeepSeek/Kimi contract)', () => {
    const [, assistant] = messagesToOpenAI(undefined, HISTORY);
    expect(assistant).toMatchObject({ role: 'assistant', reasoning_content: 'let me think' });
    expect(assistant).not.toHaveProperty('reasoning');
  });

  it('writes `reasoning` instead when asked (Cerebras)', () => {
    const [, assistant] = messagesToOpenAI(undefined, HISTORY, { reasoningEchoField: 'reasoning' });
    expect(assistant).toMatchObject({ role: 'assistant', reasoning: 'let me think' });
    expect(assistant).not.toHaveProperty('reasoning_content');
  });

  it('drops the echo entirely on omit', () => {
    const [, assistant] = messagesToOpenAI(undefined, HISTORY, { reasoningEchoField: 'omit' });
    expect(assistant).not.toHaveProperty('reasoning');
    expect(assistant).not.toHaveProperty('reasoning_content');
    expect(assistant).toMatchObject({ content: 'hello' });
  });
});

describe('refusedReasoningEchoField', () => {
  it('reads the Cerebras refusal', () => {
    expect(refusedReasoningEchoField({ status: 400, body: { raw: CEREBRAS_REFUSAL } })).toBe(
      'reasoning_content',
    );
    expect(
      refusedReasoningEchoField({
        status: 400,
        message: "property 'messages.2.assistant.reasoning' is unsupported",
      }),
    ).toBe('reasoning');
  });

  it("never reads DeepSeek's demand for the field as a refusal", () => {
    expect(
      refusedReasoningEchoField({
        status: 400,
        message: 'The reasoning_content in the thinking mode must be passed back to the API.',
      }),
    ).toBeUndefined();
  });

  it('ignores reasoning_effort refusals and non-request failures', () => {
    expect(
      refusedReasoningEchoField({ status: 400, message: "'reasoning_effort' is not supported" }),
    ).toBeUndefined();
    expect(refusedReasoningEchoField({ status: 500, body: { raw: CEREBRAS_REFUSAL } })).toBe(
      undefined,
    );
  });

  it('only learns a refusal of the field that was actually sent', () => {
    const err = { status: 400, body: { raw: CEREBRAS_REFUSAL } };
    expect(learnReasoningEchoRefusal('p', 'm', 'reasoning', err)).toBeUndefined();
    expect(learnReasoningEchoRefusal('p', 'm', undefined, err)).toBe('reasoning');
    expect(resolveReasoningEchoField('p', 'm', undefined, 'https://x.test/v1')).toBe('reasoning');
  });
});

describe('resolveReasoningEchoField', () => {
  it('defaults Cerebras hosts to `reasoning` and leaves others alone', () => {
    expect(
      resolveReasoningEchoField(
        'cerebras',
        'qwen-3.8-27b',
        undefined,
        'https://api.cerebras.ai/v1',
      ),
    ).toBe('reasoning');
    expect(resolveReasoningEchoField('deepseek', 'm', undefined, 'https://api.deepseek.com')).toBe(
      undefined,
    );
    expect(resolveReasoningEchoField('x', 'm', undefined, 'not a url')).toBeUndefined();
  });

  it('sees through the WrongProxy rewrite to the upstream host', () => {
    // What `resolveProviderCfgWithProxy` hands the factory when the proxy toggle is on.
    expect(
      resolveReasoningEchoField(
        'cerebras',
        'qwen-3.8-27b',
        undefined,
        'http://localhost:3444/proxy/api.cerebras.ai/v1',
      ),
    ).toBe('reasoning');
    expect(
      resolveReasoningEchoField(
        'd',
        'm',
        undefined,
        'http://localhost:3444/proxy/api.deepseek.com',
      ),
    ).toBeUndefined();
  });

  it('an explicit quirk beats the host default', () => {
    expect(resolveReasoningEchoField('c', 'm', 'omit', 'https://api.cerebras.ai/v1')).toBe('omit');
  });
});

describe('isCompatibilityQuirks reasoningEchoField', () => {
  it('accepts the three field values and nothing else', () => {
    expect(isCompatibilityQuirks({ reasoningEchoField: 'reasoning_content' })).toBe(true);
    expect(isCompatibilityQuirks({ reasoningEchoField: 'reasoning' })).toBe(true);
    expect(isCompatibilityQuirks({ reasoningEchoField: 'omit' })).toBe(true);
    expect(isCompatibilityQuirks({ reasoningEchoField: 'thinking' })).toBe(false);
    expect(isCompatibilityQuirks({ reasoningEchoField: true })).toBe(false);
  });
});

describe('OpenAICompatibleProvider reasoning echo on the wire', () => {
  const req = { model: 'qwen-3.8-27b', messages: HISTORY, maxTokens: 1 };
  const signal = () => new AbortController().signal;

  it('sends `reasoning` to Cerebras on the first request — no failed round trip', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const provider = new OpenAICompatibleProvider({
      id: 'cerebras',
      apiKey: 'k',
      baseUrl: 'https://api.cerebras.ai/v1',
      fetchImpl: strictEndpoint('reasoning', bodies),
    });
    const res = await provider.complete(req, { signal: signal() });
    expect(res.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(bodies).toHaveLength(1);
    expect(assistantOf(bodies[0] ?? {})).toMatchObject({ reasoning: 'let me think' });
  });

  it('learns `reasoning` from the refusal on an unknown strict host and keeps it', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const provider = new OpenAICompatibleProvider({
      id: 'my-proxy',
      apiKey: 'k',
      baseUrl: 'https://proxy.example.test/v1',
      fetchImpl: strictEndpoint('reasoning', bodies),
    });
    const res = await provider.complete(req, { signal: signal() });
    expect(res.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(bodies).toHaveLength(2);
    expect(assistantOf(bodies[0] ?? {})).toHaveProperty('reasoning_content');
    expect(assistantOf(bodies[1] ?? {})).toMatchObject({ reasoning: 'let me think' });
    expect(assistantOf(bodies[1] ?? {})).not.toHaveProperty('reasoning_content');

    await provider.complete(req, { signal: signal() });
    expect(bodies).toHaveLength(3);
    expect(assistantOf(bodies[2] ?? {})).toMatchObject({ reasoning: 'let me think' });
  });

  it('falls through to omitting the echo when the endpoint takes neither field', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const provider = new OpenAICompatibleProvider({
      id: 'strictest',
      apiKey: 'k',
      baseUrl: 'https://strict.example.test/v1',
      fetchImpl: strictEndpoint('none', bodies),
    });
    const res = await provider.complete(req, { signal: signal() });
    expect(res.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(bodies).toHaveLength(3);
    const last = assistantOf(bodies[2] ?? {});
    expect(last).not.toHaveProperty('reasoning');
    expect(last).not.toHaveProperty('reasoning_content');
  });
});
