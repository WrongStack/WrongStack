import type { Request } from '@wrongstack/core/types';
import { describe, expect, it, vi } from 'vitest';
import {
  AnthropicOAuthProvider,
  type AnthropicOAuthTokens,
  CLAUDE_CODE_SYSTEM_PROMPT,
  refreshAnthropicOAuthToken,
} from '../src/anthropic-oauth.js';

function sseBody(events: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    pull(c) {
      c.enqueue(enc.encode(events));
      c.close();
    },
  });
}

const ANTHROPIC_SSE = [
  'event: message_start',
  'data: {"type":"message_start","message":{"model":"anthropic-test-model","usage":{"input_tokens":5,"output_tokens":0}}}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}',
  '',
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":0}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
].join('\n');

interface Captured {
  url?: string;
  init?: { headers?: Record<string, string>; body?: string };
}

function capturingFetch(body: string, captured: Captured, status = 200): typeof fetch {
  return (async (url: string, init: { headers?: Record<string, string>; body?: string }) => {
    captured.url = url;
    captured.init = init;
    return new Response(status >= 200 && status < 300 ? sseBody(body) : 'err', { status });
  }) as never as typeof fetch;
}

const baseReq: Request = {
  model: 'anthropic-test-model',
  system: [{ type: 'text', text: 'Be terse.' }],
  messages: [{ role: 'user', content: 'hi' }],
  maxTokens: 100,
};

describe('AnthropicOAuthProvider request shape', () => {
  it('uses Bearer + OAuth beta headers and the Claude Code system block', async () => {
    const captured: Captured = {};
    const p = new AnthropicOAuthProvider({
      credentials: { accessToken: 'sk-ant-oat-XYZ', expiresAt: Date.now() + 3_600_000 },
      fetchImpl: capturingFetch(ANTHROPIC_SSE, captured),
    });
    await p.complete(baseReq, { signal: new AbortController().signal });

    const h = captured.init?.headers ?? {};
    expect(h['authorization']).toBe('Bearer sk-ant-oat-XYZ');
    expect(h['x-api-key']).toBeUndefined();
    expect(h['anthropic-beta']).toContain('oauth-2025-04-20');
    expect(h['anthropic-beta']).toContain('claude-code-20250219');
    expect(h['anthropic-version']).toBe('2023-06-01');

    const body = JSON.parse(captured.init?.body ?? '{}');
    expect(body.system[0]).toEqual({ type: 'text', text: CLAUDE_CODE_SYSTEM_PROMPT });
    expect(body.system[1]).toEqual({ type: 'text', text: 'Be terse.' });
  });

  it('caps cache breakpoints to 4 on the wire after prepending the identity block', async () => {
    const captured: Captured = {};
    const p = new AnthropicOAuthProvider({
      credentials: { accessToken: 'sk-ant-oat-XYZ', expiresAt: Date.now() + 3_600_000 },
      fetchImpl: capturingFetch(ANTHROPIC_SSE, captured),
    });
    // Six ephemeral markers — over Anthropic's ceiling of 4. The OAuth override
    // runs super.buildBody (which caps), then prepends the marker-less identity
    // block, so the wire must still carry ≤4 breakpoints.
    const system = Array.from({ length: 6 }, (_, i) => ({
      type: 'text' as const,
      text: `block-${i}`,
      cache_control: { type: 'ephemeral' as const },
    }));
    await p.complete({ ...baseReq, system }, { signal: new AbortController().signal });
    const body = JSON.parse(captured.init?.body ?? '{}');
    const markers = (body.system as Array<Record<string, unknown>>).filter(
      (b) => b['cache_control'],
    );
    expect(markers.length).toBe(4);
    // Identity block is still prepended and carries no breakpoint of its own.
    expect(body.system[0]).toEqual({ type: 'text', text: CLAUDE_CODE_SYSTEM_PROMPT });
  });

  it('does not duplicate the identity block when already present', async () => {
    const captured: Captured = {};
    const p = new AnthropicOAuthProvider({
      credentials: { accessToken: 'sk-ant-oat-XYZ', expiresAt: Date.now() + 3_600_000 },
      fetchImpl: capturingFetch(ANTHROPIC_SSE, captured),
    });
    await p.complete(
      { ...baseReq, system: [{ type: 'text', text: CLAUDE_CODE_SYSTEM_PROMPT }] },
      { signal: new AbortController().signal },
    );
    const body = JSON.parse(captured.init?.body ?? '{}');
    expect(body.system).toHaveLength(1);
  });
});

