import { EventEmitter } from 'node:events';
import type { Message, Request, Tool } from '@wrongstack/contracts/types';
import { describe, expect, it } from 'vitest';
import { OpenAICodexProvider } from '../src/openai-codex.js';
import { codexCacheSessionId } from '../src/openai-codex-request.js';
import { OpenAIResponsesProvider } from '../src/openai-responses.js';
import { responsesReasoningSummary } from '../src/responses-reasoning-summary.js';
import { messagesToResponsesInput, toolsToResponses } from '../src/tool-format/to-responses.js';

const signal = () => new AbortController().signal;
const summary = [
  { type: 'summary_text', text: 'Inspected the source.' },
  { type: 'summary_text', text: 'Now read the relevant file.' },
];
const reasoning = { type: 'reasoning', id: 'rs_one', encrypted_content: 'opaque', summary };
const toolCall = { type: 'function_call', call_id: 'call_one', name: 'read', arguments: '{}' };
const request = (sessionId = 'root'): Request => ({
  model: 'account-model',
  messages: [{ role: 'user', content: 'inspect' }],
  cache: { sessionId },
});
const firstEvents = () => [
  { type: 'response.output_item.added', item: reasoning },
  { type: 'response.reasoning_summary_text.delta', delta: 'Inspected the source.' },
  { type: 'response.output_item.done', item: reasoning },
  { type: 'response.output_item.added', item: toolCall },
  { type: 'response.output_item.done', item: toolCall },
];
const completed = (id = 'resp_one', output: unknown[] = []) => ({
  type: 'response.completed',
  response: { id, status: 'completed', output, usage: { input_tokens: 100, output_tokens: 10 } },
});
const sse = (events: unknown[]) =>
  new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''));

function continueRequest(req: Request, content: Message['content']): Request {
  return {
    ...req,
    messages: [
      ...req.messages,
      { role: 'assistant', content: JSON.parse(JSON.stringify(content)) },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call_one', content: 'file' }],
      },
    ],
  };
}

