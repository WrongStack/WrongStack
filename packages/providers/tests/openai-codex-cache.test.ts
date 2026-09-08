/**
 * Cache-affinity behaviour of the ChatGPT-login (Codex) transport.
 *
 * Cache continuity has two independent mechanisms:
 *
 *  - Stable session/thread/cache metadata routes related prompt prefixes, and
 *    the backend's `x-codex-turn-state` pins the rest of ONE turn to the
 *    machine already holding that conversation's cached prefix. It is replayed
 *    on the turn's tool-call round-trips and must not leak into the next user
 *    turn, or into another session.
 *  - reasoning replay: `include: ['reasoning.encrypted_content']` asks the
 *    backend to hand its reasoning back; replaying it keeps the cached prefix
 *    intact and stops a reasoning model re-deriving (and re-billing) what it
 *    already worked out. A backend that rejects the replay must degrade to the
 *    previous behaviour, not strand the turn.
 */

import type { Message, Request, StreamEvent } from '@wrongstack/core/types';
import { describe, expect, it } from 'vitest';
import type { CodexResponseMetadata } from '../src/openai-codex.js';
import { OpenAICodexProvider } from '../src/openai-codex.js';
import {
  CODEX_REASONING_ENCRYPTED_META,
  CODEX_REASONING_ID_META,
  messagesToResponsesInput,
} from '../src/tool-format/to-responses.js';

function sseBody(events: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    pull(c) {
      c.enqueue(enc.encode(events));
      c.close();
    },
  });
}

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

const DONE = 'data: {"type":"response.completed","response":{}}\n\n';

interface Call {
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function recordingFetch(
  calls: Call[],
  reply: (call: number) => { status?: number; headers?: Record<string, string>; body?: string },
): typeof fetch {
  return (async (_url: string, init: { headers?: Record<string, string>; body?: string }) => {
    const index = calls.length;
    calls.push({
      headers: init.headers ?? {},
      body: JSON.parse(init.body ?? '{}') as Record<string, unknown>,
    });
    const res = reply(index);
    const status = res.status ?? 200;
    return new Response(
      status >= 200 && status < 300 ? sseBody(res.body ?? DONE) : (res.body ?? 'err'),
      {
        status,
        headers: { 'content-type': 'text/event-stream', ...res.headers },
      },
    );
  }) as never as typeof fetch;
}

function request(sessionId: string): Request {
  return {
    model: 'gpt-5-codex',
    messages: [{ role: 'user', content: 'hi' }],
    cache: { sessionId },
  };
}

describe('response.metadata cache affinity', () => {
  it('does not replay metadata turn state into the NEXT USER turn', async () => {
    const calls: Call[] = [];
    const metadataEvent =
      'data: {"type":"response.metadata","metadata":{"headers":{"x-codex-turn-state":"state-meta"}}}\n\n';
    const provider = new OpenAICodexProvider({
      credentials: { accessToken: 'tok' },
      fetchImpl: recordingFetch(calls, (i) => (i === 0 ? { body: metadataEvent + DONE } : {})),
    });
    const signal = new AbortController().signal;
    await collect(provider.stream(request('sess-meta'), { signal }));
    await collect(provider.stream(request('sess-meta'), { signal }));
    expect(calls[1]?.headers['x-codex-turn-state']).toBeUndefined();
    expect(calls[1]?.headers['x-client-request-id']).toBe(calls[0]?.headers['x-client-request-id']);
    expect(calls[1]?.headers['thread-id']).toBe(calls[0]?.headers['thread-id']);
  });

  it('surfaces response metadata to the host observer', async () => {
    const calls: Call[] = [];
    const observed: unknown[] = [];
    const provider = new OpenAICodexProvider({
      credentials: { accessToken: 'tok' },
      onResponseMetadata: (metadata) => observed.push(metadata),
      fetchImpl: recordingFetch(calls, () => ({
        body:
          'data: {"type":"response.metadata","metadata":{"headers":{"x-models-etag":"etag-meta"},"request_id":"req-meta"}}\n\n' +
          DONE,
      })),
    });
    await collect(
      provider.stream(request('sess-observe'), { signal: new AbortController().signal }),
    );
    expect(observed).toEqual([
      {
        headers: { 'x-models-etag': 'etag-meta' },
        requestId: 'req-meta',
      },
    ]);
  });
});

/**
 * A tool-call round-trip: the assistant called a tool and the caller is
 * handing back its result. Same turn as the user message that started it.
 */
function continuation(sessionId: string): Request {
  return {
    model: 'gpt-5-codex',
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'ls', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'ok' }] },
    ],
    cache: { sessionId },
  };
}

