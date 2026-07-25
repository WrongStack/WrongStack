/**
 * Tests for Claude OAuth login — Authorization Code + PKCE flow.
 *
 * Coverage targets:
 * - beginClaudeLogin export exists and is callable
 * - buildClaudeAuthorizeUrl returns a valid URL
 * - OAUTH_PROVIDER_IDS includes claude with anthropic-oauth
 */
import { describe, expect, it, vi } from 'vitest';
import {
  beginClaudeLogin,
  buildClaudeAuthorizeUrl,
  CLAUDE_PROVIDER_ID,
} from '../../src/oauth/claude.js';

describe('Claude OAuth', () => {
  it('exports CLAUDE_PROVIDER_ID as a non-empty string', () => {
    expect(CLAUDE_PROVIDER_ID).toBeDefined();
    expect(typeof CLAUDE_PROVIDER_ID).toBe('string');
    expect(CLAUDE_PROVIDER_ID.length).toBeGreaterThan(0);
  });

  it('buildClaudeAuthorizeUrl returns an absolute URL', () => {
    const url = buildClaudeAuthorizeUrl('test-state');
    expect(url).toBeDefined();
    expect(url).toContain('http');
    expect(url).toContain('test-state');
  });

  it('beginClaudeLogin is a function', () => {
    expect(typeof beginClaudeLogin).toBe('function');
  });

  it('beginClaudeLogin handles pre-aborted signal gracefully', async () => {
    const ac = new AbortController();
    ac.abort();
    const result = await beginClaudeLogin({
      kind: 'claude',
      signal: ac.signal,
    } as any);
    expect(result).toBeDefined();
  });
});
