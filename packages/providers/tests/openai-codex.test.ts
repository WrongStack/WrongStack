import { ProviderError, type Request, type StreamEvent } from '@wrongstack/core/types';
import { describe, expect, it, vi } from 'vitest';
import {
  type CodexOAuthTokens,
  codexOutputCap,
  extractAccountId,
  OpenAICodexProvider,
  parseOpenAIResponsesStream,
  resolveCodexModelsUrl,
  resolveCodexUrl,
} from '../src/openai-codex.js';

/** Build a fake JWT carrying a ChatGPT account-id claim. */
function fakeJwt(accountId: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId } }),
  ).toString('base64url');
  return `${header}.${payload}.sig`;
}

function sseBody(events: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    pull(c) {
      c.enqueue(enc.encode(events));
      c.close();
    },
  });
}

interface Captured {
  url?: string;
  init?: { headers?: Record<string, string>; body?: string };
}

function capturingFetch(body: string, captured: Captured, status = 200): typeof fetch {
  return (async (url: string, init: { headers?: Record<string, string>; body?: string }) => {
    captured.url = url;
    captured.init = init;
    return new Response(status >= 200 && status < 300 ? sseBody(body) : 'err', {
      status,
      headers: { 'content-type': 'text/event-stream' },
    });
  }) as never as typeof fetch;
}

const baseReq: Request = {
  model: 'gpt-5-codex',
  system: [{ type: 'text', text: 'Be terse.' }],
  messages: [{ role: 'user', content: 'hi' }],
  maxTokens: 100,
};

const COMPLETED_SSE = [
  'data: {"type":"response.created","response":{"id":"r1","model":"gpt-5-codex"}}',
  '',
  'data: {"type":"response.output_item.added","item":{"type":"message","id":"m1","role":"assistant"}}',
  '',
  'data: {"type":"response.output_text.delta","delta":"ok"}',
  '',
  'data: {"type":"response.output_item.done","item":{"type":"message","id":"m1"}}',
  '',
  'data: {"type":"response.completed","response":{"id":"r1","status":"completed","usage":{"input_tokens":5,"output_tokens":1}}}',
  '',
].join('\n');

describe('extractAccountId', () => {
  it('pulls chatgpt_account_id from the JWT', () => {
    expect(extractAccountId(fakeJwt('acc_42'))).toBe('acc_42');
  });
  it('returns null for non-JWT / missing claim', () => {
    expect(extractAccountId('not-a-jwt')).toBeNull();
    expect(
      extractAccountId(
        `${Buffer.from('{}').toString('base64url')}.${Buffer.from('{}').toString('base64url')}.s`,
      ),
    ).toBeNull();
  });
});

describe('resolveCodexUrl', () => {
  it('normalizes to /codex/responses', () => {
    expect(resolveCodexUrl(undefined)).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(resolveCodexUrl('https://chatgpt.com/backend-api')).toBe(
      'https://chatgpt.com/backend-api/codex/responses',
    );
    expect(resolveCodexUrl('https://example.com/backend-api/codex')).toBe(
      'https://example.com/backend-api/codex/responses',
    );
  });

  it.each([
    [undefined, 'https://chatgpt.com/backend-api/codex/models'],
    ['https://example.com/backend-api', 'https://example.com/backend-api/codex/models'],
    ['https://example.com/backend-api/codex/', 'https://example.com/backend-api/codex/models'],
    [
      'https://example.com/backend-api/codex/responses',
      'https://example.com/backend-api/codex/models',
    ],
  ])('resolves the live model catalog beside %s', (baseUrl, expected) => {
    expect(resolveCodexModelsUrl(baseUrl)).toBe(expected);
  });
});