describe('complete reasoning summary replay', () => {
  it.each(['openai-codex', 'openai-chatgpt'])(
    'preserves persisted server summary parts on %s',
    async (route) => {
      const bodies: Record<string, unknown>[] = [];
      const fetchImpl: typeof fetch = async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return sse([...(bodies.length === 1 ? firstEvents() : []), completed()]);
      };
      const provider =
        route === 'openai-codex'
          ? new OpenAICodexProvider({ credentials: { accessToken: 'fixture' }, fetchImpl })
          : new OpenAIResponsesProvider({
              id: route,
              apiKey: 'fixture',
              baseUrl: 'https://api.openai.com/v1',
              store: false,
              replayReasoning: true,
              chatGPTPlan: true,
              fetchImpl,
            });
      const req = request();
      const response = await provider.complete(req, { signal: signal() });
      const persisted = JSON.parse(JSON.stringify(response.content));
      // Display prose is independent of the exact server replay metadata.
      persisted[0].thinking = 'Different display text';
      await provider.complete(continueRequest(req, persisted), { signal: signal() });
      const replay = (bodies[1]!['input'] as Record<string, unknown>[]).find(
        (item) => item['type'] === 'reasoning',
      );
      expect(replay).toEqual(reasoning);
    },
  );

  it('retains exact-prefix WebSocket continuation with nonempty summaries', async () => {
    const sent: Record<string, unknown>[] = [];
    const sockets: Socket[] = [];
    class Socket extends EventEmitter {
      readyState = 0;
      constructor() {
        super();
        queueMicrotask(() => {
          this.readyState = 1;
          this.emit('open');
        });
      }
      close() {
        this.readyState = 3;
        this.emit('close');
      }
      send(data: string) {
        sent.push(JSON.parse(data));
        for (const event of sent.length === 1 ? firstEvents() : [])
          this.emit('message', JSON.stringify(event));
        this.emit(
          'message',
          JSON.stringify(
            completed(`resp_${sent.length}`, sent.length === 1 ? [reasoning, toolCall] : []),
          ),
        );
      }
    }
    const provider = new OpenAICodexProvider({
      credentials: { accessToken: 'fixture' },
      webSocket: true,
      fetchImpl: async () => {
        throw new Error('Unexpected HTTP fallback');
      },
      webSocketFactory: () => {
        const socket = new Socket();
        sockets.push(socket);
        return socket;
      },
    });
    try {
      const req = request();
      const response = await provider.complete(req, { signal: signal() });
      const next = continueRequest(req, response.content);
      expect(messagesToResponsesInput(next.messages, { includeReasoning: true })).toContainEqual(
        reasoning,
      );
      await provider.complete(next, { signal: signal() });
      expect(sent[1]).toMatchObject({ previous_response_id: 'resp_1' });
      expect(sent[1]!['input']).toEqual([
        { type: 'function_call_output', call_id: 'call_one', output: 'file' },
      ]);
    } finally {
      for (const socket of sockets) socket.close();
    }
  });

  it('preserves legacy summary-free metadata and drops incomplete pairs', () => {
    const content: Message['content'] = [
      {
        type: 'thinking',
        thinking: 'display only',
        providerMeta: { codexReasoningId: 'rs_old', codexReasoningEncrypted: 'old-opaque' },
      },
      { type: 'text', text: 'answer' },
      {
        type: 'thinking',
        thinking: 'unfinished',
        providerMeta: {
          codexReasoningId: 'rs_partial',
          codexReasoningEncrypted: 'partial',
          codexReasoningSummary: summary,
        },
      },
    ];
    const input = messagesToResponsesInput([{ role: 'assistant', content }], {
      includeReasoning: true,
    });
    expect(input.filter((item) => item['type'] === 'reasoning')).toEqual([
      { type: 'reasoning', id: 'rs_old', encrypted_content: 'old-opaque', summary: [] },
    ]);
    expect(messagesToResponsesInput([{ role: 'assistant', content }])).not.toContainEqual(
      reasoning,
    );
  });

  it.each([
    undefined,
    null,
    'summary',
    [{ type: 'summary_text', text: 1 }],
    [{ type: 'unknown', text: 'x' }],
  ])('ignores malformed summary metadata: %j', (value) => {
    expect(responsesReasoningSummary(value)).toEqual([]);
  });

  it('copies valid summaries so changing an emitted request cannot mutate stored metadata', () => {
    const original = JSON.parse(JSON.stringify(summary));
    const replay = responsesReasoningSummary(original);
    replay[0]!.text = 'changed outgoing copy';
    expect(original).toEqual(summary);
    expect(responsesReasoningSummary(original)).toEqual(summary);
  });
});