describe('x-codex-turn-state', () => {
  it('replays the routing token onto the rest of the same turn', async () => {
    // The tool-call round-trips share the longest prefix in the whole session,
    // so they are exactly the requests a re-rolled route costs the most.
    const calls: Call[] = [];
    const provider = new OpenAICodexProvider({
      credentials: { accessToken: 'tok' },
      fetchImpl: recordingFetch(calls, (i) =>
        i === 0 ? { headers: { 'x-codex-turn-state': 'state-abc' } } : {},
      ),
    });
    const signal = new AbortController().signal;
    await collect(provider.stream(request('sess-1'), { signal }));
    await collect(provider.stream(continuation('sess-1'), { signal }));
    expect(calls[0]?.headers['x-codex-turn-state']).toBeUndefined();
    expect(calls[1]?.headers['x-codex-turn-state']).toBe('state-abc');
  });

  it('expires the token when a new user turn begins', async () => {
    const calls: Call[] = [];
    const provider = new OpenAICodexProvider({
      credentials: { accessToken: 'tok' },
      fetchImpl: recordingFetch(calls, (i) =>
        i === 0 ? { headers: { 'x-codex-turn-state': 'state-abc' } } : {},
      ),
    });
    const signal = new AbortController().signal;
    await collect(provider.stream(request('sess-1'), { signal }));
    await collect(provider.stream(request('sess-1'), { signal }));
    // A fresh user turn must not carry the previous turn's token…
    expect(calls[1]?.headers['x-codex-turn-state']).toBeUndefined();
    // …and must have dropped it, so a later continuation cannot resurrect it.
    await collect(provider.stream(continuation('sess-1'), { signal }));
    expect(calls[2]?.headers['x-codex-turn-state']).toBeUndefined();
  });

  it('never leaks one session’s routing token into another', async () => {
    const calls: Call[] = [];
    const provider = new OpenAICodexProvider({
      credentials: { accessToken: 'tok' },
      fetchImpl: recordingFetch(calls, (i) =>
        i === 0 ? { headers: { 'x-codex-turn-state': 'state-abc' } } : {},
      ),
    });
    const signal = new AbortController().signal;
    await collect(provider.stream(request('sess-1'), { signal }));
    await collect(provider.stream(continuation('sess-2'), { signal }));
    expect(calls[1]?.headers['x-codex-turn-state']).toBeUndefined();
  });

  it('is carried by the metadata frame when there are no response headers', async () => {
    // The WebSocket transport has no HTTP headers after the handshake, so
    // `response.metadata` is the only delivery of the token for every turn
    // after the first.
    const calls: Call[] = [];
    const metadataEvent =
      'data: {"type":"response.metadata","metadata":{"headers":{"x-codex-turn-state":"state-meta"}}}\n\n';
    const provider = new OpenAICodexProvider({
      credentials: { accessToken: 'tok' },
      fetchImpl: recordingFetch(calls, (i) => (i === 0 ? { body: metadataEvent + DONE } : {})),
    });
    const signal = new AbortController().signal;
    await collect(provider.stream(request('sess-meta'), { signal }));
    await collect(provider.stream(continuation('sess-meta'), { signal }));
    expect(calls[1]?.headers['x-codex-turn-state']).toBe('state-meta');
  });
});