describe('OpenAICodexProvider live context limit', () => {
  it('reads context_window and conditionally re-checks the provider catalog', async () => {
    const calls: Array<{ url: string; headers: RequestInit['headers'] }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), headers: init?.headers });
      const requestNo = calls.length;
      const responseInit: ResponseInit =
        requestNo === 1 ? { status: 200, headers: { etag: '"ctx-v1"' } } : { status: 304 };
      return new Response(
        requestNo === 1
          ? JSON.stringify({ models: [{ slug: 'gpt-5.6-sol', context_window: 272_000 }] })
          : null,
        responseInit,
      );
    }) as typeof fetch;
    const provider = new OpenAICodexProvider({
      credentials: { accessToken: fakeJwt('acc_99'), expiresAt: Date.now() + 3_600_000 },
      fetchImpl,
    });

    await expect(
      provider.refreshContextLimit('gpt-5.6-sol', { signal: new AbortController().signal }),
    ).resolves.toEqual({ maxContext: 255_616, source: 'provider' });
    await expect(
      provider.refreshContextLimit('gpt-5.6-sol', { signal: new AbortController().signal }),
    ).resolves.toEqual({ maxContext: 255_616, source: 'provider' });

    // The backend rejects non-semver values with "Invalid client_version
    // format" — the param must always carry a real package version.
    expect(calls[0]?.url).toMatch(/\/codex\/models\?client_version=\d+\.\d+\.\d+$/);
    expect(new Headers(calls[1]?.headers).get('if-none-match')).toBe('"ctx-v1"');
  });

  it('validates catalog limits and maps each slug to its usable integer ceiling', async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          models: [
            { slug: 'fractional', context_window: 272_000.75 },
            { slug: 'fallback', context_window: 0, max_context_window: 128_000 },
            { slug: 'string-limit', context_window: '272000' },
            { slug: 'zero-limit', context_window: 0 },
          ],
        }),
        { status: 200 },
      )) as typeof fetch;
    const provider = new OpenAICodexProvider({
      credentials: { accessToken: fakeJwt('acc_99'), expiresAt: Date.now() + 3_600_000 },
      fetchImpl,
    });
    const signal = new AbortController().signal;

    await expect(provider.refreshContextLimit('fractional', { signal })).resolves.toEqual({
      maxContext: 255_616,
      source: 'provider',
    });
    await expect(provider.refreshContextLimit('fallback', { signal })).resolves.toEqual({
      maxContext: 111_616,
      source: 'provider',
    });
    await expect(provider.refreshContextLimit('string-limit', { signal })).resolves.toBeUndefined();
    await expect(provider.refreshContextLimit('zero-limit', { signal })).resolves.toBeUndefined();
  });

  it('keeps the last verified limit and backs off after a catalog check fails', async () => {
    let requestNo = 0;
    const fetchImpl = (async () => {
      requestNo += 1;
      if (requestNo === 1) {
        return new Response(
          JSON.stringify({ models: [{ slug: 'gpt-5.6-sol', max_context_window: 272_000 }] }),
          { status: 200 },
        );
      }
      throw new Error('metadata unavailable');
    }) as typeof fetch;
    const provider = new OpenAICodexProvider({
      credentials: { accessToken: fakeJwt('acc_99'), expiresAt: Date.now() + 3_600_000 },
      fetchImpl,
    });
    const signal = new AbortController().signal;

    await provider.refreshContextLimit('gpt-5.6-sol', { signal });
    await expect(provider.refreshContextLimit('gpt-5.6-sol', { signal })).resolves.toEqual({
      maxContext: 255_616,
      source: 'provider',
    });
    await expect(provider.refreshContextLimit('gpt-5.6-sol', { signal })).resolves.toEqual({
      maxContext: 255_616,
      source: 'provider',
    });
    expect(requestNo).toBe(2);
  });

  it('adopts the send ceiling, not the raw total window, on a throttled drop', async () => {
    // A throttled route publishes the TOTAL window (272000) while the backend
    // enforces sends around `context_window - max_output_tokens` (~258K).
    // The probe must return the discounted send ceiling so preflight
    // compaction triggers before the backend rejects the request.
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ models: [{ slug: 'gpt-5.6-sol', context_window: 272_000 }] }), {
        status: 200,
      })) as typeof fetch;
    const provider = new OpenAICodexProvider({
      credentials: { accessToken: fakeJwt('acc_99'), expiresAt: Date.now() + 3_600_000 },
      fetchImpl,
    });
    const signal = new AbortController().signal;

    await expect(provider.refreshContextLimit('gpt-5.6-sol', { signal })).resolves.toEqual({
      maxContext: 255_616, // 272_000 - 16_384 (Codex output budget)
      source: 'provider',
    });
  });

  it('caps the output reserve at half of a small window so tiny routes stay usable', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ models: [{ slug: 'tiny', context_window: 20_000 }] }), {
        status: 200,
      })) as typeof fetch;
    const provider = new OpenAICodexProvider({
      credentials: { accessToken: fakeJwt('acc_99'), expiresAt: Date.now() + 3_600_000 },
      fetchImpl,
    });
    const signal = new AbortController().signal;

    await expect(provider.refreshContextLimit('tiny', { signal })).resolves.toEqual({
      maxContext: 10_000, // min(16_384, 20_000 / 2) reserve
      source: 'provider',
    });
  });
});

