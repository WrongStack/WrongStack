import { readFile } from 'node:fs/promises';
import {
  markVolatileSystemBlock,
  ProviderError,
  type Request,
  type StreamEvent,
  type TextBlock,
} from '@wrongstack/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type CodexOAuthTokens,
  codexCacheSessionId,
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

afterEach(() => vi.useRealTimers());

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

describe('codexCacheSessionId', () => {
  it('keeps cache affinity stable while making the header safe', () => {
    expect(codexCacheSessionId('sess:one/two')).toBe('sess_one_two');
  });
});

describe('Responses response.metadata', () => {
  it('captures normalized headers and request metadata', async () => {
    const metadata: unknown[] = [];
    const stream = parseOpenAIResponsesStream(
      sseBody(`data: {"type":"response.metadata","metadata":{"headers":{"X-Codex-Turn-State":"state-1","X-Models-Etag":"etag-1"},"request_id":"req-1","model":"gpt-5-codex"}}

data: {"type":"response.completed","response":{"status":"completed"}}

`),
      'gpt-5-codex',
      'openai-codex',
      (value) => metadata.push(value),
    );
    for await (const _event of stream) {
      // Drain the stream so metadata delivery is exercised.
    }
    expect(metadata).toEqual([
      {
        headers: { 'x-codex-turn-state': 'state-1', 'x-models-etag': 'etag-1' },
        requestId: 'req-1',
        model: 'gpt-5-codex',
      },
    ]);
  });
});