describe('prompt_cache_key', () => {
  it('keys the cache partition on the conversation, not the shared prompt prefix', async () => {
    // The official client sends the session id. Within a conversation the
    // shared prefix is the whole growing history; a system-prompt hash instead
    // groups every concurrent session of the same agent onto one partition,
    // where they evict each other over a prefix worth only the system prompt.
    const calls: Call[] = [];
    const provider = new OpenAICodexProvider({
      credentials: { accessToken: 'tok' },
      fetchImpl: recordingFetch(calls, () => ({})),
    });
    const signal = new AbortController().signal;
    await collect(
      provider.stream(
        { ...request('sess-cache'), cache: { sessionId: 'sess-cache', key: 'ws-prefix-hash' } },
        { signal },
      ),
    );
    expect(calls[0]?.body['prompt_cache_key']).toBe('sess-cache');
    expect(calls[0]?.headers['session-id']).toBe('sess-cache');
  });

  it('falls back to the prefix key for a request with no conversation', async () => {
    const calls: Call[] = [];
    const provider = new OpenAICodexProvider({
      credentials: { accessToken: 'tok' },
      fetchImpl: recordingFetch(calls, () => ({})),
    });
    await collect(
      provider.stream(
        {
          model: 'gpt-5-codex',
          messages: [{ role: 'user', content: 'hi' }],
          cache: { key: 'ws-prefix-hash' },
        },
        { signal: new AbortController().signal },
      ),
    );
    expect(calls[0]?.body['prompt_cache_key']).toBe('ws-prefix-hash');
  });
});

describe('response-metadata dialects', () => {
  // Verified against the live ChatGPT WebSocket: the frame is named
  // `codex.response.metadata` and carries its headers at the TOP level, not
  // under a `metadata` envelope. After the handshake a WebSocket has no HTTP
  // response headers, so this frame is the only delivery of the turn state and
  // the catalog etag for every turn of a WebSocket session.
  const WS_DIALECT =
    'data: {"type":"codex.response.metadata","headers":{"x-codex-turn-state":"state-ws","x-models-etag":"etag-ws"}}\n\n';
  const ENVELOPE_DIALECT =
    'data: {"type":"response.metadata","metadata":{"headers":{"x-codex-turn-state":"state-env"}}}\n\n';

  it('reads the live top-level shape the WebSocket actually sends', async () => {
    const observed: CodexResponseMetadata[] = [];
    const provider = new OpenAICodexProvider({
      credentials: { accessToken: 'tok' },
      onResponseMetadata: (metadata) => observed.push(metadata),
      fetchImpl: recordingFetch([], () => ({ body: WS_DIALECT + DONE })),
    });
    await collect(provider.stream(request('sess-ws'), { signal: new AbortController().signal }));
    expect(observed[0]?.headers).toEqual({
      'x-codex-turn-state': 'state-ws',
      'x-models-etag': 'etag-ws',
    });
  });

  it('still reads the enveloped shape', async () => {
    const observed: CodexResponseMetadata[] = [];
    const provider = new OpenAICodexProvider({
      credentials: { accessToken: 'tok' },
      onResponseMetadata: (metadata) => observed.push(metadata),
      fetchImpl: recordingFetch([], () => ({ body: ENVELOPE_DIALECT + DONE })),
    });
    await collect(provider.stream(request('sess-env'), { signal: new AbortController().signal }));
    expect(observed[0]?.headers).toEqual({ 'x-codex-turn-state': 'state-env' });
  });

  it('replays turn state captured from the live WebSocket frame', async () => {
    const calls: Call[] = [];
    const provider = new OpenAICodexProvider({
      credentials: { accessToken: 'tok' },
      fetchImpl: recordingFetch(calls, (i) => (i === 0 ? { body: WS_DIALECT + DONE } : {})),
    });
    const signal = new AbortController().signal;
    await collect(provider.stream(request('sess-ws2'), { signal }));
    await collect(provider.stream(continuation('sess-ws2'), { signal }));
    expect(calls[1]?.headers['x-codex-turn-state']).toBe('state-ws');
  });

  it('ignores a metadata frame that carries no headers at all', async () => {
    const observed: CodexResponseMetadata[] = [];
    const provider = new OpenAICodexProvider({
      credentials: { accessToken: 'tok' },
      onResponseMetadata: (metadata) => observed.push(metadata),
      fetchImpl: recordingFetch([], () => ({
        body: 'data: {"type":"codex.response.metadata"}\n\n' + DONE,
      })),
    });
    await collect(provider.stream(request('sess-bare'), { signal: new AbortController().signal }));
    expect(observed).toEqual([]);
  });
});

