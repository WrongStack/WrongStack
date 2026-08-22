import { describe, expect, it, vi } from 'vitest';
import {
  copilotBaseUrlFromToken,
  refreshCopilotToken,
} from '../src/github-copilot-token.js';

describe('copilotBaseUrlFromToken', () => {
  it('returns default base URL for undefined token', () => {
    expect(copilotBaseUrlFromToken(undefined)).toBe(
      'https://api.individual.githubcopilot.com',
    );
  });

  it('returns default base URL for token without proxy-ep', () => {
    expect(copilotBaseUrlFromToken('just_a_token')).toBe(
      'https://api.individual.githubcopilot.com',
    );
  });

  it('derives API base from proxy-ep in token', () => {
    const token = 'foo;proxy-ep=proxy.individual.githubcopilot.com;bar';
    expect(copilotBaseUrlFromToken(token)).toBe(
      'https://api.individual.githubcopilot.com',
    );
  });

  it('rejects private hostnames (SSRF guard) and falls back to default', () => {
    const token = 'proxy-ep=proxy.internal.corp';
    expect(copilotBaseUrlFromToken(token)).toBe(
      'https://api.individual.githubcopilot.com',
    );
  });

  it('rejects proxy-ep with port number and falls back to default', () => {
    const token = 'proxy-ep=proxy.individual.githubcopilot.com:9999';
    expect(copilotBaseUrlFromToken(token)).toBe(
      'https://api.individual.githubcopilot.com',
    );
  });

  it('rejects backslash suffix bypass attempts (SEC-005) and falls back to default', () => {
    const token = 'proxy-ep=api.evil.com\\x.githubcopilot.com';
    expect(copilotBaseUrlFromToken(token)).toBe(
      'https://api.individual.githubcopilot.com',
    );
  });

  it('rejects userinfo, query params and path injection in proxy-ep', () => {
    expect(copilotBaseUrlFromToken('proxy-ep=user:pass@api.individual.githubcopilot.com')).toBe(
      'https://api.individual.githubcopilot.com',
    );
    expect(copilotBaseUrlFromToken('proxy-ep=api.individual.githubcopilot.com/evil')).toBe(
      'https://api.individual.githubcopilot.com',
    );
  });
});

describe('refreshCopilotToken', () => {
  it('throws FetchError on non-ok response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'unauthorized',
    }) as never as typeof fetch;
    vi.stubGlobal('fetch', fetchImpl);
    try {
      await expect(refreshCopilotToken('gh_token')).rejects.toThrow(
        /Copilot token request failed/,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

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
        await refreshCopilotToken('gh_token');
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

  it('throws ParseError when response is missing fields', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ token: 'abc' }), // missing expires_at
    }) as never as typeof fetch;
    vi.stubGlobal('fetch', fetchImpl);
    try {
      await expect(refreshCopilotToken('gh_token')).rejects.toThrow(
        /Copilot token response missing fields/,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('returns token and expiry on success', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ token: 'copilot-token-abc', expires_at: 2000000000 }),
    }) as never as typeof fetch;
    vi.stubGlobal('fetch', fetchImpl);
    try {
      const result = await refreshCopilotToken('gh_token');
      expect(result.token).toBe('copilot-token-abc');
      expect(result.expires).toBe(2000000000 * 1000);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('handles text() rejection gracefully for non-ok response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => { throw new Error('text failed'); },
    }) as never as typeof fetch;
    vi.stubGlobal('fetch', fetchImpl);
    try {
      await expect(refreshCopilotToken('gh_token')).rejects.toThrow(
        /Copilot token request failed/,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