describe('OpenAICodexProvider live context limit', () => {
  it.each([
    // `max_context_window` is the largest window the model supports — the
    // ceiling a configured client may ask for (`configured.min(max)` in the
    // official client) — while `context_window` is only the default. On
    // gpt-6-astra and the gpt-5.6 family that is 872K against a 272K default,
    // so reporting the default would throw away two thirds of the window.
    // The default is the fallback for a catalog too old to publish a maximum.
    [872_000, 828_400],
    [1_050_000, 997_500],
    [0, 258_400],
    ['872000', 258_400],
  ])('reports the model maximum %s, falling back to context_window', async (maximum, expected) => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          models: [
            {
              slug: 'gpt-6-astra',
              context_window: 272_000,
              max_context_window: maximum,
            },
          ],
        }),
        { status: 200 },
      )) as typeof fetch;
    const provider = new OpenAICodexProvider({
      credentials: { accessToken: fakeJwt('acc_99'), expiresAt: Date.now() + 3_600_000 },
      fetchImpl,
    });
    await expect(
      provider.refreshContextLimit('gpt-6-astra', {
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ maxContext: expected, source: 'provider' });
  });

  it('honours the catalog effective_context_window_percent over the 95% default', async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          models: [
            { slug: 'default-percent', context_window: 272_000 },
            {
              slug: 'explicit-percent',
              context_window: 272_000,
              effective_context_window_percent: 80,
            },
            { slug: 'bad-percent', context_window: 272_000, effective_context_window_percent: 0 },
          ],
        }),
        { status: 200 },
      )) as typeof fetch;
    const provider = new OpenAICodexProvider({
      credentials: { accessToken: fakeJwt('acc_99'), expiresAt: Date.now() + 3_600_000 },
      fetchImpl,
    });
    const signal = new AbortController().signal;

    await expect(provider.refreshContextLimit('default-percent', { signal })).resolves.toEqual({
      maxContext: 258_400, // 272_000 * 95%
      source: 'provider',
    });
    await expect(provider.refreshContextLimit('explicit-percent', { signal })).resolves.toEqual({
      maxContext: 217_600, // 272_000 * 80%
      source: 'provider',
    });
    await expect(provider.refreshContextLimit('bad-percent', { signal })).resolves.toEqual({
      maxContext: 258_400, // out-of-range percent falls back to the 95% default
      source: 'provider',
    });
  });

  it('caches context_window for five minutes, then conditionally revalidates', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-08T00:00:00Z'));
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
    ).resolves.toEqual({ maxContext: 258_400, source: 'provider' });
    await expect(
      provider.refreshContextLimit('gpt-5.6-sol', { signal: new AbortController().signal }),
    ).resolves.toEqual({ maxContext: 258_400, source: 'provider' });
    expect(calls).toHaveLength(1);

    vi.advanceTimersByTime(5 * 60_000 + 1);
    await expect(
      provider.refreshContextLimit('gpt-5.6-sol', { signal: new AbortController().signal }),
    ).resolves.toEqual({ maxContext: 258_400, source: 'provider' });

    // The backend rejects non-semver values with "Invalid client_version
    // format" — the param must always carry a real package version.
    expect(calls[0]?.url).toMatch(/\/codex\/models\?client_version=\d+\.\d+\.\d+$/);
    expect(new Headers(calls[0]?.headers).get('accept')).toBe('application/json');
    expect(new Headers(calls[0]?.headers).has('content-type')).toBe(false);
    expect(new Headers(calls[1]?.headers).get('if-none-match')).toBe('"ctx-v1"');
    vi.useRealTimers();
  });

  it('validates catalog limits and maps each slug to its usable integer ceiling', async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          models: [
            { slug: 'fractional', context_window: 272_000.75 },
            // A maximum with no default window is still a usable ceiling.
            { slug: 'max-only', context_window: 0, max_context_window: 128_000 },
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
      maxContext: 258_400,
      source: 'provider',
    });
    await expect(provider.refreshContextLimit('max-only', { signal })).resolves.toEqual({
      maxContext: 121_600, // 128_000 * 95%
      source: 'provider',
    });
    await expect(provider.refreshContextLimit('string-limit', { signal })).resolves.toBeUndefined();
    await expect(provider.refreshContextLimit('zero-limit', { signal })).resolves.toBeUndefined();
  });

  it('keeps the last verified limit and backs off after a catalog check fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-08T00:00:00Z'));
    let requestNo = 0;
    const fetchImpl = (async () => {
      requestNo += 1;
      if (requestNo === 1) {
        return new Response(
          JSON.stringify({ models: [{ slug: 'gpt-5.6-sol', context_window: 272_000 }] }),
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
    vi.advanceTimersByTime(5 * 60_000 + 1);
    await expect(provider.refreshContextLimit('gpt-5.6-sol', { signal })).resolves.toEqual({
      maxContext: 258_400,
      source: 'provider',
    });
    await expect(provider.refreshContextLimit('gpt-5.6-sol', { signal })).resolves.toEqual({
      maxContext: 258_400,
      source: 'provider',
    });
    expect(requestNo).toBe(2);
  });

  it('adopts the send ceiling, not the raw total window, on a throttled drop', async () => {
    // A throttled route publishes the TOTAL window (272000) while the backend
    // enforces sends around 255K-260K. `effective_context_window_percent` (95,
    // the catalog default) is that discount, so preflight compaction triggers
    // before the backend rejects the request.
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
      maxContext: 258_400, // 272_000 * 95%
      source: 'provider',
    });
  });

  it('keeps a small window usable rather than discounting it to nothing', async () => {
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
      maxContext: 19_000, // 20_000 * 95% — a proportional reserve, not a flat one
      source: 'provider',
    });
  });
});