describe('OpenAICodexProvider request shape', () => {
  it('sends Responses body + ChatGPT auth headers', async () => {
    const captured: Captured = {};
    const token = fakeJwt('acc_99');
    const p = new OpenAICodexProvider({
      credentials: { accessToken: token, expiresAt: Date.now() + 3_600_000 },
      fetchImpl: capturingFetch(COMPLETED_SSE, captured),
    });
    await p.complete(baseReq, { signal: new AbortController().signal });

    expect(captured.url).toBe('https://chatgpt.com/backend-api/codex/responses');
    const h = captured.init?.headers ?? {};
    expect(h['authorization']).toBe(`Bearer ${token}`);
    expect(h['chatgpt-account-id']).toBe('acc_99');
    expect(h['originator']).toBe('wrongstack');
    expect(h['OpenAI-Beta']).toBe('responses=experimental');

    const body = JSON.parse(captured.init?.body ?? '{}');
    expect(body.store).toBe(false);
    expect(body.stream).toBe(true);
    expect(body.instructions).toBe('Be terse.');
    expect(body.input).toEqual([{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }]);
  });

  it('emits prompt_cache_key from req.cache.key (Responses cache routing)', async () => {
    const captured: Captured = {};
    const p = new OpenAICodexProvider({
      credentials: { accessToken: fakeJwt('acc_99'), expiresAt: Date.now() + 3_600_000 },
      fetchImpl: capturingFetch(COMPLETED_SSE, captured),
    });
    await p.complete(
      { ...baseReq, cache: { key: 'ws-codexkey' } },
      { signal: new AbortController().signal },
    );
    const body = JSON.parse(captured.init?.body ?? '{}');
    expect(body.prompt_cache_key).toBe('ws-codexkey');
  });

  it.each(['xhigh', 'max'] as const)(
    'forwards request-level %s reasoning effort',
    async (effort) => {
      const captured: Captured = {};
      const p = new OpenAICodexProvider({
        credentials: { accessToken: fakeJwt('acc_99'), expiresAt: Date.now() + 3_600_000 },
        fetchImpl: capturingFetch(COMPLETED_SSE, captured),
      });

      await p.complete(
        { ...baseReq, model: 'gpt-5.6-sol', reasoning: { effort } },
        { signal: new AbortController().signal },
      );

      const body = JSON.parse(captured.init?.body ?? '{}');
      expect(body.reasoning).toEqual({ effort, summary: 'auto' });
    },
  );

  it('omits reasoning when request-level reasoning is disabled', async () => {
    const captured: Captured = {};
    const p = new OpenAICodexProvider({
      credentials: { accessToken: fakeJwt('acc_99'), expiresAt: Date.now() + 3_600_000 },
      fetchImpl: capturingFetch(COMPLETED_SSE, captured),
    });

    await p.complete(
      { ...baseReq, reasoning: { enabled: false } },
      { signal: new AbortController().signal },
    );

    const body = JSON.parse(captured.init?.body ?? '{}');
    expect(body).not.toHaveProperty('reasoning');
  });
});

