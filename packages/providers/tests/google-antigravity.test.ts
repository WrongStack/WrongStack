/**
 * Antigravity — the Cloud Code envelope around the Gemini wire.
 *
 * The Gemini format itself is tested elsewhere and reused verbatim here, so
 * what belongs in this file is only what the envelope adds: the request
 * wrapping (including the fields Google 400s on), the response unwrapping, the
 * project bootstrap's three outcomes, and the per-model quota's inverted
 * fraction.
 *
 * Every protocol constant these tests assert is undocumented and Google's to
 * change. They are pinned deliberately: when Antigravity breaks, a failing
 * assertion naming the field is a much shorter path to the cause than an
 * opaque 400 from a `v1internal` endpoint.
 */

import { ProviderError, type Request } from '@wrongstack/contracts/types';
import { getProviderQuota, resetProviderQuota } from '@wrongstack/core/quota';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FAMILY_BY_PROVIDER_ID, SIBLING_CATALOG_BY_FAMILY } from '../src/capabilities.js';
import { retryAfterMsFromBody } from '../src/error-parse.js';
import { capabilitiesForFamily } from '../src/family-capabilities.js';
import { AntigravityProvider } from '../src/google-antigravity.js';
import { bootstrapAntigravityProject } from '../src/google-antigravity-bootstrap.js';
import { parseAntigravityModels } from '../src/google-antigravity-models.js';
import {
  ANTIGRAVITY_OAUTH_HOST,
  ANTIGRAVITY_OAUTH_SCOPES,
  antigravityBootstrapMetadata,
  antigravityUserAgent,
  buildAntigravityEnvelope,
  readAntigravityCredits,
  unwrapAntigravityPayload,
} from '../src/google-antigravity-protocol.js';
import { parseAntigravityQuota } from '../src/google-antigravity-quota.js';
import { makeProviderFromConfig } from '../src/index.js';
import {
  createAntigravityAuthStrategy,
  resolveAntigravityAuthClient,
} from '../src/oauth/antigravity.js';
import { resetSharedOAuthRefreshState } from '../src/oauth-refresh-coordinator.js';
import { PROVIDER_DEFINITIONS } from '../src/provider-definitions.js';

beforeEach(() => resetSharedOAuthRefreshState());
afterEach(() => resetProviderQuota());

describe('request envelope', () => {
  it('nests the Gemini body under `request` beside the project', () => {
    const envelope = buildAntigravityEnvelope({
      project: 'proj-1',
      model: 'gemini-3-pro',
      sessionId: 'sess-1',
      geminiBody: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
      requestId: 'req-1',
    });
    expect(envelope).toMatchObject({
      project: 'proj-1',
      requestId: 'req-1',
      model: 'gemini-3-pro',
      userAgent: 'antigravity',
      requestType: 'agent',
    });
    expect(envelope.request['contents']).toEqual([{ role: 'user', parts: [{ text: 'hi' }] }]);
    // Google groups a conversation by this; it belongs on the inner request.
    expect(envelope.request['sessionId']).toBe('sess-1');
  });

  it('strips top-level fields the envelope rejects with a 400', () => {
    // `Unknown name "output_config"` — the envelope validates strictly, and the
    // error names JSON rather than the field's owner, so this is expensive to
    // debug live and cheap to prevent here.
    const envelope = buildAntigravityEnvelope({
      project: 'p',
      model: 'm',
      sessionId: 's',
      geminiBody: {
        contents: [],
        output_config: { effort: 'high' },
        thinking: { type: 'adaptive' },
        reasoning_effort: 'high',
      },
    });
    expect(envelope.request).not.toHaveProperty('output_config');
    expect(envelope.request).not.toHaveProperty('thinking');
    expect(envelope.request).not.toHaveProperty('reasoning_effort');
    expect(envelope.request).toHaveProperty('contents');
  });

  it('sets VALIDATED function calling only when tools are declared', () => {
    const withTools = buildAntigravityEnvelope({
      project: 'p',
      model: 'm',
      sessionId: 's',
      geminiBody: { contents: [], tools: [{ functionDeclarations: [{ name: 'ls' }] }] },
    });
    expect(withTools.request['toolConfig']).toEqual({
      functionCallingConfig: { mode: 'VALIDATED' },
    });
    const without = buildAntigravityEnvelope({
      project: 'p',
      model: 'm',
      sessionId: 's',
      geminiBody: { contents: [] },
    });
    expect(without.request).not.toHaveProperty('toolConfig');
  });

  it('generates a request id when the caller supplies none', () => {
    const a = buildAntigravityEnvelope({
      project: 'p',
      model: 'm',
      sessionId: 's',
      geminiBody: {},
    });
    const b = buildAntigravityEnvelope({
      project: 'p',
      model: 'm',
      sessionId: 's',
      geminiBody: {},
    });
    expect(a.requestId).not.toBe(b.requestId);
  });
});