describe('OpenAICodexProvider reasoning effort', () => {
  /** Fetch that answers the catalog probe, then records the responses call. */
  function catalogThenStream(
    calls: Array<Record<string, unknown>>,
    defaultReasoningLevel: string,
  ): typeof fetch {
    return (async (url: string, init?: { body?: string }) => {
      if (String(url).includes('/codex/models')) {
        return new Response(
          JSON.stringify({
            models: [
              {
                slug: 'gpt-5.6-sol',
                context_window: 272_000,
                default_reasoning_level: defaultReasoningLevel,
              },
            ],
          }),
          { status: 200 },
        );
      }
      calls.push(JSON.parse(init?.body ?? '{}') as Record<string, unknown>);
      return new Response('data: {"type":"response.completed","response":{}}\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }) as unknown as typeof fetch;
  }

  async function drain(stream: AsyncIterable<StreamEvent>): Promise<void> {
    for await (const _ of stream) {
      // consume
    }
  }

  it('adopts the model’s own catalog default rather than a blanket medium', async () => {
    // The picker recommends `low` for gpt-5.6-sol and `high` for
    // gpt-5.3-codex-spark; a single hardcoded 'medium' overrode both.
    const bodies: Array<Record<string, unknown>> = [];
    const provider = new OpenAICodexProvider({
      credentials: { accessToken: fakeJwt('acc_99'), expiresAt: Date.now() + 3_600_000 },
      fetchImpl: catalogThenStream(bodies, 'low'),
    });
    const signal = new AbortController().signal;
    await provider.refreshContextLimit('gpt-5.6-sol', { signal });
    await drain(
      provider.stream(
        { model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'hi' }] },
        { signal },
      ),
    );
    expect(bodies[0]?.['reasoning']).toEqual({ effort: 'low', summary: 'auto' });
  });

  it('lets a configured provider default beat the catalog', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const provider = new OpenAICodexProvider({
      credentials: { accessToken: fakeJwt('acc_99'), expiresAt: Date.now() + 3_600_000 },
      reasoningEffort: 'high',
      fetchImpl: catalogThenStream(bodies, 'low'),
    });
    const signal = new AbortController().signal;
    await provider.refreshContextLimit('gpt-5.6-sol', { signal });
    await drain(
      provider.stream(
        { model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'hi' }] },
        { signal },
      ),
    );
    expect(bodies[0]?.['reasoning']).toEqual({ effort: 'high', summary: 'auto' });
  });

  it('lets the request beat everything', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const provider = new OpenAICodexProvider({
      credentials: { accessToken: fakeJwt('acc_99'), expiresAt: Date.now() + 3_600_000 },
      reasoningEffort: 'high',
      fetchImpl: catalogThenStream(bodies, 'low'),
    });
    const signal = new AbortController().signal;
    await provider.refreshContextLimit('gpt-5.6-sol', { signal });
    await drain(
      provider.stream(
        {
          model: 'gpt-5.6-sol',
          messages: [{ role: 'user', content: 'hi' }],
          reasoning: { effort: 'xhigh' },
        },
        { signal },
      ),
    );
    expect(bodies[0]?.['reasoning']).toEqual({ effort: 'xhigh', summary: 'auto' });
  });

  it('falls back to medium for a model the catalog does not describe', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const provider = new OpenAICodexProvider({
      credentials: { accessToken: fakeJwt('acc_99'), expiresAt: Date.now() + 3_600_000 },
      fetchImpl: catalogThenStream(bodies, 'low'),
    });
    await drain(
      provider.stream(
        { model: 'unknown-model', messages: [{ role: 'user', content: 'hi' }] },
        { signal: new AbortController().signal },
      ),
    );
    expect(bodies[0]?.['reasoning']).toEqual({ effort: 'medium', summary: 'auto' });
  });
});

describe('CODEX_CLIENT_VERSION pin', () => {
  it('is a semver in the Codex CLI version space, decoupled from our own', async () => {
    const { CODEX_CLIENT_VERSION } = await import('../src/oauth/codex-protocol.js');
    const ours = (
      JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
        version: string;
      }
    ).version;

    // Non-semver is rejected by the backend with "Invalid client_version format".
    expect(CODEX_CLIENT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    // The pin must never be wired back to WrongStack's release number. The
    // backend reads it as an official-Codex version and gates models on
    // `minimal_client_version`; tying it to our version made the catalog we
    // receive depend on an unrelated bump in either direction.
    expect(CODEX_CLIENT_VERSION).not.toBe(ours);
  });

  it('is the only client_version definition — both call sites share it', async () => {
    const [provider, models] = await Promise.all([
      readFile(new URL('../src/openai-codex.ts', import.meta.url), 'utf8'),
      readFile(new URL('../src/oauth/codex-models.ts', import.meta.url), 'utf8'),
    ]);
    // Each used to derive its own value from package.json, and they disagreed
    // (one fell back to an invented '0.309.1'), so the login flow and the
    // running transport could be shown different catalogs.
    for (const source of [provider, models]) {
      expect(source).toContain('CODEX_CLIENT_VERSION');
      expect(source).not.toMatch(/package\.json/);
    }
  });
});

