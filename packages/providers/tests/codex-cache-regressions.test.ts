import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Message, Request } from '@wrongstack/contracts/types';
import { afterEach, expect, it } from 'vitest';
import { OpenAICodexProvider } from '../src/openai-codex.js';
import { codexCacheSessionId } from '../src/openai-codex-request.js';
import {
  recordCacheProbeRequest,
  recordCacheProbeUsage,
  resetCacheProbeState,
} from '../src/prompt-cache-probe.js';
import {
  CODEX_TOOL_ARGUMENTS_META,
  messagesToResponsesInput,
} from '../src/tool-format/to-responses.js';

const originalProbe = process.env['WRONGSTACK_CACHE_PROBE'];
let dir: string | undefined;
afterEach(() => {
  if (originalProbe === undefined) delete process.env['WRONGSTACK_CACHE_PROBE'];
  else process.env['WRONGSTACK_CACHE_PROBE'] = originalProbe;
  resetCacheProbeState();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function probeFile(): string {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cache-regression-'));
  const file = path.join(dir, 'probe.jsonl');
  process.env['WRONGSTACK_CACHE_PROBE'] = file;
  resetCacheProbeState();
  return file;
}
const readLines = (file: string): Array<Record<string, unknown>> =>
  fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

it('includes cache writes in the diagnostic denominator', () => {
  const file = probeFile();
  recordCacheProbeUsage({
    provider: 'openai-codex',
    sessionKey: 'root',
    usage: { input: 100, output: 10, cacheRead: 600, cacheWrite: 300 },
  });
  expect(readLines(file)[0]).toMatchObject({
    promptTokens: 1000,
    actualHitPct: 60,
    cacheWriteTokens: 300,
  });
});

it('isolates model, thread, account, provider and settings while sharing a cache key', () => {
  const file = probeFile();
  const base = {
    provider: 'codex',
    sessionKey: 'root',
    model: 'model-a',
    threadId: 'one',
    accountScope: 'account-a',
    settings: ['low'],
    instructions: 'fixed',
    tools: [],
    items: [],
  };
  recordCacheProbeRequest(base);
  for (const change of [
    { model: 'model-b' },
    { threadId: 'two' },
    { accountScope: 'account-b' },
    { provider: 'other' },
    { settings: ['high'] },
  ])
    recordCacheProbeRequest({ ...base, ...change });
  recordCacheProbeRequest(base);
  const lines = readLines(file);
  expect(lines.slice(0, 6).every((line) => line['first'] === true)).toBe(true);
  expect(lines[6]).toMatchObject({ first: false, matchingPrefixCharsPct: 100 });
  expect(lines[6]).not.toHaveProperty('expectedHitPct');
  expect(fs.readFileSync(file, 'utf8')).not.toContain('account-a');
});

it('pairs concurrent request and usage records by id and the actual wire cache key', async () => {
  const file = probeFile();
  const provider = new OpenAICodexProvider({
    credentials: { accessToken: 'test' },
    fetchImpl: async () =>
      new Response(
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":10,"output_tokens_details":{"reasoning_tokens":6}}}}\n\n',
      ),
  });
  const req: Request = {
    model: 'model-a',
    cache: { key: 'long-prefix-'.repeat(12) },
    messages: [{ role: 'user', content: 'hello' }],
  };
  await Promise.all([
    provider.complete(req, { signal: new AbortController().signal }),
    provider.complete(req, { signal: new AbortController().signal }),
  ]);
  const lines = readLines(file);
  const requests = lines.filter((line) => line['kind'] === 'req');
  const usages = lines.filter((line) => line['kind'] === 'usage');
  expect(requests).toHaveLength(2);
  expect(usages).toHaveLength(2);
  expect(new Set(requests.map((line) => line['requestId'])).size).toBe(2);
  for (const request of requests) {
    expect(request['requestId']).toEqual(expect.any(String));
    expect(usages.find((line) => line['requestId'] === request['requestId'])).toMatchObject({
      session: request['session'],
      model: 'model-a',
      outputTokens: 10,
      reasoningOutputTokens: 6,
    });
    expect(String(request['session']).length).toBeLessThanOrEqual(64);
  }
});

it('preserves server-formatted arguments through complete, persistence and WebSocket continuation', async () => {
  const file = probeFile();
  const raw = '{\n  "path": "src/example.ts",\n  "line": 1e2\n}';
  const sent: Array<Record<string, unknown>> = [];
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
      const item = { type: 'function_call', call_id: 'call_one', name: 'read', arguments: raw };
      if (sent.length === 1) {
        this.emit(
          'message',
          JSON.stringify({ type: 'response.output_item.added', item: { ...item, arguments: '' } }),
        );
        this.emit('message', JSON.stringify({ type: 'response.output_item.done', item }));
      }
      this.emit(
        'message',
        JSON.stringify({
          type: 'response.completed',
          response: {
            id: `resp_${sent.length}`,
            status: 'completed',
            output: sent.length === 1 ? [item] : [],
            usage: {
              input_tokens: 10,
              output_tokens: 10,
              output_tokens_details: { reasoning_tokens: 7 },
            },
          },
        }),
      );
    }
  }
  let socket: Socket | undefined;
  const provider = new OpenAICodexProvider({
    credentials: { accessToken: 'test' },
    webSocket: true,
    fetchImpl: async () => {
      throw new Error('Unexpected HTTP fallback in WebSocket fixture');
    },
    webSocketFactory: () => {
      socket = new Socket();
      return socket;
    },
  });
  const req: Request = {
    model: 'model-a',
    cache: { sessionId: 'test' },
    messages: [{ role: 'user', content: 'read file' }],
  };
  try {
    const first = await provider.complete(req, { signal: new AbortController().signal });
    expect(first.content[0]).toMatchObject({
      type: 'tool_use',
      input: { path: 'src/example.ts', line: 100 },
      providerMeta: { [CODEX_TOOL_ARGUMENTS_META]: raw },
    });
    await provider.complete(
      {
        ...req,
        messages: [
          ...req.messages,
          { role: 'assistant', content: JSON.parse(JSON.stringify(first.content)) },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'call_one', content: 'file contents' }],
          },
        ],
      },
      { signal: new AbortController().signal },
    );
    expect(sent[1]).toMatchObject({
      previous_response_id: 'resp_1',
      input: [{ type: 'function_call_output', call_id: 'call_one', output: 'file contents' }],
    });
    const diagnostics = readLines(file);
    const transport = diagnostics.filter((line) => line['kind'] === 'transport');
    expect(transport.map((line) => [line['mode'], line['reason']])).toEqual([
      ['full', 'no-previous-response'],
      ['delta', 'prefix-match'],
    ]);
    expect(transport[1]?.['sentInputItems']).toBe(1);
    expect(
      diagnostics
        .filter((line) => line['requestId'] === transport[1]?.['requestId'])
        .map((line) => line['kind']),
    ).toEqual(['req', 'transport', 'usage']);
    expect(diagnostics.filter((line) => line['kind'] === 'usage')).toEqual([
      expect.objectContaining({ outputTokens: 10, reasoningOutputTokens: 7 }),
      expect.objectContaining({ outputTokens: 10, reasoningOutputTokens: 7 }),
    ]);
  } finally {
    socket?.close();
  }
});