describe('opaque session identity isolation', () => {
  it('keeps safe IDs and hashes unsafe or overlong original values deterministically', () => {
    expect(codexCacheSessionId('root-._1')).toBe('root-._1');
    expect(codexCacheSessionId('a'.repeat(64))).toBe('a'.repeat(64));
    expect(codexCacheSessionId('')).toBeUndefined();
    expect(codexCacheSessionId(undefined)).toBeUndefined();
    const ids = [
      'session/a',
      'session?a',
      'session:a',
      'session_a',
      'session\r\na',
      'session a',
      'session😀a',
      'a'.repeat(65),
    ];
    const keys = ids.map(codexCacheSessionId);
    expect(new Set(keys).size).toBe(ids.length);
    for (const [index, key] of keys.entries()) {
      expect(key).toMatch(/^[A-Za-z0-9._-]{1,64}$/);
      expect(codexCacheSessionId(ids[index])).toBe(key);
    }
  });

  it.each(['openai-codex', 'openai-chatgpt'])(
    'isolates colliding opaque identities in %s headers and keys',
    async (route) => {
      const calls: Array<{ headers: Headers; body: Record<string, unknown> }> = [];
      const fetchImpl: typeof fetch = async (_url, init) => {
        calls.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
        return new Response(`data: ${JSON.stringify(completed())}\n\n`, {
          headers: { 'x-codex-turn-state': calls.length === 1 ? 'state-a' : 'state-b' },
        });
      };
      const provider =
        route === 'openai-codex'
          ? new OpenAICodexProvider({ credentials: { accessToken: 'fixture' }, fetchImpl })
          : new OpenAIResponsesProvider({
              id: route,
              apiKey: 'fixture',
              baseUrl: 'https://api.openai.com/v1',
              chatGPTPlan: true,
              store: false,
              fetchImpl,
            });
      await provider.complete(request('session/a'), { signal: signal() });
      const continuation = (sessionId: string): Request => ({
        ...request(sessionId),
        messages: [
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'call_one', content: 'result' }],
          },
        ],
      });
      await provider.complete(continuation('session?a'), { signal: signal() });
      await provider.complete(continuation('session/a'), { signal: signal() });
      expect(calls[0]!.body['prompt_cache_key']).not.toBe(calls[1]!.body['prompt_cache_key']);
      expect(calls[0]!.headers.get('thread-id')).not.toBe(calls[1]!.headers.get('thread-id'));
      expect(calls[0]!.headers.get('session-id')).toBe(calls[2]!.headers.get('session-id'));
      expect(calls[1]!.headers.get('x-codex-turn-state')).toBeNull();
      if (route === 'openai-codex')
        expect(calls[2]!.headers.get('x-codex-turn-state')).toBe('state-a');
    },
  );

  it('opens separate WebSocket connections for formerly colliding thread identities', async () => {
    const sockets: Socket[] = [];
    class Socket extends EventEmitter {
      readyState = 0;
      constructor() {
        super();
        queueMicrotask(() => {
          this.readyState = 1;
          this.emit('open');
        });
      }
      close() {
        this.readyState = 3;
        this.emit('close');
      }
      send() {
        this.emit('message', JSON.stringify(completed()));
      }
    }
    const provider = new OpenAICodexProvider({
      credentials: { accessToken: 'fixture' },
      webSocket: true,
      fetchImpl: async () => {
        throw new Error('Unexpected HTTP fallback');
      },
      webSocketFactory: () => {
        const socket = new Socket();
        sockets.push(socket);
        return socket;
      },
    });
    try {
      for (const sessionId of ['session/a', 'session?a'])
        await provider.complete(request(sessionId), { signal: signal() });
      expect(sockets).toHaveLength(2);
    } finally {
      for (const socket of sockets) socket.close();
    }
  });
});

describe('mutable Responses tool declarations', () => {
  const tool = (name: string): Tool => ({
    name,
    description: name,
    inputSchema: { type: 'object' },
    permission: 'auto',
    mutating: false,
    execute: async () => '',
  });
  it('tracks list addition, removal, replacement and empty lists while retaining stable memo hits', () => {
    const tools = [tool('one')];
    const initial = toolsToResponses(tools);
    expect(toolsToResponses(tools)).toBe(initial);
    tools.push(tool('two'));
    expect(toolsToResponses(tools).map((t) => t.name)).toEqual(['one', 'two']);
    tools.splice(0, 1);
    expect(toolsToResponses(tools).map((t) => t.name)).toEqual(['two']);
    tools[0] = tool('replacement');
    expect(toolsToResponses(tools).map((t) => t.name)).toEqual(['replacement']);
    tools.length = 0;
    expect(toolsToResponses(tools)).toEqual([]);
  });

  it('tracks in-place name, description and nested schema updates', () => {
    const schema = { type: 'object', properties: { path: { type: 'string', enum: ['old'] } } };
    const definition = { ...tool('read'), inputSchema: schema };
    const tools = [definition];
    const before = toolsToResponses(tools);
    definition.name = 'read_new';
    definition.description = 'new description';
    schema.properties.path.enum[0] = 'new';
    const after = toolsToResponses(tools);
    expect(after).not.toBe(before);
    expect(after[0]).toMatchObject({
      name: 'read_new',
      description: 'new description',
      parameters: schema,
    });
    expect(before[0]!.name).toBe('read');
    expect(before[0]!.parameters).not.toEqual(schema);
    expect(toolsToResponses(tools)).toBe(after);
  });

  it('ignores execution-only mutations and preserves sorted wire order', () => {
    const tools = [tool('z'), tool('a')];
    const before = toolsToResponses(tools);
    tools[0]!.execute = async () => 'updated handler';
    tools[0]!.mutating = true;
    expect(toolsToResponses(tools)).toBe(before);
    tools.reverse();
    expect(toolsToResponses(tools)).toEqual(before);
    expect(toolsToResponses(tools).map((t) => t.name)).toEqual(['a', 'z']);
  });
});
