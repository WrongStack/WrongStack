import { describe, expect, it } from 'vitest';
import {
  buildClaudeAuthorizeUrl,
  buildCodexAuthorizeUrl,
  generatePkce,
  isUsableCopilotChatModel,
  OAUTH_PROVIDER_IDS,
  parseAuthorizationInput,
} from '../src/oauth/index.js';

describe('oauth engine — pkce', () => {
  it('generates a verifier and S256 challenge', () => {
    const a = generatePkce();
    const b = generatePkce();
    expect(a.verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a.challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a.verifier).not.toEqual(a.challenge);
    expect(a.verifier).not.toEqual(b.verifier); // random per call
  });
});

describe('oauth engine — authorize URLs', () => {
  it('codex authorize url carries PKCE + state + originator', () => {
    const url = new URL(buildCodexAuthorizeUrl('CHAL', 'STATE'));
    expect(url.origin).toBe('https://auth.openai.com');
    expect(url.searchParams.get('code_challenge')).toBe('CHAL');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe('STATE');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:1455/auth/callback');
    expect(url.searchParams.get('originator')).toBe('wrongstack');
  });

  it('claude authorize url reuses the verifier as state and uses :53692 callback', () => {
    const url = new URL(buildClaudeAuthorizeUrl('CHAL', 'VERIFIER'));
    expect(url.origin).toBe('https://claude.ai');
    expect(url.searchParams.get('state')).toBe('VERIFIER');
    expect(url.searchParams.get('code')).toBe('true');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:53692/callback');
  });
});

describe('oauth engine — parseAuthorizationInput', () => {
  it('parses a full redirect URL', () => {
    expect(
      parseAuthorizationInput('http://localhost:1455/auth/callback?code=abc&state=xyz'),
    ).toEqual({
      code: 'abc',
      state: 'xyz',
    });
  });
  it('parses a code#state hash form', () => {
    expect(parseAuthorizationInput('abc#xyz')).toEqual({ code: 'abc', state: 'xyz' });
  });
  it('parses a bare code', () => {
    expect(parseAuthorizationInput('justacode')).toEqual({ code: 'justacode' });
  });
  it('returns empty for blank input', () => {
    expect(parseAuthorizationInput('   ')).toEqual({});
  });
});

describe('oauth engine — copilot model filter', () => {
  const chat = {
    id: 'gpt-4o',
    capabilities: { type: 'chat', supports: { tool_calls: true } },
  };
  it('accepts a tool-calling chat model', () => {
    expect(isUsableCopilotChatModel(chat)).toBe(true);
  });
  it('rejects embeddings / non-chat', () => {
    expect(
      isUsableCopilotChatModel({ id: 'text-embedding', capabilities: { type: 'embeddings' } }),
    ).toBe(false);
  });
  it('rejects /responses-only ids', () => {
    expect(isUsableCopilotChatModel({ ...chat, supported_endpoints: ['/responses'] })).toBe(false);
  });
  it('rejects disabled-policy models', () => {
    expect(isUsableCopilotChatModel({ ...chat, policy: { state: 'disabled' } })).toBe(false);
  });
});

describe('oauth engine — provider id map', () => {
  it('maps each kind to its canonical provider id', () => {
    expect(OAUTH_PROVIDER_IDS).toEqual({
      chatgpt: 'openai-codex',
      claude: 'anthropic-oauth',
      copilot: 'github-copilot',
    });
  });
});