describe('OpenAICodexProvider stream parsing', () => {
  it('parses text + function_call into canonical content', async () => {
    const sse = [
      'data: {"type":"response.created","response":{"id":"r1","model":"gpt-5-codex"}}',
      '',
      'data: {"type":"response.output_item.added","item":{"type":"message","id":"m1","role":"assistant"}}',
      '',
      'data: {"type":"response.output_text.delta","delta":"Hello"}',
      '',
      'data: {"type":"response.output_text.delta","delta":" world"}',
      '',
      'data: {"type":"response.output_item.done","item":{"type":"message","id":"m1"}}',
      '',
      'data: {"type":"response.output_item.added","item":{"type":"function_call","id":"fc1","call_id":"call_1","name":"get_weather"}}',
      '',
      'data: {"type":"response.function_call_arguments.delta","delta":"{\\"city\\""}',
      '',
      'data: {"type":"response.function_call_arguments.delta","delta":":\\"NYC\\"}"}',
      '',
      'data: {"type":"response.function_call_arguments.done","arguments":"{\\"city\\":\\"NYC\\"}"}',
      '',
      'data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_1","name":"get_weather","arguments":"{\\"city\\":\\"NYC\\"}"}}',
      '',
      'data: {"type":"response.completed","response":{"id":"r1","status":"completed","usage":{"input_tokens":10,"output_tokens":5,"input_tokens_details":{"cached_tokens":2}}}}',
      '',
    ].join('\n');

    const p = new OpenAICodexProvider({
      credentials: { accessToken: fakeJwt('a'), expiresAt: Date.now() + 3_600_000 },
      fetchImpl: (async () => new Response(sseBody(sse), { status: 200 })) as never as typeof fetch,
    });
    const res = await p.complete(baseReq, { signal: new AbortController().signal });

    expect(res.content).toEqual([
      { type: 'text', text: 'Hello world' },
      { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'NYC' } },
    ]);
    expect(res.stopReason).toBe('tool_use');
    expect(res.usage).toMatchObject({ input: 8, output: 5, cacheRead: 2 });
  });

  it('classifies nested response.failed context errors without synthetic 502 retries and preserves the scrubbed envelope', async () => {
    const reflectedCredential = ['sk', '1234567890abcdefghijklmnop'].join('-');
    const sse = [
      `data: {"type":"response.failed","response":{"id":"resp_ctx","status":"failed","error":{"code":"context_length_exceeded","message":"Your input exceeds the context window; api_key=${reflectedCredential}"}}}`,
      '',
    ].join('\n');
    const p = new OpenAICodexProvider({
      credentials: { accessToken: fakeJwt('a'), expiresAt: Date.now() + 3_600_000 },
      fetchImpl: (async () => new Response(sseBody(sse), { status: 200 })) as never as typeof fetch,
    });

    let caught: unknown;
    try {
      await p.complete(baseReq, { signal: new AbortController().signal });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ProviderError);
    const providerError = caught as ProviderError;
    expect(providerError.status).toBe(413);
    expect(providerError.kind).toBe('context_overflow');
    expect(providerError.retryable).toBe(false);
    expect(providerError.body).toMatchObject({
      type: 'context_length_exceeded',
      requestId: 'resp_ctx',
    });
    expect(providerError.message).not.toContain(reflectedCredential);
    expect(providerError.message).toContain('[REDACTED:openai_key]');
    expect(providerError.stack).not.toContain(reflectedCredential);
    expect(providerError.stack).toContain('[REDACTED:openai_key]');
    expect(providerError.body?.message).toContain('[REDACTED:openai_key]');
    expect(providerError.body?.raw).toContain('response.failed');
    expect(providerError.body?.raw).toContain('[REDACTED:openai_key]');
    expect(providerError.body?.raw).not.toContain(reflectedCredential);
  });

  it('parses response.failed errors nested under status_details', async () => {
    const sse = [
      'data: {"type":"response.failed","response":{"id":"resp_status_details","status":"failed","status_details":{"error":{"code":"context_length_exceeded","message":"Maximum context length exceeded"}}}}',
      '',
    ].join('\n');
    const p = new OpenAICodexProvider({
      credentials: { accessToken: fakeJwt('a'), expiresAt: Date.now() + 3_600_000 },
      fetchImpl: (async () => new Response(sseBody(sse), { status: 200 })) as never as typeof fetch,
    });

    await expect(
      p.complete(baseReq, { signal: new AbortController().signal }),
    ).rejects.toMatchObject({
      status: 413,
      kind: 'context_overflow',
      retryable: false,
      body: expect.objectContaining({
        type: 'context_length_exceeded',
        message: 'Maximum context length exceeded',
        requestId: 'resp_status_details',
        raw: expect.stringContaining('status_details'),
      }),
    });
  });

  it('classifies the throttled-drop agent-run failure as context_overflow (413, non-retryable)', async () => {
    // The ChatGPT backend surfaces a subscription throttled-drop as an agent
    // run failure with the Codex CLI's own wrapper prefix. The envelope must
    // still classify as context_overflow so the recovery path compacts and
    // retries instead of treating it as a terminal client/server error.
    const sse = [
      `data: ${JSON.stringify({
        type: 'response.failed',
        response: {
          id: 'resp_agent_run',
          status: 'failed',
          error: {
            code: 'agent_run_failed',
            message:
              'Failed [error]: AGENT_RUN_FAILED: Your input exceeds the context window of this model. Please adjust your input and try again.',
          },
        },
      })}`,
      '',
    ].join('\n');
    const p = new OpenAICodexProvider({
      credentials: { accessToken: fakeJwt('a'), expiresAt: Date.now() + 3_600_000 },
      fetchImpl: (async () => new Response(sseBody(sse), { status: 200 })) as never as typeof fetch,
    });

    await expect(
      p.complete(baseReq, { signal: new AbortController().signal }),
    ).rejects.toMatchObject({
      status: 413,
      kind: 'context_overflow',
      retryable: false,
      body: expect.objectContaining({
        message: expect.stringContaining('exceeds the context window of this model'),
        requestId: 'resp_agent_run',
      }),
    });
  });

  it('honors response.status_code for generic failed envelopes', async () => {
    const sse = [
      'data: {"type":"response.failed","response":{"id":"resp_500","status":"failed","status_code":500,"error":{"message":"Upstream service failed"}}}',
      '',
    ].join('\n');
    const p = new OpenAICodexProvider({
      credentials: { accessToken: fakeJwt('a'), expiresAt: Date.now() + 3_600_000 },
      fetchImpl: (async () => new Response(sseBody(sse), { status: 200 })) as never as typeof fetch,
    });

    await expect(
      p.complete(baseReq, { signal: new AbortController().signal }),
    ).rejects.toMatchObject({
      status: 500,
      kind: 'server',
      retryable: true,
      body: expect.objectContaining({ requestId: 'resp_500', message: 'Upstream service failed' }),
    });
  });

  it('classifies top-level SSE error codes instead of treating every failure as HTTP 502', async () => {
    const sse = [
      'data: {"type":"error","code":"rate_limit_exceeded","message":"Rate limit exceeded"}',
      '',
    ].join('\n');
    const p = new OpenAICodexProvider({
      credentials: { accessToken: fakeJwt('a'), expiresAt: Date.now() + 3_600_000 },
      fetchImpl: (async () => new Response(sseBody(sse), { status: 200 })) as never as typeof fetch,
    });

    await expect(
      p.complete(baseReq, { signal: new AbortController().signal }),
    ).rejects.toMatchObject({
      status: 429,
      kind: 'rate_limit',
      retryable: true,
      body: expect.objectContaining({
        type: 'rate_limit_exceeded',
        message: 'Rate limit exceeded',
        raw: expect.stringContaining('"type":"error"'),
      }),
    });
  });

  it.each([
    ['authentication_error', 'Invalid access token', 401, 'auth', false],
    ['content_filter', 'Content policy blocked this request', 400, 'content_filter', false],
    ['error', 'Usage limit reached for this plan', 402, 'quota_exhausted', false],
  ] as const)(
    'maps SSE %s failures to canonical status/kind',
    async (code, message, status, kind, retryable) => {
      const sse = [`data: ${JSON.stringify({ type: 'error', code, message })}`, ''].join('\n');
      const p = new OpenAICodexProvider({
        credentials: { accessToken: fakeJwt('a'), expiresAt: Date.now() + 3_600_000 },
        fetchImpl: (async () =>
          new Response(sseBody(sse), { status: 200 })) as never as typeof fetch,
      });

      await expect(
        p.complete(baseReq, { signal: new AbortController().signal }),
      ).rejects.toMatchObject({ status, kind, retryable });
    },
  );

  it.each(['Maximum tokens exceeded', 'The request is too long', 'Input too large'])(
    'classifies terse SSE overflow message %j without retrying as a server failure',
    async (message) => {
      const sse = [`data: ${JSON.stringify({ type: 'error', message })}`, ''].join('\n');
      const p = new OpenAICodexProvider({
        credentials: { accessToken: fakeJwt('a'), expiresAt: Date.now() + 3_600_000 },
        fetchImpl: (async () =>
          new Response(sseBody(sse), { status: 200 })) as never as typeof fetch,
      });

      await expect(
        p.complete(baseReq, { signal: new AbortController().signal }),
      ).rejects.toMatchObject({
        status: 413,
        kind: 'context_overflow',
        retryable: false,
        body: expect.objectContaining({ message }),
      });
    },
  );

  it('throws a retryable error when the stream ends with no response.completed and no [DONE] (mid-stream cut)', async () => {
    const sse = [
      'data: {"type":"response.created","response":{"id":"r1","model":"gpt-5-codex"}}',
      '',
      'data: {"type":"response.output_text.delta","delta":"Half a sen"}',
      '',
    ].join('\n');
    const p = new OpenAICodexProvider({
      credentials: { accessToken: fakeJwt('a'), expiresAt: Date.now() + 3_600_000 },
      fetchImpl: (async () => new Response(sseBody(sse), { status: 200 })) as never as typeof fetch,
    });
    let caught: unknown;
    try {
      await p.complete(baseReq, { signal: new AbortController().signal });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/truncat/i);
    expect((caught as { retryable?: boolean }).retryable).toBe(true);
  });

  it('reconstructs streamed function-call arguments when output_item.done omits the final arguments field', async () => {
    const sse = [
      'data: {"type":"response.created","response":{"id":"r1","model":"gpt-5-codex"}}',
      '',
      'data: {"type":"response.output_item.added","item":{"type":"function_call","call_id":"call_late","name":"lookup"}}',
      '',
      'data: {"type":"response.function_call_arguments.delta","delta":"{\\"city\\":\\"NYC\\"}"}',
      '',
      'data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_late","name":"lookup"}}',
      '',
      'data: {"type":"response.completed","response":{"id":"r1","status":"completed","usage":{"input_tokens":1,"output_tokens":1}}}',
      '',
    ].join('\n');

    const p = new OpenAICodexProvider({
      credentials: { accessToken: fakeJwt('a'), expiresAt: Date.now() + 3_600_000 },
      fetchImpl: (async () => new Response(sseBody(sse), { status: 200 })) as never as typeof fetch,
    });
    const res = await p.complete(baseReq, { signal: new AbortController().signal });

    expect(res.content).toContainEqual({
      type: 'tool_use',
      id: 'call_late',
      name: 'lookup',
      input: { city: 'NYC' },
    });
  });

  it('normalizes Responses cache write tokens separately from full-rate input', async () => {
    const sse = [
      'data: {"type":"response.created","response":{"id":"r1","model":"gpt-5.6-codex"}}',
      '',
      'data: {"type":"response.output_item.added","item":{"type":"message","id":"m1","role":"assistant"}}',
      '',
      'data: {"type":"response.output_text.delta","delta":"ok"}',
      '',
      'data: {"type":"response.completed","response":{"id":"r1","status":"completed","usage":{"input_tokens":100,"output_tokens":5,"input_tokens_details":{"cached_tokens":40,"cache_write_tokens":10}}}}',
      '',
    ].join('\n');

    const p = new OpenAICodexProvider({
      credentials: { accessToken: fakeJwt('a'), expiresAt: Date.now() + 3_600_000 },
      fetchImpl: (async () => new Response(sseBody(sse), { status: 200 })) as never as typeof fetch,
    });
    const res = await p.complete(baseReq, { signal: new AbortController().signal });

    expect(res.usage).toMatchObject({ input: 50, output: 5, cacheRead: 40, cacheWrite: 10 });
  });

  it('recovers message text delivered only in output_text.done (no deltas)', async () => {
    const sse = [
      'data: {"type":"response.created","response":{"id":"r1","model":"gpt-5-codex"}}',
      '',
      'data: {"type":"response.output_item.added","item":{"type":"message","id":"m1","role":"assistant"}}',
      '',
      'data: {"type":"response.output_text.done","text":"Done — no deltas here."}',
      '',
      'data: {"type":"response.output_item.done","item":{"type":"message","id":"m1"}}',
      '',
      'data: {"type":"response.completed","response":{"id":"r1","status":"completed","usage":{"input_tokens":3,"output_tokens":6}}}',
      '',
    ].join('\n');

    const p = new OpenAICodexProvider({
      credentials: { accessToken: fakeJwt('a'), expiresAt: Date.now() + 3_600_000 },
      fetchImpl: (async () => new Response(sseBody(sse), { status: 200 })) as never as typeof fetch,
    });
    const res = await p.complete(baseReq, { signal: new AbortController().signal });

    expect(res.content).toEqual([{ type: 'text', text: 'Done — no deltas here.' }]);
    expect(res.stopReason).toBe('end_turn');
  });

  it('recovers message text delivered only in the output_item.done content array', async () => {
    const sse = [
      'data: {"type":"response.created","response":{"id":"r1","model":"gpt-5-codex"}}',
      '',
      'data: {"type":"response.output_item.added","item":{"type":"message","id":"m1","role":"assistant"}}',
      '',
      'data: {"type":"response.output_item.done","item":{"type":"message","id":"m1","content":[{"type":"output_text","text":"Only in the item."}]}}',
      '',
      'data: {"type":"response.completed","response":{"id":"r1","status":"completed","usage":{"input_tokens":3,"output_tokens":4}}}',
      '',
    ].join('\n');

    const p = new OpenAICodexProvider({
      credentials: { accessToken: fakeJwt('a'), expiresAt: Date.now() + 3_600_000 },
      fetchImpl: (async () => new Response(sseBody(sse), { status: 200 })) as never as typeof fetch,
    });
    const res = await p.complete(baseReq, { signal: new AbortController().signal });

    expect(res.content).toEqual([{ type: 'text', text: 'Only in the item.' }]);
  });

  it('does not duplicate text when deltas AND terminal events both carry it', async () => {
    const sse = [
      'data: {"type":"response.created","response":{"id":"r1","model":"gpt-5-codex"}}',
      '',
      'data: {"type":"response.output_item.added","item":{"type":"message","id":"m1","role":"assistant"}}',
      '',
      'data: {"type":"response.output_text.delta","delta":"Hello"}',
      '',
      'data: {"type":"response.output_text.delta","delta":" world"}',
      '',
      'data: {"type":"response.output_text.done","text":"Hello world"}',
      '',
      'data: {"type":"response.output_item.done","item":{"type":"message","id":"m1","content":[{"type":"output_text","text":"Hello world"}]}}',
      '',
      'data: {"type":"response.completed","response":{"id":"r1","status":"completed","usage":{"input_tokens":3,"output_tokens":2}}}',
      '',
    ].join('\n');

    const p = new OpenAICodexProvider({
      credentials: { accessToken: fakeJwt('a'), expiresAt: Date.now() + 3_600_000 },
      fetchImpl: (async () => new Response(sseBody(sse), { status: 200 })) as never as typeof fetch,
    });
    const res = await p.complete(baseReq, { signal: new AbortController().signal });

    expect(res.content).toEqual([{ type: 'text', text: 'Hello world' }]);
  });

  it('recovers partial-delta text via the terminal remainder (deltas cut short)', async () => {
    const sse = [
      'data: {"type":"response.created","response":{"id":"r1","model":"gpt-5-codex"}}',
      '',
      'data: {"type":"response.output_item.added","item":{"type":"message","id":"m1","role":"assistant"}}',
      '',
      'data: {"type":"response.output_text.delta","delta":"Hel"}',
      '',
      'data: {"type":"response.output_text.done","text":"Hello"}',
      '',
      'data: {"type":"response.output_item.done","item":{"type":"message","id":"m1"}}',
      '',
      'data: {"type":"response.completed","response":{"id":"r1","status":"completed","usage":{"input_tokens":1,"output_tokens":1}}}',
      '',
    ].join('\n');

    const p = new OpenAICodexProvider({
      credentials: { accessToken: fakeJwt('a'), expiresAt: Date.now() + 3_600_000 },
      fetchImpl: (async () => new Response(sseBody(sse), { status: 200 })) as never as typeof fetch,
    });
    const res = await p.complete(baseReq, { signal: new AbortController().signal });

    expect(res.content).toEqual([{ type: 'text', text: 'Hello' }]);
  });
});

