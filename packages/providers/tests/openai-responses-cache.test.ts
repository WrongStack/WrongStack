import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { markVolatileSystemBlock, type Request } from '@wrongstack/contracts/types';
import { afterEach, describe, expect, it } from 'vitest';
import { OpenAIResponsesProvider } from '../src/openai-responses.js';
import { resetCacheProbeState } from '../src/prompt-cache-probe.js';
import { SubscriptionOAuthProvider } from '../src/subscription-oauth.js';

const signal = () => new AbortController().signal;
const request = (): Request => ({
  model: 'account-model',
  system: [{ type: 'text', text: 'stable instructions' }],
  messages: [{ role: 'user', content: 'hello' }],
  cache: { key: 'prefix', sessionId: 'root', threadId: 'child' },
});
const success = (reasoning?: number, input = 1000) =>
  new Response(
    `data: ${JSON.stringify({
      type: 'response.completed',
      response: {
        status: 'completed',
        usage: {
          input_tokens: input,
          output_tokens: 50,
          input_tokens_details: { cached_tokens: 600, cache_write_tokens: 300 },
          output_tokens_details: reasoning === undefined ? {} : { reasoning_tokens: reasoning },
        },
      },
    })}\n\n`,
  );

function fixture(plan = true, headers?: Record<string, string>) {
  const calls: Array<{ body: Record<string, unknown>; headers: Headers }> = [];
  const provider = new OpenAIResponsesProvider({
    id: plan ? 'openai-chatgpt' : 'gateway',
    apiKey: 'private-fixture-credential',
    baseUrl: plan ? 'https://api.openai.com/v1' : 'https://gateway.invalid',
    store: false,
    chatGPTPlan: plan,
    replayReasoning: plan,
    headers,
    fetchImpl: async (_url, init) => {
      calls.push({ body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
      return success(40);
    },
  });
  return { provider, calls };
}

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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'responses-cache-'));
  const file = path.join(dir, 'probe.jsonl');
  process.env['WRONGSTACK_CACHE_PROBE'] = file;
  resetCacheProbeState();
  return file;
}
const lines = (file: string): Array<Record<string, unknown>> =>
  fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

