/**
 * Thinking-block provenance on the Anthropic wire: blocks are stamped with the
 * service that signed them, other services' blocks never reach a signer that
 * would reject them, and a signature rejection is repaired once.
 */

import type { ContentBlock, Message, Request } from '@wrongstack/contracts/types';
import { describe, expect, it, vi } from 'vitest';
import { AnthropicProvider } from '../src/anthropic.js';

/** The stamp's `providerMeta` key — persisted in session journals, so pinned here. */
const THINKING_SIGNER_META = 'thinkingSigner';

const ANTHROPIC = 'https://api.anthropic.com';
const ZAI = 'https://api.z.ai/api/anthropic';

function sse(events: Array<Record<string, unknown>>): Response {
  const body = events.map((e) => `event: ${e['type']}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** A turn that thinks (with a signature) and answers. */
function thinkingTurn(signature: string): Response {
  return sse([
    {
      type: 'message_start',
      message: { model: 'm', usage: { input_tokens: 5, output_tokens: 0 } },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'ok' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
    { type: 'message_stop' },
  ]);
}

function signatureRejection(): Response {
  return new Response(
    JSON.stringify({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: 'messages.1.content.0: Invalid `signature` in `thinking` block',
      },
    }),
    { status: 400, headers: { 'content-type': 'application/json' } },
  );
}

function capture(responses: Array<() => Response>): {
  fetchImpl: typeof fetch;
  bodies: Array<Record<string, unknown>>;
} {
  const bodies: Array<Record<string, unknown>> = [];
  let i = 0;
  const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const respond = responses[Math.min(i++, responses.length - 1)];
    return respond ? respond() : thinkingTurn('sig');
  }) as never as typeof fetch;
  return { fetchImpl, bodies };
}

function provider(baseUrl: string, fetchImpl: typeof fetch): AnthropicProvider {
  return new AnthropicProvider({ id: 'p', apiKey: 'k', baseUrl, fetchImpl });
}

function thinking(signer: string | undefined, signature: string | undefined): ContentBlock {
  return {
    type: 'thinking',
    thinking: `thought by ${signer ?? 'nobody'}`,
    ...(signature !== undefined ? { signature } : {}),
    ...(signer !== undefined ? { providerMeta: { [THINKING_SIGNER_META]: signer } } : {}),
  } as ContentBlock;
}

function history(assistant: ContentBlock[], extra: Message[] = []): Message[] {
  return [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: assistant },
    { role: 'user', content: 'next' },
    ...extra,
  ];
}

function request(messages: Message[], extra: Partial<Request> = {}): Request {
  return { model: 'claude-x', messages, maxTokens: 4096, ...extra };
}

/** The thinking blocks (and text) of the first assistant message sent. */
function sentAssistant(body: Record<string, unknown>): Array<Record<string, unknown>> {
  const messages = body['messages'] as Array<{ role: string; content: unknown }>;
  const assistant = messages.find((m) => m.role === 'assistant');
  return (assistant?.content ?? []) as Array<Record<string, unknown>>;
}

describe('stamping', () => {
  it('records the signer on the thinking block, per endpoint', async () => {
    const cases: Array<[string, string]> = [
      [ANTHROPIC, 'anthropic'],
      [ZAI, 'api.z.ai'],
      ['http://localhost:3444/proxy/api.anthropic.com', 'anthropic'],
    ];
    for (const [baseUrl, signer] of cases) {
      const { fetchImpl } = capture([() => thinkingTurn('sig-1')]);
      const res = await provider(baseUrl, fetchImpl).complete(
        request([{ role: 'user', content: 'hi' }]),
        {
          signal: new AbortController().signal,
        },
      );
      const block = res.content.find((b) => b.type === 'thinking') as
        | { signature?: string; providerMeta?: Record<string, unknown> }
        | undefined;
      expect(block?.signature, baseUrl).toBe('sig-1');
      expect(block?.providerMeta?.[THINKING_SIGNER_META], baseUrl).toBe(signer);
    }
  });

  it('never sends the stamp back on the wire', async () => {
    const { fetchImpl, bodies } = capture([() => thinkingTurn('s')]);
    await provider(ANTHROPIC, fetchImpl).complete(
      request(history([thinking('anthropic', 'claude-sig'), { type: 'text', text: 'a' }])),
      { signal: new AbortController().signal },
    );
    expect(sentAssistant(bodies[0]!)[0]).toEqual({
      type: 'thinking',
      thinking: 'thought by anthropic',
      signature: 'claude-sig',
    });
  });
});

describe('filtering before the request', () => {
  it('sends Anthropic only its own signed blocks and legacy unstamped signed ones', async () => {
    const { fetchImpl, bodies } = capture([() => thinkingTurn('s')]);
    await provider(ANTHROPIC, fetchImpl).complete(
      request(
        history([
          thinking('api.z.ai', '286fa7044072491b9771ed15'),
          thinking(undefined, undefined), // reasoning_content from a Chat Completions provider
          thinking('anthropic', 'claude-sig'),
          thinking(undefined, 'legacy-sig'),
          { type: 'text', text: 'answer' },
        ]),
      ),
      { signal: new AbortController().signal },
    );
    expect(sentAssistant(bodies[0]!).map((b) => b['signature'] ?? b['type'])).toEqual([
      'claude-sig',
      'legacy-sig',
      'text',
    ]);
  });

  it('keeps a turn non-empty when its only content was foreign reasoning', async () => {
    const { fetchImpl, bodies } = capture([() => thinkingTurn('s')]);
    await provider(ANTHROPIC, fetchImpl).complete(
      request(history([thinking('api.minimax.io', 'mm-sig')])),
      { signal: new AbortController().signal },
    );
    expect(sentAssistant(bodies[0]!)).toEqual([{ type: 'text', text: '[Thinking removed]' }]);
  });

  it('a tolerant signer drops other signers but keeps unsigned reasoning', async () => {
    const { fetchImpl, bodies } = capture([() => thinkingTurn('s')]);
    await provider(ZAI, fetchImpl).complete(
      request(
        history([
          thinking('anthropic', 'claude-sig'),
          thinking(undefined, undefined),
          thinking('api.z.ai', 'zai-sig'),
          { type: 'text', text: 'answer' },
        ]),
        { model: 'glm-5.3' },
      ),
      { signal: new AbortController().signal },
    );
    expect(sentAssistant(bodies[0]!).map((b) => b['signature'] ?? b['type'])).toEqual([
      'thinking',
      'zai-sig',
      'text',
    ]);
  });

  it('leaves a clean history untouched', async () => {
    const { fetchImpl, bodies } = capture([() => thinkingTurn('s')]);
    const req = request(history([thinking('anthropic', 'c'), { type: 'text', text: 'a' }]), {
      reasoning: { effort: 'high' },
    });
    await provider(ANTHROPIC, fetchImpl).complete(req, { signal: new AbortController().signal });
    expect(sentAssistant(bodies[0]!)).toHaveLength(2);
    expect((bodies[0]!['thinking'] as { type: string }).type).toBe('enabled');
  });

  it('sends a tool continuation that lost its foreign thinking with thinking off', async () => {
    const messages: Message[] = [
      { role: 'user', content: 'read the file' },
      {
        role: 'assistant',
        content: [
          thinking('api.z.ai', 'zai-sig'),
          { type: 'tool_use', id: 't1', name: 'read', input: { path: 'a' } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'data' }] },
    ];
    const { fetchImpl, bodies } = capture([() => thinkingTurn('s')]);
    await provider(ANTHROPIC, fetchImpl).complete(
      request(messages, { reasoning: { effort: 'high' } }),
      {
        signal: new AbortController().signal,
      },
    );
    // Anthropic requires that turn to open with a thinking block; none valid exists.
    expect(bodies[0]!['thinking']).toEqual({ type: 'disabled' });
    expect(sentAssistant(bodies[0]!).map((b) => b['type'])).toEqual(['tool_use']);
  });
});

describe('repair on rejection', () => {
  it('retries once without signed blocks when a signature is refused', async () => {
    const { fetchImpl, bodies } = capture([signatureRejection, () => thinkingTurn('fresh')]);
    const res = await provider(ANTHROPIC, fetchImpl).complete(
      request(history([thinking(undefined, 'unknown-origin-sig'), { type: 'text', text: 'a' }])),
      { signal: new AbortController().signal },
    );
    expect(bodies).toHaveLength(2);
    expect(sentAssistant(bodies[0]!).map((b) => b['type'])).toEqual(['thinking', 'text']);
    expect(sentAssistant(bodies[1]!).map((b) => b['type'])).toEqual(['text']);
    expect(res.content.some((b) => b.type === 'text')).toBe(true);
  });

  it('does not retry an unrelated 400', async () => {
    const { fetchImpl, bodies } = capture([
      () =>
        new Response(
          JSON.stringify({
            type: 'error',
            error: { type: 'invalid_request_error', message: 'bad' },
          }),
          { status: 400 },
        ),
    ]);
    await expect(
      provider(ANTHROPIC, fetchImpl).complete(
        request(history([thinking(undefined, 'sig'), { type: 'text', text: 'a' }])),
        { signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(bodies).toHaveLength(1);
  });

  it('gives up after one repair', async () => {
    const { fetchImpl, bodies } = capture([signatureRejection, signatureRejection]);
    await expect(
      provider(ANTHROPIC, fetchImpl).complete(
        request(history([thinking(undefined, 'sig'), { type: 'text', text: 'a' }])),
        { signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(bodies).toHaveLength(2);
  });
});