it('does not invent reasoning usage when the backend omits or malforms the count', async () => {
  const file = probeFile();
  const counts = [0, undefined, -1, '6'];
  let index = 0;
  const provider = new OpenAICodexProvider({
    credentials: { accessToken: 'test' },
    fetchImpl: async () =>
      new Response(
        `data: ${JSON.stringify({
          type: 'response.completed',
          response: {
            usage: {
              input_tokens: 10,
              output_tokens: 10,
              output_tokens_details: { reasoning_tokens: counts[index++] },
            },
          },
        })}\n\n`,
      ),
  });
  for (const _ of counts) {
    const result = await provider.complete(
      { model: 'model-a', messages: [{ role: 'user', content: 'hello' }] },
      { signal: new AbortController().signal },
    );
    expect(result.usage.output).toBe(10);
  }
  const usage = readLines(file).filter((line) => line['kind'] === 'usage');
  expect(usage).toHaveLength(4);
  expect(usage[0]).toHaveProperty('reasoningOutputTokens', 0);
  for (const line of usage.slice(1)) expect(line).not.toHaveProperty('reasoningOutputTokens');
});

it.each(['{"path":"old"}', '{malformed', '[1,2]', 'null'])(
  'never replays stale or invalid raw arguments: %s',
  (raw) => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'call',
            name: 'read',
            input: { path: 'new' },
            providerMeta: { [CODEX_TOOL_ARGUMENTS_META]: raw },
          },
        ],
      },
    ];
    expect(messagesToResponsesInput(messages)[0]?.['arguments']).toBe('{"path":"new"}');
  },
);

it('bounds session cache keys without merging long ids with a shared prefix', () => {
  const one = codexCacheSessionId(`${'a'.repeat(150)}one`);
  const two = codexCacheSessionId(`${'a'.repeat(150)}two`);
  expect(one).not.toBe(two);
  expect(one).toHaveLength(64);
  expect(codexCacheSessionId(`${'a'.repeat(150)}one`)).toBe(one);
});

it.each([true, false, undefined])(
  'uses verbosity and explicit none only with live capability evidence (%s)',
  async (supported) => {
    const bodies: Array<Record<string, unknown>> = [];
    const provider = new OpenAICodexProvider({
      credentials: { accessToken: 'test' },
      fetchImpl: async (url, init) => {
        if (String(url).includes('/codex/models'))
          return Response.json({
            models: [
              {
                slug: 'model-a',
                context_window: 10000,
                support_verbosity: supported,
                supported_reasoning_levels: supported
                  ? [{ effort: 'none' }, { effort: 'medium' }]
                  : [{ effort: 'medium' }],
              },
            ],
          });
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(
          'data: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":1}}}\n\n',
        );
      },
    });
    const signal = new AbortController().signal;
    await provider.refreshContextLimit('model-a', { signal });
    for (const reasoning of [{ enabled: false }, { effort: 'none' as const }]) {
      await provider.complete(
        { model: 'model-a', messages: [{ role: 'user', content: 'hello' }], reasoning },
        { signal },
      );
    }
    for (const [index, body] of bodies.entries()) {
      if (supported)
        expect(body).toMatchObject({ text: { verbosity: 'low' }, reasoning: { effort: 'none' } });
      else {
        expect(body).not.toHaveProperty('text');
        if (index === 0) expect(body).not.toHaveProperty('reasoning');
        else expect(body['reasoning']).toEqual({ effort: 'medium', summary: 'auto' });
      }
    }
  },
);