describe('public ChatGPT plan cache stability', () => {
  it('applies cache stability through an aliased renewable ChatGPT account', async () => {
    let body: Record<string, unknown> | undefined;
    let headers: Headers | undefined;
    const provider = new SubscriptionOAuthProvider({
      id: 'my-chatgpt-plan',
      credential: {
        label: 'fixture',
        apiKey: 'fixture',
        createdAt: '',
        authMethod: 'oauth',
        oauthStrategyId: 'chatgpt-api',
        scope: 'openid chatgpt.tokens.use.direct',
        expiresAt: '2099-01-01T00:00:00.000Z',
      },
      fetchImpl: async (_url, init) => {
        body = JSON.parse(String(init?.body));
        headers = new Headers(init?.headers);
        return success(40);
      },
    });
    await provider.complete(
      {
        ...request(),
        maxTokens: 400,
        temperature: 0.5,
        system: [
          ...request().system!,
          markVolatileSystemBlock({ type: 'text', text: 'retrieved memory' }),
        ],
      },
      { signal: signal() },
    );
    expect(body).toMatchObject({
      instructions: 'stable instructions',
      prompt_cache_key: 'root',
      store: false,
      stream: true,
    });
    expect(headers?.get('session-id')).toBe('root');
    expect(body?.['input']).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'retrieved memory' }] },
    ]);
    expect(body).not.toHaveProperty('max_output_tokens');
    expect(body).not.toHaveProperty('temperature');
    expect(body?.['include']).toEqual(['reasoning.encrypted_content']);
  });

  it('keeps live system values out of instructions and preserves input and caller objects', async () => {
    const { provider, calls } = fixture();
    const req = request();
    const before = JSON.stringify(req);
    for (const value of ['live A', 'live B']) {
      const system = [...req.system!, markVolatileSystemBlock({ type: 'text', text: value })];
      await provider.complete({ ...req, system }, { signal: signal() });
      expect(system).toHaveLength(2);
    }
    expect(calls.map((call) => call.body['instructions'])).toEqual([
      'stable instructions',
      'stable instructions',
    ]);
    for (const [index, call] of calls.entries()) {
      expect(call.body['input']).toEqual([
        { role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
        {
          role: 'user',
          content: [{ type: 'input_text', text: index === 0 ? 'live A' : 'live B' }],
        },
      ]);
    }
    expect(JSON.stringify(req)).toBe(before);
  });

  it('delivers an all-volatile prompt even with empty history', async () => {
    const { provider, calls } = fixture();
    await provider.complete(
      {
        ...request(),
        messages: [],
        system: [
          markVolatileSystemBlock({ type: 'text', text: 'live one' }),
          markVolatileSystemBlock({ type: 'text', text: 'live two' }),
        ],
      },
      { signal: signal() },
    );
    expect(calls[0]!.body).not.toHaveProperty('instructions');
    expect(calls[0]!.body['input']).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'live one\n\nlive two' }] },
    ]);
  });

  it('preserves an unmarked stable prompt and keeps generic gateway metadata', async () => {
    const { provider, calls } = fixture(false, {
      'Session-Id': 'explicit',
      'x-client-request-id': 'gateway-request',
    });
    await provider.complete(request(), { signal: signal() });
    expect(calls[0]!.body['instructions']).toBe('stable instructions');
    expect(calls[0]!.body['prompt_cache_key']).toBe('prefix');
    expect(calls[0]!.body['input']).toHaveLength(1);
    expect(calls[0]!.headers.get('session-id')).toBe('explicit');
    expect(calls[0]!.headers.get('x-client-request-id')).toBe('gateway-request');
  });

  it('keeps the owning cache partition across prefix epochs and isolates sibling threads', async () => {
    const { provider, calls } = fixture(true, {
      'Session-ID': 'stale',
      'Thread-Id': 'stale',
      'X-Client-Request-Id': 'stale',
    });
    for (const [key, threadId] of [
      ['prefix-one', 'child-one'],
      ['prefix-two', 'child-two'],
      ['prefix-two', 'child-one'],
    ]) {
      await provider.complete(
        { ...request(), cache: { key, sessionId: 'root', threadId } },
        { signal: signal() },
      );
    }
    expect(calls.map((call) => call.body['prompt_cache_key'])).toEqual(['root', 'root', 'root']);
    expect(calls.map((call) => call.headers.get('session-id'))).toEqual(['root', 'root', 'root']);
    const threadIds = calls.map((call) => call.headers.get('thread-id'));
    expect(threadIds[0]).toBe(threadIds[2]);
    expect(threadIds[0]).not.toBe(threadIds[1]);
    for (const call of calls)
      expect(call.headers.get('x-client-request-id')).toBe(call.headers.get('thread-id'));
  });

  it('hashes long session ids identically in the body and header', async () => {
    const { provider, calls } = fixture();
    const req = { ...request(), cache: { sessionId: 'session-'.repeat(20) } };
    await provider.complete(req, { signal: signal() });
    await provider.complete(req, { signal: signal() });
    expect(String(calls[0]!.body['prompt_cache_key'])).toHaveLength(64);
    expect(calls[0]!.body['prompt_cache_key']).toBe(calls[1]!.body['prompt_cache_key']);
    expect(calls[0]!.headers.get('session-id')).toBe(calls[0]!.body['prompt_cache_key']);
  });

  it('falls back to an explicit generic key without a session and omits absent keys', async () => {
    const { provider, calls } = fixture();
    await provider.complete({ ...request(), cache: { key: 'prefix-only' } }, { signal: signal() });
    await provider.complete({ ...request(), cache: undefined }, { signal: signal() });
    expect(calls[0]!.body['prompt_cache_key']).toBe('prefix-only');
    expect(calls[1]!.body).not.toHaveProperty('prompt_cache_key');
    for (const call of calls) {
      expect(call.headers.get('session-id')).toBeNull();
      expect(call.headers.get('thread-id')).toBeNull();
      expect(call.body).not.toHaveProperty('prompt_cache_options');
      expect(call.body).not.toHaveProperty('prompt_cache_retention');
      expect(call.body).not.toHaveProperty('previous_response_id');
    }
  });
});