describe('family registration', () => {
  it('is a known provider definition, so config can resolve it', () => {
    // Without this the family type-checks but nothing can construct it: an
    // OAuth provider lives only in saved config, never in models.dev.
    expect(PROVIDER_DEFINITIONS['google-antigravity']).toMatchObject({
      family: 'google-antigravity',
      usage: 'subscription-interactive',
    });
  });

  it('resolves per-model facts through the Gemini catalog', () => {
    // Antigravity is not published in models.dev, so context windows and
    // output ceilings come from Gemini's entry for the same model id.
    expect(FAMILY_BY_PROVIDER_ID['google-antigravity']).toBe('google-antigravity');
    expect(SIBLING_CATALOG_BY_FAMILY['google-antigravity']).toBe('google');
  });

  it('constructs from a saved config through the real factory', () => {
    // The end-to-end registration check: family in the union, definition
    // present, factory arm wired. Any one missing and a signed-in user has a
    // credential nothing can turn into a provider.
    const provider = makeProviderFromConfig('google-antigravity', {
      type: 'google-antigravity',
      family: 'google-antigravity',
      apiKeys: [
        {
          label: 'oauth-default',
          apiKey: 'ya29.saved',
          createdAt: '2026-09-17T00:00:00.000Z',
          authMethod: 'oauth',
          refreshToken: 'r',
          project: 'proj-saved',
        },
      ],
      activeKey: 'oauth-default',
    });
    expect(provider).toBeInstanceOf(AntigravityProvider);
    expect(provider.id).toBe('google-antigravity');
  });

  it('takes the OAuth client from the environment when config has none', () => {
    // Sign-in reads the client from the environment; without this fallback a
    // successful login would die at its first refresh for want of a config
    // edit that nothing told the user to make.
    vi.stubEnv('WRONGSTACK_ANTIGRAVITY_CLIENT_ID', 'env-client');
    vi.stubEnv('WRONGSTACK_ANTIGRAVITY_CLIENT_SECRET', 'env-secret');
    const provider = makeProviderFromConfig('google-antigravity', {
      type: 'google-antigravity',
      family: 'google-antigravity',
      apiKey: 'ya29.saved',
    });
    expect(provider).toBeInstanceOf(AntigravityProvider);
  });

  it('has its own capability row rather than falling through', () => {
    const caps = capabilitiesForFamily('google-antigravity');
    expect(caps.streaming).toBe(true);
    expect(caps.tools).toBe(true);
    // The window is per-model (catalog), never a family guess.
    expect(caps.maxContext).toBe(0);
  });
});

