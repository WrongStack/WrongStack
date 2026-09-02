import type { Request } from '@wrongstack/core/types';
import { describe, expect, it, vi } from 'vitest';
import {
  type CopilotTokenResult,
  copilotBaseUrlFromToken,
  GitHubCopilotProvider,
} from '../src/github-copilot.js';

const COPILOT_TOKEN = 'tid=abc;exp=9999;proxy-ep=proxy.individual.githubcopilot.com;ssc=1';

function sseBody(events: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    pull(c) {
      c.enqueue(enc.encode(events));
      c.close();
    },
  });
}

const OPENAI_SSE = [
  'data: {"model":"gpt-4o","choices":[{"delta":{"content":"hi"},"finish_reason":null}]}',
  '',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}',
  '',
  'data: [DONE]',
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
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'hi' }],
  maxTokens: 100,
};

describe('copilotBaseUrlFromToken', () => {
  it('derives the API base from proxy-ep', () => {
    expect(copilotBaseUrlFromToken(COPILOT_TOKEN)).toBe('https://api.individual.githubcopilot.com');
  });
  it('falls back to the individual endpoint', () => {
    expect(copilotBaseUrlFromToken(undefined)).toBe('https://api.individual.githubcopilot.com');
    expect(copilotBaseUrlFromToken('no-proxy-ep')).toBe('https://api.individual.githubcopilot.com');
  });
});

describe('GitHubCopilotProvider identity', () => {
  it('exposes the correct provider id, not the inherited openai preset id', () => {
    const p = new GitHubCopilotProvider({
      credentials: { copilotToken: COPILOT_TOKEN, githubToken: 'gho_x' },
    });
    // The provider extends WireFormatProvider with openaiWireFormat, which sets
    // id='openai' in its constructor. Without the override the provider id would
    // be wrong, breaking error messages, debug logging, and consumer id checks.
    expect(p.id).toBe('github-copilot');
  });

  it('honors an explicit opts.id override', () => {
    const p = new GitHubCopilotProvider({
      credentials: { copilotToken: COPILOT_TOKEN, githubToken: 'gho_x' },
      id: 'my-copilot-alias',
    });
    expect(p.id).toBe('my-copilot-alias');
  });
});

describe('GitHubCopilotProvider request shape', () => {
  it('targets the proxy-derived base with Copilot headers', async () => {
    const captured: Captured = {};
    const p = new GitHubCopilotProvider({
      credentials: {
        copilotToken: COPILOT_TOKEN,
        githubToken: 'gho_x',
        expiresAt: Date.now() + 3_600_000,
      },
      fetchImpl: capturingFetch(OPENAI_SSE, captured),
    });
    await p.complete(baseReq, { signal: new AbortController().signal });

    expect(captured.url).toBe('https://api.individual.githubcopilot.com/chat/completions');
    const h = captured.init?.headers ?? {};
    expect(h['authorization']).toBe(`Bearer ${COPILOT_TOKEN}`);
    expect(h['Copilot-Integration-Id']).toBe('vscode-chat');
    expect(h['Editor-Version']).toBe('vscode/1.107.0');
    expect(h['X-GitHub-Api-Version']).toBe('2026-06-01');
  });
});

describe('GitHubCopilotProvider missing credentials', () => {
  it('fails with an actionable error (not a raw 401) when there is no GitHub token to mint with', async () => {
    const captured: Captured = {};
    const p = new GitHubCopilotProvider({
      credentials: {
        copilotToken: '', // no usable Copilot token
        githubToken: undefined, // ...and nothing to mint one from
        expiresAt: Date.now() - 1000,
      },
      fetchImpl: capturingFetch(OPENAI_SSE, captured),
    });
    let caught: unknown;
    try {
      await p.complete(baseReq, { signal: new AbortController().signal });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/sign in|not signed in|GitHub token/i);
    // The guard must trip BEFORE any request goes out as `Bearer <empty>`.
    expect(captured.url).toBeUndefined();
  });
});

describe('GitHubCopilotProvider token refresh', () => {
  it('mints a fresh Copilot token when expired and persists', async () => {
    const captured: Captured = {};
    const newToken = 'tid=new;proxy-ep=proxy.business.githubcopilot.com;x=1';
    const refreshFn = vi.fn(
      async (): Promise<CopilotTokenResult> => ({
        token: newToken,
        expires: Date.now() + 3_600_000,
      }),
    );
    const onRefresh = vi.fn();
    const p = new GitHubCopilotProvider({
      credentials: {
        copilotToken: COPILOT_TOKEN,
        githubToken: 'gho_x',
        expiresAt: Date.now() - 1000,
      },
      refreshFn,
      onRefresh,
      fetchImpl: capturingFetch(OPENAI_SSE, captured),
    });
    await p.complete(baseReq, { signal: new AbortController().signal });

    expect(refreshFn).toHaveBeenCalledOnce();
    expect(captured.url).toBe('https://api.business.githubcopilot.com/chat/completions');
    expect(captured.init?.headers?.['authorization']).toBe(`Bearer ${newToken}`);
    expect(onRefresh).toHaveBeenCalledWith(expect.objectContaining({ accessToken: newToken }));
  });

  it('refreshes once and retries on a 401', async () => {
    const refreshFn = vi.fn(
      async (): Promise<CopilotTokenResult> => ({
        token: COPILOT_TOKEN,
        expires: Date.now() + 3_600_000,
      }),
    );
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls === 1) return new Response('unauthorized', { status: 401 });
      return new Response(sseBody(OPENAI_SSE), { status: 200 });
    }) as never as typeof fetch;

    const p = new GitHubCopilotProvider({
      credentials: {
        copilotToken: COPILOT_TOKEN,
        githubToken: 'gho_x',
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
    let resolveRefresh!: (v: CopilotTokenResult) => void;
    const refreshFn = vi.fn(
      () =>
        new Promise<CopilotTokenResult>((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    const onRefresh = vi.fn();

    const p = new GitHubCopilotProvider({
      credentials: {
        copilotToken: COPILOT_TOKEN,
        githubToken: 'gho_x',
        expiresAt: Date.now() - 1000, // every concurrent call will hit ensureFreshToken
      },
      refreshFn,
      onRefresh,
      fetchImpl: capturingFetch(OPENAI_SSE, {}),
    });

    const signals = [new AbortController(), new AbortController(), new AbortController()];
    const requests = signals.map((c) => p.complete(baseReq, { signal: c.signal }));

    await new Promise((r) => setTimeout(r, 5));
    expect(refreshFn).toHaveBeenCalledTimes(1);

    resolveRefresh({ token: COPILOT_TOKEN, expires: Date.now() + 3_600_000 });
    await Promise.all(requests);

    expect(refreshFn).toHaveBeenCalledTimes(1);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});