describe('reasoning replay', () => {
  const withReasoning: Message[] = [
    { role: 'user', content: 'why?' },
    {
      role: 'assistant',
      content: [
        {
          type: 'thinking',
          thinking: 'because',
          providerMeta: {
            [CODEX_REASONING_ID_META]: 'rs_1',
            [CODEX_REASONING_ENCRYPTED_META]: 'ENCRYPTED',
          },
        },
        { type: 'text', text: 'Because.' },
      ],
    },
  ];

  it('emits the reasoning item before the message it produced', () => {
    const input = messagesToResponsesInput(withReasoning, { includeReasoning: true });
    expect(input[1]).toEqual({
      type: 'reasoning',
      id: 'rs_1',
      encrypted_content: 'ENCRYPTED',
      summary: [],
    });
    expect(input[2]).toMatchObject({ type: 'message', role: 'assistant' });
  });

  it('stays off unless the caller opts in', () => {
    const input = messagesToResponsesInput(withReasoning);
    expect(input.some((item) => item['type'] === 'reasoning')).toBe(false);
  });

  it('drops a reasoning item with no encrypted payload to replay', () => {
    const input = messagesToResponsesInput(
      [
        {
          role: 'assistant',
          content: [
            {
              type: 'thinking',
              thinking: 'x',
              providerMeta: { [CODEX_REASONING_ID_META]: 'rs_1' },
            },
            { type: 'text', text: 'y' },
          ],
        },
      ],
      { includeReasoning: true },
    );
    expect(input.some((item) => item['type'] === 'reasoning')).toBe(false);
  });

  it('drops reasoning that has no following item, which the API rejects', () => {
    const input = messagesToResponsesInput(
      [
        {
          role: 'assistant',
          content: [
            {
              type: 'thinking',
              thinking: 'x',
              providerMeta: {
                [CODEX_REASONING_ID_META]: 'rs_1',
                [CODEX_REASONING_ENCRYPTED_META]: 'ENCRYPTED',
              },
            },
          ],
        },
      ],
      { includeReasoning: true },
    );
    expect(input).toEqual([]);
  });

  it('captures the item id and encrypted payload off the wire', async () => {
    const calls: Call[] = [];
    const provider = new OpenAICodexProvider({
      credentials: { accessToken: 'tok' },
      fetchImpl: recordingFetch(calls, () => ({
        body:
          'data: {"type":"response.output_item.added","item":{"type":"reasoning","id":"rs_9"}}\n\n' +
          'data: {"type":"response.reasoning_text.delta","delta":"hmm"}\n\n' +
          'data: {"type":"response.output_item.done","item":{"type":"reasoning","id":"rs_9","encrypted_content":"BLOB"}}\n\n' +
          DONE,
      })),
    });
    const events = await collect(
      provider.stream(request('sess-r'), { signal: new AbortController().signal }),
    );
    expect(events).toContainEqual({
      type: 'thinking_start',
      providerMeta: { [CODEX_REASONING_ID_META]: 'rs_9' },
    });
    expect(events).toContainEqual({
      type: 'thinking_meta',
      providerMeta: {
        [CODEX_REASONING_ID_META]: 'rs_9',
        [CODEX_REASONING_ENCRYPTED_META]: 'BLOB',
      },
    });
  });

  it('retries without replay when the backend rejects a reasoning item', async () => {
    const calls: Call[] = [];
    const provider = new OpenAICodexProvider({
      credentials: { accessToken: 'tok' },
      fetchImpl: recordingFetch(calls, (i) =>
        i === 0
          ? {
              status: 400,
              body: JSON.stringify({
                error: {
                  message:
                    "Item 'rs_1' of type 'reasoning' was provided without its required following item.",
                },
              }),
            }
          : {},
      ),
    });
    const req: Request = {
      model: 'gpt-5-codex',
      messages: withReasoning,
      cache: { sessionId: 'sess-fallback' },
    };
    await collect(provider.stream(req, { signal: new AbortController().signal }));
    const first = calls[0]?.body['input'] as Array<Record<string, unknown>>;
    const second = calls[1]?.body['input'] as Array<Record<string, unknown>>;
    expect(first.some((item) => item['type'] === 'reasoning')).toBe(true);
    expect(second.some((item) => item['type'] === 'reasoning')).toBe(false);
  });

  it('does not swallow an unrelated 400', async () => {
    const calls: Call[] = [];
    const provider = new OpenAICodexProvider({
      credentials: { accessToken: 'tok' },
      fetchImpl: recordingFetch(calls, () => ({
        status: 400,
        body: JSON.stringify({ error: { message: 'Invalid tool schema for "grep".' } }),
      })),
    });
    await expect(
      collect(provider.stream(request('sess-bad'), { signal: new AbortController().signal })),
    ).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
});