describe('OAuth surface', () => {
  it('requests the five Cloud Code scopes and never `openid`', () => {
    // `openid` with PKCE routes Google into the `firstparty/nativeapp` consent
    // flow, which never redirects — the sign-in hangs with nothing to paste.
    expect(ANTIGRAVITY_OAUTH_SCOPES).toEqual([
      'https://www.googleapis.com/auth/cloud-platform',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
      'https://www.googleapis.com/auth/cclog',
      'https://www.googleapis.com/auth/experimentsandconfigs',
    ]);
    expect(ANTIGRAVITY_OAUTH_SCOPES).not.toContain('openid');
  });

  it('uses the loopback IP, not the deprecated hostname', () => {
    // Google deprecated `localhost` for native-app loopback redirects.
    expect(ANTIGRAVITY_OAUTH_HOST).toBe('127.0.0.1');
  });

  it('refuses to start without a caller-supplied OAuth client', async () => {
    // Nothing is embedded, so this is the default state — and it must say so
    // rather than open a browser at a consent screen Google will reject.
    const strategy = createAntigravityAuthStrategy(fetch, () => undefined);
    await expect(strategy.begin({}, new AbortController().signal)).rejects.toThrow(
      /WRONGSTACK_ANTIGRAVITY_CLIENT_ID/,
    );
  });

  it('refuses a pasted code that carries no state, before any token exchange', async () => {
    // Google only hands the code back on the redirect URL, which always has
    // `state`. A bare code is therefore not a legitimate paste here, and
    // accepting it left PKCE as the only binding to this login.
    const fetchImpl = vi.fn();
    const strategy = createAntigravityAuthStrategy(fetchImpl as unknown as typeof fetch, () => ({
      clientId: 'id-1',
    }));
    const session = await strategy.begin({}, new AbortController().signal);
    try {
      await expect(session.completeWithCode('4/bare-code')).rejects.toThrow(/full redirect URL/);
      await expect(
        session.completeWithCode('http://127.0.0.1/oauth-callback?code=4/x&state=forged'),
      ).rejects.toThrow(/State mismatch/);
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      session.close();
    }
  });

  it('reads the client from the environment', () => {
    expect(
      resolveAntigravityAuthClient({
        WRONGSTACK_ANTIGRAVITY_CLIENT_ID: ' id-1 ',
        WRONGSTACK_ANTIGRAVITY_CLIENT_SECRET: ' secret-1 ',
      }),
    ).toEqual({ clientId: 'id-1', clientSecret: 'secret-1' });
    expect(resolveAntigravityAuthClient({})).toBeUndefined();
  });
});

describe('client identity', () => {
  it('pins the platform token to darwin/arm64 for runtime calls', () => {
    // Not a bug: the backend expects the Mac desktop build's fingerprint, and
    // reporting the true host platform here fails.
    expect(antigravityUserAgent('9.9.9')).toBe('antigravity/ide/9.9.9 darwin/arm64');
  });

  it('reports the REAL platform in the bootstrap metadata, as enums', () => {
    // The opposite of the runtime user agent, and the asymmetry is load-bearing:
    // strings or a missing `platform` here are answered with 403.
    expect(antigravityBootstrapMetadata('win32', 'x64')).toEqual({
      ideType: 9,
      platform: 5,
      pluginType: 2,
    });
    expect(antigravityBootstrapMetadata('darwin', 'arm64').platform).toBe(2);
    expect(antigravityBootstrapMetadata('linux', 'x64').platform).toBe(3);
    expect(antigravityBootstrapMetadata('freebsd', 'x64').platform).toBe(0);
  });
});

describe('response envelope', () => {
  it('unwraps the Gemini chunk out of `response`', () => {
    const inner = { candidates: [{ content: { role: 'model', parts: [{ text: 'hi' }] } }] };
    expect(unwrapAntigravityPayload(JSON.stringify({ response: inner }))).toBe(
      JSON.stringify(inner),
    );
  });

  it('passes a top-level error through untouched', () => {
    // A failure delivered inside a 200 stream is NOT wrapped, and the Gemini
    // parser already understands that shape. Unwrapping blindly would drop it
    // and the stream would end as a silent empty turn.
    const payload = JSON.stringify({ error: { code: 429, message: 'quota' } });
    expect(unwrapAntigravityPayload(payload)).toBe(payload);
  });

  it('leaves a malformed line alone', () => {
    expect(unwrapAntigravityPayload('{"response":')).toBe('{"response":');
  });

  it('reads the credit balances that ride beside the chunk', () => {
    const credits = readAntigravityCredits(
      JSON.stringify({
        response: { candidates: [] },
        remainingCredits: [{ creditType: 'GOOGLE_ONE_AI', creditAmount: '42' }],
      }),
    );
    expect(credits).toEqual([{ creditType: 'GOOGLE_ONE_AI', creditAmount: '42' }]);
  });

  it('returns nothing when no credits are attached', () => {
    expect(readAntigravityCredits(JSON.stringify({ response: {} }))).toBeUndefined();
  });
});