describe('Responses cache diagnostics', () => {
  it('records actual disjoint usage and reasoning as a subset of output, without prompt or secrets', async () => {
    const file = probeFile();
    const { provider } = fixture();
    await provider.complete(request(), { signal: signal() });
    const records = lines(file);
    const usage = records.find((line) => line['kind'] === 'usage')!;
    expect(usage).toMatchObject({
      session: 'root',
      promptTokens: 1000,
      cachedTokens: 600,
      cacheWriteTokens: 300,
      outputTokens: 50,
      reasoningOutputTokens: 40,
      actualHitPct: 60,
    });
    expect(records.find((line) => line['kind'] === 'req')?.['requestId']).toBe(usage['requestId']);
    const raw = fs.readFileSync(file, 'utf8');
    for (const privateText of ['private-fixture-credential', 'stable instructions', 'hello'])
      expect(raw).not.toContain(privateText);
  });

  it('isolates reused requests when concurrent calls finish out of order', async () => {
    const file = probeFile();
    const gates = [Promise.withResolvers<Response>(), Promise.withResolvers<Response>()];
    const started = Promise.withResolvers<void>();
    let calls = 0;
    const provider = new OpenAIResponsesProvider({
      id: 'openai-chatgpt',
      apiKey: 'fixture',
      baseUrl: 'https://api.openai.com/v1',
      chatGPTPlan: true,
      fetchImpl: async () => {
        const gate = gates[calls++]!;
        if (calls === 2) started.resolve();
        return gate.promise;
      },
    });
    const req = request();
    const first = provider.complete(req, { signal: signal() });
    const second = provider.complete(req, { signal: signal() });
    await started.promise;
    gates[1]!.resolve(success(20, 2000));
    await second;
    gates[0]!.resolve(success(10, 1000));
    await first;
    const records = lines(file);
    const requests = records.filter((line) => line['kind'] === 'req');
    const usages = records.filter((line) => line['kind'] === 'usage');
    expect(requests).toHaveLength(2);
    expect(new Set(requests.map((line) => line['requestId'])).size).toBe(2);
    expect(usages.map((line) => line['requestId'])).toEqual([
      requests[1]!['requestId'],
      requests[0]!['requestId'],
    ]);
    expect(usages.map((line) => line['reasoningOutputTokens'])).toEqual([20, 10]);
    expect(usages.map((line) => line['promptTokens'])).toEqual([2000, 1000]);
    expect(req.cache).toEqual({ key: 'prefix', sessionId: 'root', threadId: 'child' });
  });

  it('keeps authoritative zero reasoning and leaves absent reasoning unknown', async () => {
    const file = probeFile();
    let call = 0;
    const provider = new OpenAIResponsesProvider({
      id: 'plan',
      apiKey: 'fixture',
      baseUrl: 'https://api.openai.com/v1',
      chatGPTPlan: true,
      fetchImpl: async () => success(call++ === 0 ? 0 : undefined),
    });
    await provider.complete(request(), { signal: signal() });
    await provider.complete(request(), { signal: signal() });
    const usages = lines(file).filter((line) => line['kind'] === 'usage');
    expect(usages[0]!['reasoningOutputTokens']).toBe(0);
    expect(usages[1]).not.toHaveProperty('reasoningOutputTokens');
  });

  it('does not invent a usage record for a rejected request', async () => {
    const file = probeFile();
    const provider = new OpenAIResponsesProvider({
      id: 'plan',
      apiKey: 'fixture',
      baseUrl: 'https://api.openai.com/v1',
      chatGPTPlan: true,
      fetchImpl: async () =>
        new Response('{"error":{"message":"rejected","code":"invalid_request"}}', { status: 400 }),
    });
    await expect(provider.complete(request(), { signal: signal() })).rejects.toMatchObject({
      status: 400,
    });
    expect(lines(file).map((line) => line['kind'])).toEqual(['req']);
  });

  it('does no probe file work when disabled', async () => {
    process.env['WRONGSTACK_CACHE_PROBE'] = 'false';
    resetCacheProbeState();
    const req = request();
    const cache = req.cache;
    const { provider } = fixture();
    await provider.complete(req, { signal: signal() });
    expect(req.cache).toBe(cache);
  });
});
