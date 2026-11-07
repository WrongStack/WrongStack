import { describe, expect, it } from 'vitest';
import { oauthFailure } from '../../src/oauth/http.js';

describe('OAuth failure descriptions shown by provider tests', () => {
  it.each([
    'invalid_grant',
    'invalid_refresh_token',
    'refresh_token_expired',
    'refresh_token_invalidated',
    'refresh_token_reused',
  ])('preserves safe reauthentication guidance for %s returned as HTTP 400', (code) => {
    const error = oauthFailure('chatgpt-api', 400, {
      error: code,
      error_description: 'never-display-this-refresh-token',
    });
    expect(error.kind).toBe('auth');
    expect(error.retryable).toBe(false);
    expect(error.describe()).toContain('auth failed (400)');
    expect(error.describe()).toContain(code);
    expect(error.describe()).toContain('Sign in again.');
    expect(error.describe()).not.toContain('never-display-this-refresh-token');
  });

  it('retains retryable transient failures without suggesting an account reset', () => {
    const error = oauthFailure('chatgpt-api', 503, {
      error: 'server_error',
      error_description: 'never-display-this-access-token',
    });
    expect(error.retryable).toBe(true);
    expect(error.describe()).toContain('server_error');
    expect(error.describe()).not.toMatch(/Sign in again|auth failed|never-display/);
  });

  it('does not reflect unsafe OAuth error codes or response descriptions', () => {
    const error = oauthFailure('chatgpt-api', 400, {
      error: 'unsafe error with a token',
      error_description: 'never-display-this-id-token',
    });
    expect(error.describe()).toContain('oauth_failed');
    expect(error.describe()).not.toMatch(/unsafe error|never-display/);
  });
});