describe('project bootstrap', () => {
  function jsonRes(body: unknown, ok = true): Response {
    return { ok, status: ok ? 200 : 500, json: () => Promise.resolve(body) } as unknown as Response;
  }

  it('uses the project loadCodeAssist already knows', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonRes({ cloudaicompanionProject: 'proj-7' })));
    const result = await bootstrapAntigravityProject({
      accessToken: 't',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toEqual({ ok: true, project: 'proj-7', tierId: 'legacy-tier' });
    // One call: no onboarding for an account that already has a project.
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(String((fetchImpl.mock.calls[0] as unknown as string[])[0])).toContain(
      '/v1internal:loadCodeAssist',
    );
  });

  it('accepts the project as an object as well as a bare id', async () => {
    const result = await bootstrapAntigravityProject({
      accessToken: 't',
      fetchImpl: (() =>
        Promise.resolve(
          jsonRes({ cloudaicompanionProject: { id: 'proj-obj' } }),
        )) as unknown as typeof fetch,
    });
    expect(result).toEqual({ ok: true, project: 'proj-obj', tierId: 'legacy-tier' });
  });

  it('echoes the account tier back to onboardUser', async () => {
    // Onboarding a paid account onto the free tier is the failure this avoids.
    const bodies: string[] = [];
    const fetchImpl = ((_url: string, init: { body?: string }) => {
      bodies.push(init.body ?? '');
      return Promise.resolve(
        bodies.length === 1
          ? jsonRes({ currentTier: { id: 'pro-tier' } })
          : jsonRes({ done: true, response: { cloudaicompanionProject: 'proj-9' } }),
      );
    }) as unknown as typeof fetch;
    const result = await bootstrapAntigravityProject({ accessToken: 't', fetchImpl });
    expect(result).toEqual({ ok: true, project: 'proj-9', tierId: 'pro-tier' });
    expect(JSON.parse(bodies[1] as string)).toMatchObject({ tier_id: 'pro-tier' });
  });

  it('polls while onboardUser reports an unsettled operation', async () => {
    let calls = 0;
    const fetchImpl = (() => {
      calls += 1;
      if (calls === 1) return Promise.resolve(jsonRes({}));
      if (calls === 2) return Promise.resolve(jsonRes({ done: false }));
      return Promise.resolve(jsonRes({ done: true, cloudaicompanionProject: 'proj-late' }));
    }) as unknown as typeof fetch;
    const result = await bootstrapAntigravityProject({
      accessToken: 't',
      fetchImpl,
      pollMs: 0,
    });
    expect(result).toEqual({ ok: true, project: 'proj-late', tierId: 'legacy-tier' });
  });

  it('settles immediately when aborted during a done:false poll delay', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(jsonRes({}))
        .mockResolvedValueOnce(jsonRes({ done: false }))
        .mockResolvedValue(jsonRes({ done: false }));
      const controller = new AbortController();
      const reason = new Error('caller stopped onboarding');
      const pending = bootstrapAntigravityProject({
        accessToken: 't',
        fetchImpl: fetchImpl as unknown as typeof fetch,
        signal: controller.signal,
        pollMs: 60_000,
      });
      const outcome = pending.then(
        (value) => ({ kind: 'resolved' as const, value }),
        (error: unknown) => ({ kind: 'rejected' as const, error }),
      );

      for (let i = 0; i < 12; i += 1) await Promise.resolve();
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      controller.abort(reason);
      for (let i = 0; i < 12; i += 1) await Promise.resolve();

      const immediate = await Promise.race([
        outcome,
        Promise.resolve({ kind: 'pending' as const }),
      ]);
      expect(immediate).toEqual({ kind: 'rejected', error: reason });
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it('calls a settled answer with no project BYOP, not a transient failure', async () => {
    // `done` absent entirely is Google's immediate "there is no project and I
    // will not make one". Retrying it spends requests to reach the same answer
    // while telling the user it might still work.
    let calls = 0;
    const fetchImpl = (() => {
      calls += 1;
      return Promise.resolve(jsonRes({}));
    }) as unknown as typeof fetch;
    const result = await bootstrapAntigravityProject({
      accessToken: 't',
      fetchImpl,
      pollMs: 0,
    });
    expect(result).toEqual({ ok: false, reason: 'byop_required' });
    // loadCodeAssist + exactly one onboardUser — no polling.
    expect(calls).toBe(2);
  });

  it.each(['load', 'onboard'] as const)(
    'reports malformed %s response JSON as retryable, not BYOP',
    async (stage) => {
      let calls = 0;
      const result = await bootstrapAntigravityProject({
        accessToken: 't',
        fetchImpl: async () => {
          calls += 1;
          return stage === 'load' || calls === 2 ? new Response('{broken') : Response.json({});
        },
      });
      expect(result).toEqual({ ok: false, reason: 'discovery_failed' });
      expect(calls).toBe(stage === 'load' ? 1 : 2);
    },
  );

  it.each(['load', 'onboard'] as const)(
    'reports an interrupted %s response body as retryable, not BYOP',
    async (stage) => {
      let calls = 0;
      const result = await bootstrapAntigravityProject({
        accessToken: 't',
        fetchImpl: async () => {
          calls += 1;
          if (stage === 'onboard' && calls === 1) return Response.json({});
          return new Response(
            new ReadableStream<Uint8Array>({
              pull(stream) {
                stream.error(new TypeError('body connection interrupted'));
              },
            }),
          );
        },
      });
      expect(result).toEqual({ ok: false, reason: 'discovery_failed' });
      expect(calls).toBe(stage === 'load' ? 1 : 2);
    },
  );

  it.each(['load', 'onboard'] as const)(
    'preserves cancellation during the %s response body read',
    async (stage) => {
      let calls = 0;
      const controller = new AbortController();
      const reason = new DOMException('caller cancelled body read', 'AbortError');
      const pending = bootstrapAntigravityProject({
        accessToken: 't',
        signal: controller.signal,
        fetchImpl: async () => {
          calls += 1;
          if (stage === 'onboard' && calls === 1) return Response.json({});
          return new Response(
            new ReadableStream<Uint8Array>({
              pull(stream) {
                controller.abort(reason);
                stream.error(reason);
              },
            }),
          );
        },
      });
      await expect(pending).rejects.toBe(reason);
      expect(calls).toBe(stage === 'load' ? 1 : 2);
    },
  );

  it('reports a network failure as retryable', async () => {
    const result = await bootstrapAntigravityProject({
      accessToken: 't',
      fetchImpl: (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch,
    });
    expect(result).toEqual({ ok: false, reason: 'discovery_failed' });
  });
});

describe('per-model quota', () => {
  it('inverts the remaining fraction into a used percentage', () => {
    // Antigravity is the only provider here that reports what is LEFT.
    const [snapshot] = parseAntigravityQuota('google-antigravity', {
      buckets: [
        { modelId: 'gemini-3-pro', remainingFraction: 0.25, resetTime: '2026-09-18T00:00:00Z' },
      ],
    });
    expect(snapshot?.meterId).toBe('antigravity');
    expect(snapshot?.windows[0]).toMatchObject({
      id: 'gemini-3-pro',
      usedPercent: 75,
      resetsAt: Math.floor(Date.parse('2026-09-18T00:00:00Z') / 1000),
    });
  });

  it('accepts a duration reset as well as an instant', () => {
    const now = 1_700_000_000_000;
    const [snapshot] = parseAntigravityQuota(
      'google-antigravity',
      { buckets: [{ modelId: 'm', remainingFraction: 0.5, resetTime: '3600s' }] },
      now,
    );
    expect(snapshot?.windows[0]?.resetsAt).toBe(Math.floor(now / 1000) + 3600);
  });

  it('skips a bucket that reported no fraction', () => {
    // "Not reported" is not "0% left"; rendering it either way is a lie.
    expect(parseAntigravityQuota('google-antigravity', { buckets: [{ modelId: 'm' }] })).toEqual(
      [],
    );
  });

  it('skips an unmetered bucket', () => {
    // Full allowance and no reset means it is not on a rolling window at all.
    expect(
      parseAntigravityQuota('google-antigravity', {
        buckets: [{ modelId: 'm', remainingFraction: 1 }],
      }),
    ).toEqual([]);
  });

  it('leads with the bucket closest to cutting the account off', () => {
    const [snapshot] = parseAntigravityQuota('google-antigravity', {
      buckets: [
        { modelId: 'low', remainingFraction: 0.9, resetTime: '60s' },
        { modelId: 'high', remainingFraction: 0.05, resetTime: '60s' },
      ],
    });
    expect(snapshot?.windows.map((w) => w.id)).toEqual(['high', 'low']);
  });

  it('returns nothing for a body with no buckets', () => {
    expect(parseAntigravityQuota('google-antigravity', {})).toEqual([]);
    expect(parseAntigravityQuota('google-antigravity', null)).toEqual([]);
  });
});

describe('AntigravityProvider', () => {
  const SSE = [
    'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"hi"}]}}]}}',
    '',
    'data: {"response":{"candidates":[{"content":{"role":"model","parts":[]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":1}},"remainingCredits":[{"creditType":"GOOGLE_ONE_AI","creditAmount":"7"}]}',
    '',
  ].join('\n');

  const req: Request = {
    model: 'gemini-3-pro',
    messages: [{ role: 'user', content: 'hi' }],
    maxTokens: 64,
  };

  interface Captured {
    url?: string;
    headers?: Record<string, string> | undefined;
    body?: string | undefined;
  }

  function streamingFetch(captured: Captured, quotaBody?: unknown): typeof fetch {
    const enc = new TextEncoder();
    return (async (url: string, init: { headers?: Record<string, string>; body?: string }) => {
      if (String(url).includes('retrieveUserQuota')) {
        return {
          ok: quotaBody !== undefined,
          status: 200,
          json: () => Promise.resolve(quotaBody ?? {}),
        } as unknown as Response;
      }
      captured.url = String(url);
      captured.headers = init.headers;
      captured.body = init.body;
      return new Response(
        new ReadableStream({
          pull(c) {
            c.enqueue(enc.encode(SSE));
            c.close();
          },
        }),
        { status: 200 },
      );
    }) as never as typeof fetch;
  }

  function flush(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  it('sends the envelope to the Cloud Code streaming endpoint', async () => {
    const captured: Captured = {};
    const provider = new AntigravityProvider({
      credentials: { accessToken: 'ya29.test', project: 'proj-1' },
      fetchImpl: streamingFetch(captured),
    });
    const res = await provider.complete(req, { signal: new AbortController().signal });

    expect(captured.url).toBe(
      'https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse',
    );
    expect(captured.headers?.['authorization']).toBe('Bearer ya29.test');
    expect(captured.headers?.['user-agent']).toContain('antigravity/ide/');
    const body = JSON.parse(captured.body ?? '{}') as Record<string, unknown>;
    expect(body['project']).toBe('proj-1');
    expect(body['model']).toBe('gemini-3-pro');
    // The Gemini body the preset produced, now one level down.
    expect((body['request'] as Record<string, unknown>)['contents']).toBeDefined();
    // And the response came back through the Gemini parser after unwrapping.
    expect(res.content).toEqual([{ type: 'text', text: 'hi' }]);
    expect(res.stopReason).toBe('end_turn');
  });

  it('keeps one session id across turns', async () => {
    // A fresh id per request would present every turn as a new conversation.
    const captured: Captured = {};
    const provider = new AntigravityProvider({
      credentials: { accessToken: 't', project: 'p' },
      fetchImpl: streamingFetch(captured),
    });
    await provider.complete(req, { signal: new AbortController().signal });
    const first = (JSON.parse(captured.body ?? '{}').request as Record<string, unknown>)[
      'sessionId'
    ];
    await provider.complete(req, { signal: new AbortController().signal });
    const second = (JSON.parse(captured.body ?? '{}').request as Record<string, unknown>)[
      'sessionId'
    ];
    expect(first).toBe(second);
  });

  it('records the credits the stream reported', async () => {
    const provider = new AntigravityProvider({
      credentials: { accessToken: 't', project: 'p' },
      fetchImpl: streamingFetch({}),
    });
    await provider.complete(req, { signal: new AbortController().signal });
    const credits = getProviderQuota('google-antigravity').find((s) => s.meterId === 'credits');
    expect(credits?.credits?.balance).toContain('GOOGLE_ONE_AI: 7');
  });

  it('reads the per-model quota after the turn, not before', async () => {
    const provider = new AntigravityProvider({
      credentials: { accessToken: 't', project: 'p' },
      fetchImpl: streamingFetch(
        {},
        { buckets: [{ modelId: 'gemini-3-pro', remainingFraction: 0.4, resetTime: '600s' }] },
      ),
    });
    await provider.complete(req, { signal: new AbortController().signal });
    await flush();
    const meter = getProviderQuota('google-antigravity').find((s) => s.meterId === 'antigravity');
    expect(meter?.windows[0]).toMatchObject({ id: 'gemini-3-pro', usedPercent: 60 });
  });

  it('bootstraps the project when the credential has none', async () => {
    const enc = new TextEncoder();
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => {
      seen.push(String(url));
      if (String(url).includes('loadCodeAssist')) {
        return {
          ok: true,
          status: 200,
          json: () => Promise.resolve({ cloudaicompanionProject: 'proj-boot' }),
        } as unknown as Response;
      }
      if (String(url).includes('retrieveUserQuota')) {
        return { ok: false, status: 404, json: () => Promise.resolve({}) } as unknown as Response;
      }
      return new Response(
        new ReadableStream({
          pull(c) {
            c.enqueue(enc.encode(SSE));
            c.close();
          },
        }),
        { status: 200 },
      );
    }) as never as typeof fetch;

    const discovered: string[] = [];
    const provider = new AntigravityProvider({
      credentials: { accessToken: 't' },
      fetchImpl,
      onProjectDiscovered: (p) => discovered.push(p),
    });
    await provider.complete(req, { signal: new AbortController().signal });
    expect(discovered).toEqual(['proj-boot']);
    // Bootstrap ran before the inference call, not after it.
    expect(seen[0]).toContain('loadCodeAssist');
  });

  it('bootstraps once for concurrent first requests', async () => {
    // `onboardUser` mutates account state, so two racing first turns must not
    // both try to provision.
    const enc = new TextEncoder();
    let loadCalls = 0;
    const fetchImpl = (async (url: string) => {
      if (String(url).includes('loadCodeAssist')) {
        loadCalls += 1;
        return {
          ok: true,
          status: 200,
          json: () => Promise.resolve({ cloudaicompanionProject: 'p1' }),
        } as unknown as Response;
      }
      if (String(url).includes('retrieveUserQuota')) {
        return { ok: false, status: 404, json: () => Promise.resolve({}) } as unknown as Response;
      }
      return new Response(
        new ReadableStream({
          pull(c) {
            c.enqueue(enc.encode(SSE));
            c.close();
          },
        }),
        { status: 200 },
      );
    }) as never as typeof fetch;

    const provider = new AntigravityProvider({ credentials: { accessToken: 't' }, fetchImpl });
    const signal = new AbortController().signal;
    await Promise.all([provider.complete(req, { signal }), provider.complete(req, { signal })]);
    expect(loadCalls).toBe(1);
  });

  it('fails the turn with a setup message when Google declines a project', async () => {
    const fetchImpl = (async () =>
      ({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
      }) as unknown as Response) as never as typeof fetch;
    const provider = new AntigravityProvider({ credentials: { accessToken: 't' }, fetchImpl });
    await expect(provider.complete(req, { signal: new AbortController().signal })).rejects.toThrow(
      /no Cloud Code project/i,
    );
  });

  it('explains itself when a refresh is due and no OAuth client is configured', async () => {
    // The client is not embedded, so this is a reachable state — and an opaque
    // 401 from Google would send the user looking in the wrong place.
    const provider = new AntigravityProvider({
      credentials: {
        accessToken: 'stale',
        refreshToken: 'r',
        expiresAt: Date.now() - 1_000,
        project: 'p',
      },
      fetchImpl: streamingFetch({}),
    });
    await expect(provider.complete(req, { signal: new AbortController().signal })).rejects.toThrow(
      /no OAuth client configured/i,
    );
  });

  it('sends the refreshed token, not the one it started with', async () => {
    const captured: Captured = {};
    const provider = new AntigravityProvider({
      credentials: {
        accessToken: 'stale',
        refreshToken: 'r',
        expiresAt: Date.now() - 1_000,
        project: 'p',
      },
      refreshFn: () =>
        Promise.resolve({ access: 'fresh', expires: Date.now() + 3_600_000, refresh: 'r' }),
      fetchImpl: streamingFetch(captured),
    });
    await provider.complete(req, { signal: new AbortController().signal });
    expect(captured.headers?.['authorization']).toBe('Bearer fresh');
  });

  it('refuses to build a body with no project rather than send a broken envelope', () => {
    const provider = new AntigravityProvider({ credentials: { accessToken: 't' } });
    expect(() =>
      // @ts-expect-error — exercising the guard directly; buildBody is protected.
      provider.buildBody(req, { capabilities: provider.capabilities, providerId: provider.id }),
    ).toThrow(ProviderError);
  });
});

describe('model discovery', () => {
  it('reads the model ids out of the keyed map', () => {
    // The response is an object keyed by model id, not a list.
    expect(
      parseAntigravityModels({
        models: {
          'gemini-3-pro': { quotaInfo: {} },
          'gemini-3-flash': {},
        },
      }),
    ).toEqual(['gemini-3-flash', 'gemini-3-pro']);
  });

  it('drops Google-internal models', () => {
    // These are not part of any subscription; selecting one answers 403, which
    // reads to a user as a broken login rather than a bad model choice.
    expect(
      parseAntigravityModels({
        models: { 'gemini-3-pro': {}, 'internal-eval': { isInternal: true } },
      }),
    ).toEqual(['gemini-3-pro']);
  });

  it('returns nothing for a body with no model map', () => {
    expect(parseAntigravityModels({})).toEqual([]);
    expect(parseAntigravityModels({ models: [] })).toEqual([]);
    expect(parseAntigravityModels(null)).toEqual([]);
  });
});

describe('429 reset time', () => {
  it('reads the compound duration Cloud Code states in prose', () => {
    // Antigravity sends no Retry-After header; this sentence is the only reset
    // signal, and before this pattern existed none of the three earlier ones
    // matched it — so the waiting room had nothing to park on.
    expect(
      retryAfterMsFromBody({
        message:
          'You have exhausted your capacity on this model. Your quota will reset after 2h7m23s.',
      }),
    ).toBe(2 * 3_600_000 + 7 * 60_000 + 23_000);
  });

  it('handles partial durations', () => {
    expect(retryAfterMsFromBody({ message: 'resets in 45s' })).toBe(45_000);
    expect(retryAfterMsFromBody({ message: 'quota will reset after 1h20m' })).toBe(
      3_600_000 + 20 * 60_000,
    );
    expect(retryAfterMsFromBody({ message: 'reset in 5m30s' })).toBe(5 * 60_000 + 30_000);
  });

  it('treats an explicit zero reset as no hint', () => {
    // A stated zero is a burst throttle, not a plan window. Reporting 0ms would
    // read as "retry immediately, forever"; reporting the plan default would
    // park a working account for hours. The retry policy's own backoff is right.
    expect(retryAfterMsFromBody({ message: 'capacity exhausted, reset after 0s' })).toBeUndefined();
  });

  it('still prefers an explicit retry instruction over the reset window', () => {
    // The provider telling us when to retry outranks it telling us when the
    // window refills.
    expect(
      retryAfterMsFromBody({ message: 'Quota will reset after 2h0m0s. Please retry in 30s.' }),
    ).toBe(30_000);
  });

  it('ignores a reset window beyond a day', () => {
    expect(retryAfterMsFromBody({ message: 'resets in 48h0m0s' })).toBeUndefined();
  });
});
