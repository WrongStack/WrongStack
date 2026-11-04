import { describe, expect, it } from 'vitest';
import {
  acceptOAuthStatus,
  type OAuthAttempt,
  oauthAliasIssue,
  oauthUrl,
} from '../src/oauth-model';

describe('subscription sign-in ownership', () => {
  it('ignores missing/foreign and superseded same-service attempts and freezes terminal states', () => {
    const current: OAuthAttempt = { kind: 'chatgpt', attemptId: 'second', phase: 'starting' };
    for (const status of [
      { kind: 'chatgpt', phase: 'success' },
      { kind: 'chatgpt', attemptId: 'first', phase: 'success' },
      { kind: 'other', attemptId: 'second', phase: 'success' },
    ])
      expect(acceptOAuthStatus(current, status)).toBe(current);
    const waiting = acceptOAuthStatus(current, {
      kind: 'chatgpt',
      attemptId: 'second',
      phase: 'awaiting_browser',
      authorizeUrl: 'https://example.test',
    })!;
    expect(waiting.phase).toBe('awaiting_browser');
    const cancelled = { ...waiting, phase: 'cancelled' as const };
    expect(acceptOAuthStatus(cancelled, { ...waiting, phase: 'success' })).toBe(cancelled);
    const success = acceptOAuthStatus(waiting, { ...waiting, phase: 'success' })!;
    expect(acceptOAuthStatus(success, waiting)).toBe(success);
  });
  it('validates aliases and explicit browser URLs', () => {
    expect(oauthAliasIssue('work-account', [], true)).toBeNull();
    expect(oauthAliasIssue('work', ['work'], true)).toContain('already exists');
    expect(oauthAliasIssue('work', ['work'], false)).toBeNull();
    expect(oauthAliasIssue('work', ['work'], true, { invalid: 'bad name', exists: 'taken' })).toBe(
      'taken',
    );
    for (const value of ['', '../outside', '__proto__', 'constructor'])
      expect(oauthAliasIssue(value, [], true)).not.toBeNull();
    expect(oauthUrl('https://example.test/login?state=fixture')).toBe(
      'https://example.test/login?state=fixture',
    );
    for (const value of [
      'javascript:alert(1)',
      'file:///secret',
      'https://name:password@example.test',
    ])
      expect(oauthUrl(value)).toBeNull();
  });
});
