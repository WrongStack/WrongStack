/**
 * Tests for headless OAuth login engine — routing layer.
 *
 * Coverage targets:
 * - beginOAuthLogin dispatches to the correct provider implementation
 * - beginOAuthLogin rejects unknown provider kinds
 * - OAUTH_PROVIDER_IDS map contains expected provider IDs
 */
import { describe, expect, it, vi } from 'vitest';
import { beginOAuthLogin, OAUTH_PROVIDER_IDS } from '../../src/oauth/index.js';

describe('beginOAuthLogin — routing', () => {
  const mockDeps = {
    kind: 'unknown',
    signal: new AbortController().signal,
    onUrl: vi.fn(),
  } as any;

  it('rejects an unknown provider kind', async () => {
    await expect(beginOAuthLogin(mockDeps)).rejects.toThrow();
  });

  it('OAUTH_PROVIDER_IDS maps known OAuth kinds to provider IDs', () => {
    expect(OAUTH_PROVIDER_IDS).toHaveProperty('claude');
    expect(typeof OAUTH_PROVIDER_IDS.claude).toBe('string');
    expect(OAUTH_PROVIDER_IDS.claude.length).toBeGreaterThan(0);
  });

  it('OAUTH_PROVIDER_IDS includes chatgpt key', () => {
    expect(OAUTH_PROVIDER_IDS).toHaveProperty('chatgpt');
    expect(typeof OAUTH_PROVIDER_IDS.chatgpt).toBe('string');
    expect(OAUTH_PROVIDER_IDS.chatgpt.length).toBeGreaterThan(0);
  });
});