describe('OpenAICodexProvider per-model catalog policy', () => {
  interface CatalogEntry {
    slug: string;
    context_window?: number;
    default_reasoning_level?: string;
    supported_reasoning_levels?: Array<{ effort: string }>;
    input_modalities?: string[];
  }

  /** Fetch that answers the catalog probe, then records the responses body. */
  function catalogThenStream(
    bodies: Array<Record<string, unknown>>,
    models: CatalogEntry[],
  ): typeof fetch {
    return (async (url: string, init?: { body?: string }) => {
      if (String(url).includes('/codex/models')) {
        return new Response(
          JSON.stringify({
            models: models.map((m) => ({ context_window: 272_000, ...m })),
          }),
          { status: 200 },
        );
      }
      bodies.push(JSON.parse(init?.body ?? '{}') as Record<string, unknown>);
      return new Response('data: {"type":"response.completed","response":{}}\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }) as unknown as typeof fetch;
  }

  async function drain(stream: AsyncIterable<StreamEvent>): Promise<void> {
    for await (const _ of stream) {
      // consume
    }
  }

  function levels(...efforts: string[]): Array<{ effort: string }> {
    return efforts.map((effort) => ({ effort }));
  }

  async function sendWith(
    models: CatalogEntry[],
    req: Omit<Request, 'model'> & { model: string },
  ): Promise<Record<string, unknown>> {
    const bodies: Array<Record<string, unknown>> = [];
    const provider = new OpenAICodexProvider({
      credentials: { accessToken: fakeJwt('acc_99'), expiresAt: Date.now() + 3_600_000 },
      fetchImpl: catalogThenStream(bodies, models),
    });
    const signal = new AbortController().signal;
    await provider.refreshContextLimit(req.model, { signal });
    await drain(provider.stream(req, { signal }));
    return bodies[0] ?? {};
  }

  it('degrades an unsupported effort to the nearest supported one below it', async () => {
    // `max` exists on gpt-6-astra and the 5.6 family but NOT on gpt-5.5,
    // gpt-5.4-mini or gpt-5.3-codex-spark. Forwarding it spends a request to
    // earn a 400 and another on the retry.
    const body = await sendWith(
      [
        {
          slug: 'gpt-5.4-mini',
          supported_reasoning_levels: levels('low', 'medium', 'high', 'xhigh'),
        },
      ],
      {
        model: 'gpt-5.4-mini',
        messages: [{ role: 'user', content: 'hi' }],
        reasoning: { effort: 'max' },
      },
    );
    expect(body['reasoning']).toEqual({ effort: 'xhigh', summary: 'auto' });
  });

  it('passes a supported effort through untouched', async () => {
    const body = await sendWith(
      [
        {
          slug: 'gpt-6-astra',
          supported_reasoning_levels: levels('low', 'medium', 'high', 'xhigh', 'max'),
        },
      ],
      {
        model: 'gpt-6-astra',
        messages: [{ role: 'user', content: 'hi' }],
        reasoning: { effort: 'max' },
      },
    );
    expect(body['reasoning']).toEqual({ effort: 'max', summary: 'auto' });
  });

  it('takes the weakest offered level when every one is stronger than asked', async () => {
    const body = await sendWith(
      [{ slug: 'strong', supported_reasoning_levels: levels('high', 'max') }],
      {
        model: 'strong',
        messages: [{ role: 'user', content: 'hi' }],
        reasoning: { effort: 'low' },
      },
    );
    expect(body['reasoning']).toEqual({ effort: 'high', summary: 'auto' });
  });

  it('sends the requested effort when the catalog lists no levels', async () => {
    const body = await sendWith([{ slug: 'quiet-catalog' }], {
      model: 'quiet-catalog',
      messages: [{ role: 'user', content: 'hi' }],
      reasoning: { effort: 'xhigh' },
    });
    expect(body['reasoning']).toEqual({ effort: 'xhigh', summary: 'auto' });
  });

  it('omits images for a text-only model instead of earning a 400', async () => {
    const body = await sendWith([{ slug: 'gpt-5.3-codex-spark', input_modalities: ['text'] }], {
      model: 'gpt-5.3-codex-spark',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this?' },
            { type: 'image', source: { type: 'url', url: 'https://example.test/a.png' } },
          ],
        },
      ],
    });
    const input = body['input'] as Array<{ content?: Array<{ type: string; text?: string }> }>;
    const parts = input[0]?.content ?? [];
    expect(parts.map((p) => p.type)).toEqual(['input_text', 'input_text']);
    // The model is told a picture existed rather than being asked about one it
    // was never shown.
    expect(parts[1]?.text).toContain('image omitted');
  });

  it('keeps images for a model that lists the image modality', async () => {
    const body = await sendWith([{ slug: 'gpt-6-astra', input_modalities: ['text', 'image'] }], {
      model: 'gpt-6-astra',
      messages: [
        {
          role: 'user',
          content: [{ type: 'image', source: { type: 'url', url: 'https://example.test/a.png' } }],
        },
      ],
    });
    const input = body['input'] as Array<{ content?: Array<{ type: string }> }>;
    expect(input[0]?.content?.[0]?.type).toBe('input_image');
  });
});