describe('AnthropicOAuthProvider token refresh', () => {
  it('refreshes a near-expired token before the request and persists', async () => {
    const captured: Captured = {};
    const refreshFn = vi.fn(
      async (): Promise<AnthropicOAuthTokens> => ({
        access: 'sk-ant-oat-NEW',
        refresh: 'r2',
        expires: Date.now() + 3_600_000,
      }),
    );
    const onRefresh = vi.fn();
    const p = new AnthropicOAuthProvider({
      credentials: {
        accessToken: 'sk-ant-oat-OLD',
        refreshToken: 'r1',
        expiresAt: Date.now() - 1000,
      },
      refreshFn,
      onRefresh,
      fetchImpl: capturingFetch(ANTHROPIC_SSE, captured),
    });
    await p.complete(baseReq, { signal: new AbortController().signal });

    expect(refreshFn).toHaveBeenCalledOnce();
    expect(captured.init?.headers?.['authorization']).toBe('Bearer sk-ant-oat-NEW');
    expect(onRefresh).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: 'sk-ant-oat-NEW', refreshToken: 'r2' }),
    );
  });

  it('refreshes once and retries on a 401', async () => {
    const refreshFn = vi.fn(
      async (): Promise<AnthropicOAuthTokens> => ({
        access: 'sk-ant-oat-NEW',
        refresh: 'r2',
        expires: Date.now() + 3_600_000,
      }),
    );
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls === 1) return new Response('unauthorized', { status: 401 });
      return new Response(sseBody(ANTHROPIC_SSE), { status: 200 });
    }) as never as typeof fetch;

    const p = new AnthropicOAuthProvider({
      credentials: {
        accessToken: 'sk-ant-oat-OLD',
        refreshToken: 'r1',
        expiresAt: Date.now() + 3_600_000,
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
    let resolveRefresh!: (v: AnthropicOAuthTokens) => void;
    const refreshFn = vi.fn(
      () =>
        new Promise<AnthropicOAuthTokens>((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    const onRefresh = vi.fn();

    const p = new AnthropicOAuthProvider({
      credentials: {
        accessToken: 'sk-ant-oat-OLD',
        refreshToken: 'r1',
        expiresAt: Date.now() - 1000, // every concurrent call will hit ensureFreshToken
      },
      refreshFn,
      onRefresh,
      fetchImpl: capturingFetch(ANTHROPIC_SSE, {}),
    });

    const signals = [new AbortController(), new AbortController(), new AbortController()];
    const requests = signals.map((c) => p.complete(baseReq, { signal: c.signal }));

    await new Promise((r) => setTimeout(r, 5));
    expect(refreshFn).toHaveBeenCalledTimes(1);

    resolveRefresh({ access: 'sk-ant-oat-NEW', refresh: 'r2', expires: Date.now() + 3_600_000 });
    await Promise.all(requests);

    expect(refreshFn).toHaveBeenCalledTimes(1);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});

describe('refreshAnthropicOAuthToken', () => {
  it('preserves the real status so transient (5xx/429) refresh failures stay recoverable', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => 'service unavailable',
    }) as never as typeof fetch;
    vi.stubGlobal('fetch', fetchImpl);
    try {
      let caught: unknown;
      try {
        await refreshAnthropicOAuthToken('rt');
      } catch (err) {
        caught = err;
      }
      // A 503 must not masquerade as a 401 auth failure — it stays recoverable
      // so callers retry instead of dropping credentials and forcing re-login.
      expect((caught as { status?: number }).status).toBe(503);
      expect((caught as { recoverable?: boolean }).recoverable).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('returns tokens on success', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 3600,
      }),
    }) as never as typeof fetch;
    vi.stubGlobal('fetch', fetchImpl);
    try {
      const result = await refreshAnthropicOAuthToken('rt');
      expect(result.access).toBe('new-access');
      expect(result.refresh).toBe('new-refresh');
      expect(result.expires).toBeGreaterThan(Date.now());
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('AnthropicOAuthProvider Claude Code camouflage', () => {
  it('sends a claude-cli User-Agent + x-app header', async () => {
    const captured: Captured = {};
    const p = new AnthropicOAuthProvider({
      credentials: { accessToken: 'sk-ant-oat-XYZ', expiresAt: Date.now() + 3_600_000 },
      fetchImpl: capturingFetch(ANTHROPIC_SSE, captured),
    });
    await p.complete(baseReq, { signal: new AbortController().signal });
    const h = captured.init?.headers ?? {};
    expect(h['user-agent']).toMatch(/^claude-cli\//);
    expect(h['x-app']).toBe('cli');
    expect(h['anthropic-dangerous-direct-browser-access']).toBe('true');
  });

  it('canonicalizes tool names on the wire and maps tool_use back', async () => {
    const captured: Captured = {};
    const toolSse = [
      'event: message_start',
      'data: {"type":"message_start","message":{"model":"anthropic-test-model","usage":{"input_tokens":5,"output_tokens":0}}}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"Read","input":{}}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"x\\"}"}}',
      '',
      'event: content_block_stop',
      'data: {"type":"content_block_stop","index":0}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":1}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
    ].join('\n');

    const p = new AnthropicOAuthProvider({
      credentials: { accessToken: 'sk-ant-oat-XYZ', expiresAt: Date.now() + 3_600_000 },
      fetchImpl: capturingFetch(toolSse, captured),
    });
    const req: Request = {
      model: 'anthropic-test-model',
      messages: [{ role: 'user', content: 'read x' }],
      maxTokens: 100,
      tools: [{ name: 'read', description: 'read a file', inputSchema: { type: 'object' } }],
    };
    const res = await p.complete(req, { signal: new AbortController().signal });

    // Wire: tool presented to Anthropic as Claude Code's "Read".
    const body = JSON.parse(captured.init?.body ?? '{}');
    expect(body.tools[0].name).toBe('Read');
    // Back: the returned tool_use is mapped to the caller's real "read".
    const toolUse = res.content.find((b) => b.type === 'tool_use');
    expect(toolUse).toMatchObject({ type: 'tool_use', name: 'read' });
  });
});