describe('OpenAICodexProvider token refresh', () => {
  it('refreshes a near-expired token before the request and persists', async () => {
    const captured: Captured = {};
    const fresh = fakeJwt('acc_new');
    const refreshFn = vi.fn(
      async (): Promise<CodexOAuthTokens> => ({
        access: fresh,
        refresh: 'r2',
        expires: Date.now() + 3_600_000,
      }),
    );
    const onRefresh = vi.fn();
    const p = new OpenAICodexProvider({
      credentials: {
        accessToken: fakeJwt('acc_old'),
        refreshToken: 'r1',
        expiresAt: Date.now() - 1000, // already expired
      },
      refreshFn,
      onRefresh,
      fetchImpl: capturingFetch(COMPLETED_SSE, captured),
    });
    await p.complete(baseReq, { signal: new AbortController().signal });

    expect(refreshFn).toHaveBeenCalledOnce();
    expect(captured.init?.headers?.['authorization']).toBe(`Bearer ${fresh}`);
    expect(captured.init?.headers?.['chatgpt-account-id']).toBe('acc_new');
    expect(onRefresh).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: fresh, refreshToken: 'r2', accountId: 'acc_new' }),
    );
  });

  it('refreshes once and retries on a 401', async () => {
    const fresh = fakeJwt('acc_new');
    const refreshFn = vi.fn(
      async (): Promise<CodexOAuthTokens> => ({
        access: fresh,
        refresh: 'r2',
        expires: Date.now() + 3_600_000,
      }),
    );
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls === 1) return new Response('unauthorized', { status: 401 });
      return new Response(sseBody(COMPLETED_SSE), { status: 200 });
    }) as never as typeof fetch;

    const p = new OpenAICodexProvider({
      credentials: {
        accessToken: fakeJwt('acc_old'),
        refreshToken: 'r1',
        expiresAt: Date.now() + 3_600_000, // not near expiry → no pre-flight refresh
      },
      refreshFn,
      fetchImpl,
    });
    const res = await p.complete(baseReq, { signal: new AbortController().signal });

    expect(calls).toBe(2);
    expect(refreshFn).toHaveBeenCalledOnce();
    expect(res.stopReason).toBe('end_turn');
  });

  it('coalesces concurrent refresh requests into a single refreshFn call', async () => {
    const fresh = fakeJwt('acc_new');
    let resolveRefresh!: (v: CodexOAuthTokens) => void;
    const refreshFn = vi.fn(
      () =>
        new Promise<CodexOAuthTokens>((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    const onRefresh = vi.fn();

    const p = new OpenAICodexProvider({
      credentials: {
        accessToken: fakeJwt('acc_old'),
        refreshToken: 'r1',
        expiresAt: Date.now() - 1000, // every call will hit ensureFreshToken
      },
      refreshFn,
      onRefresh,
      fetchImpl: capturingFetch(COMPLETED_SSE, {}),
    });

    const signals = [new AbortController(), new AbortController(), new AbortController()];
    const requests = signals.map((c) => p.complete(baseReq, { signal: c.signal }));

    // Give the three refresh attempts a chance to all queue up on the
    // single-flight slot before any of them resolves.
    await new Promise((r) => setTimeout(r, 5));
    expect(refreshFn).toHaveBeenCalledTimes(1);

    resolveRefresh({ access: fresh, refresh: 'r2', expires: Date.now() + 3_600_000 });
    await Promise.all(requests);

    expect(refreshFn).toHaveBeenCalledTimes(1);
    // onRefresh also fires exactly once per actual refresh — three callers
    // sharing one refresh must not multiply the persistence callbacks.
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});

describe('Codex output cap', () => {
  it('omits every cap because the ChatGPT Codex backend rejects the field', () => {
    for (const n of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, 80, 1024, 16_384]) {
      expect(codexOutputCap(n), String(n)).toBeUndefined();
    }
  });

  it('omits max_output_tokens entirely when the caller sets no cap', async () => {
    const captured: Captured = {};
    const p = new OpenAICodexProvider({
      credentials: { accessToken: fakeJwt('acc_1'), expiresAt: Date.now() + 3_600_000 },
      fetchImpl: capturingFetch(COMPLETED_SSE, captured),
    });
    await p.complete(
      { ...baseReq, maxTokens: undefined },
      { signal: new AbortController().signal },
    );
    const body = JSON.parse(captured.init?.body ?? '{}');
    // Absent, NOT the catalog ceiling: the backend default is the same number
    // without the risk of us sending a stale one.
    expect(body).not.toHaveProperty('max_output_tokens');
  });

  it('omits max_output_tokens even when the caller sets a cap', async () => {
    const captured: Captured = {};
    const p = new OpenAICodexProvider({
      credentials: { accessToken: fakeJwt('acc_1'), expiresAt: Date.now() + 3_600_000 },
      fetchImpl: capturingFetch(COMPLETED_SSE, captured),
    });
    await p.complete({ ...baseReq, maxTokens: 16_384 }, { signal: new AbortController().signal });
    expect(JSON.parse(captured.init?.body ?? '{}')).not.toHaveProperty('max_output_tokens');
  });
});

describe('parseOpenAIResponsesStream usage recovery', () => {
  it('emits message_start + usage-bearing message_stop when the terminal envelope arrives with no start-producing events', async () => {
    const sse = [
      'data: {"type":"response.completed","response":{"id":"r1","status":"completed","usage":{"input_tokens":7,"output_tokens":2,"input_tokens_details":{"cached_tokens":5}}}}',
      '',
    ].join('\n');
    const events: StreamEvent[] = [];
    for await (const e of parseOpenAIResponsesStream(sseBody(sse), 'gpt-5-codex')) {
      events.push(e);
    }
    // Regression: a backend that skips `response.created`/`output_item.added`
    // and goes straight to a usage-bearing `response.completed` must not
    // silently drop its telemetry. The parser now emits the paired
    // message_start so the terminal message_stop (with usage) is delivered.
    expect(events.map((e) => e.type)).toEqual(['message_start', 'message_stop']);
    const stop = events[1] as { type: 'message_stop'; usage?: { input: number; output: number; cacheRead?: number } };
    // normalizeUsage: input = 7 − 5(cached) − 0(write) = 2, cacheRead = 5.
    expect(stop.usage).toEqual({ input: 2, output: 2, cacheRead: 5 });
  });

  it('still emits nothing (no telemetry) for a usage-less terminal envelope with no start-producing events', async () => {
    const sse = [
      'data: {"type":"response.completed","response":{"id":"r1","status":"completed"}}',
      '',
    ].join('\n');
    const events: StreamEvent[] = [];
    for await (const e of parseOpenAIResponsesStream(sseBody(sse), 'gpt-5-codex')) {
      events.push(e);
    }
    // Pre-existing contract preserved: without usage there is nothing worth
    // synthesizing an empty stream event pair for.
    expect(events).toEqual([]);
  });
});