describe('live model list', () => {
  function catalogFetch(body: unknown, onCall?: () => void): typeof fetch {
    return (async (url: string) => {
      if (String(url).includes('/codex/models')) {
        onCall?.();
        return new Response(JSON.stringify(body), { status: 200 });
      }
      return new Response('data: {"type":"response.completed","response":{}}\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }) as unknown as typeof fetch;
  }

  const CATALOG = {
    models: [
      {
        slug: 'gpt-6-astra',
        display_name: 'GPT-6-Astra',
        description: 'Our most capable model.',
        visibility: 'list',
        context_window: 272_000,
        max_context_window: 872_000,
      },
      {
        slug: 'gpt-reserve',
        display_name: 'Reserve',
        visibility: 'hide',
        context_window: 272_000,
        max_context_window: 872_000,
      },
      {
        slug: 'gpt-5.3-codex-spark',
        display_name: 'GPT-5.3-Codex-Spark',
        visibility: 'list',
        context_window: 128_000,
        max_context_window: 128_000,
      },
    ],
  };

  it('publishes the account’s picker-visible models off the catalog probe', async () => {
    // The stored list used to be written once at login and never revisited, so
    // a model that rolled out to the account later stayed invisible.
    const published: Array<Array<{ id: string; name: string; maxContext?: number | undefined }>> =
      [];
    const provider = new OpenAICodexProvider({
      credentials: { accessToken: fakeJwt('acc_99'), expiresAt: Date.now() + 3_600_000 },
      fetchImpl: catalogFetch(CATALOG),
      onModels: (models) => published.push(models),
    });
    await provider.refreshContextLimit('gpt-6-astra', { signal: new AbortController().signal });

    expect(published).toHaveLength(1);
    // `visibility: 'hide'` marks internal routes the official picker never
    // offers (gpt-reserve, codex-auto-review).
    expect(published[0]?.map((m) => m.id)).toEqual(['gpt-6-astra', 'gpt-5.3-codex-spark']);
    expect(published[0]?.[0]).toEqual({
      id: 'gpt-6-astra',
      name: 'GPT-6-Astra',
      description: 'Our most capable model.',
      maxContext: 872_000,
    });
  });

  it('still records a ceiling for a hidden model the caller names explicitly', async () => {
    const provider = new OpenAICodexProvider({
      credentials: { accessToken: fakeJwt('acc_99'), expiresAt: Date.now() + 3_600_000 },
      fetchImpl: catalogFetch(CATALOG),
    });
    await expect(
      provider.refreshContextLimit('gpt-reserve', { signal: new AbortController().signal }),
    ).resolves.toEqual({ maxContext: 828_400, source: 'provider' });
  });

  it('does not re-notify while the catalog is unchanged', async () => {
    // The catalog is re-read on a five-minute cadence; a host that persists the
    // list must not be made to rewrite config on a timer.
    let calls = 0;
    const published: unknown[] = [];
    const provider = new OpenAICodexProvider({
      credentials: { accessToken: fakeJwt('acc_99'), expiresAt: Date.now() + 3_600_000 },
      fetchImpl: catalogFetch(CATALOG, () => {
        calls += 1;
      }),
      onModels: (models) => published.push(models),
    });
    const signal = new AbortController().signal;
    await provider.refreshContextLimit('gpt-6-astra', { signal });
    await provider.refreshContextLimit('gpt-5.3-codex-spark', { signal });
    expect(calls).toBe(1);
    expect(published).toHaveLength(1);
  });
});

describe('volatile system blocks', () => {
  async function capture(system: TextBlock[]): Promise<Record<string, unknown>> {
    const bodies: Array<Record<string, unknown>> = [];
    const provider = new OpenAICodexProvider({
      credentials: { accessToken: fakeJwt('acc_99'), expiresAt: Date.now() + 3_600_000 },
      fetchImpl: (async (_url: string, init?: { body?: string }) => {
        bodies.push(JSON.parse(init?.body ?? '{}') as Record<string, unknown>);
        return new Response('data: {"type":"response.completed","response":{}}\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }) as unknown as typeof fetch,
    });
    for await (const _ of provider.stream(
      { model: 'gpt-5.4-mini', system, messages: [{ role: 'user', content: 'hi' }] },
      { signal: new AbortController().signal },
    )) {
      // drain
    }
    return bodies[0] ?? {};
  }

  it('keeps a volatile block out of instructions and puts it after the conversation', async () => {
    // The Responses wire joins every system block into one `instructions`
    // string at the head of the cached prefix. A block rebuilt each turn there
    // invalidates everything after it — which is the entire conversation.
    const body = await capture([
      { type: 'text', text: 'STABLE PROMPT' },
      markVolatileSystemBlock({ type: 'text', text: 'RECALLED THIS TURN' }),
    ]);
    expect(body['instructions']).toBe('STABLE PROMPT');
    const input = body['input'] as Array<{ role?: string; content?: Array<{ text?: string }> }>;
    // Still present, still read by the model — just last.
    expect(input[input.length - 1]).toEqual({
      role: 'user',
      content: [{ type: 'input_text', text: 'RECALLED THIS TURN' }],
    });
  });

  it('leaves an ordinary system prompt exactly where it was', async () => {
    const body = await capture([
      { type: 'text', text: 'ONE' },
      { type: 'text', text: 'TWO' },
    ]);
    expect(body['instructions']).toBe('ONE\n\nTWO');
    expect((body['input'] as unknown[]).length).toBe(1);
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
    expect(h['x-client-request-id']).toMatch(/^[0-9a-f-]{36}$/i);

    const body = JSON.parse(captured.init?.body ?? '{}');
    expect(body.store).toBe(false);
    expect(body.stream).toBe(true);
    expect(body.instructions).toBe('Be terse.');
    expect(body.input).toEqual([{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }]);
  });

  it('sends the owning session as Codex cache affinity metadata', async () => {
    const captured: Captured = {};
    const p = new OpenAICodexProvider({
      credentials: { accessToken: fakeJwt('acc_99'), expiresAt: Date.now() + 3_600_000 },
      fetchImpl: capturingFetch(COMPLETED_SSE, captured),
    });
    await p.complete(
      { ...baseReq, cache: { key: 'ws-key', sessionId: 'sess:one/two' } },
      { signal: new AbortController().signal },
    );
    expect(captured.init?.headers?.['session-id']).toBe('sess_one_two');
    expect(captured.init?.headers?.['thread-id']).toMatch(/^[0-9a-f-]{36}$/i);
    expect(captured.init?.headers?.['x-client-request-id']).toBe(
      captured.init?.headers?.['thread-id'],
    );
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

  it('omits empty instructions and unsupported generic sampling fields', async () => {
    const captured: Captured = {};
    const p = new OpenAICodexProvider({
      credentials: { accessToken: fakeJwt('acc_99'), expiresAt: Date.now() + 3_600_000 },
      fetchImpl: capturingFetch(COMPLETED_SSE, captured),
    });

    await p.complete(
      { model: 'gpt-5.6-sol', messages: baseReq.messages, temperature: 0.2, topP: 0.9 },
      { signal: new AbortController().signal },
    );

    const body = JSON.parse(captured.init?.body ?? '{}');
    expect(body).not.toHaveProperty('instructions');
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('top_p');
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
        expiresAt: Date.now() + 4 * 60_000, // inside Codex's five-minute refresh window
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
    const stop = events[1] as {
      type: 'message_stop';
      usage?: { input: number; output: number; cacheRead?: number };
    };
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
