export type OAuthPhase =
  | 'starting'
  | 'awaiting_browser'
  | 'awaiting_code'
  | 'exchanging'
  | 'fetching_models'
  | 'success'
  | 'error'
  | 'cancelled';
export interface OAuthAttempt {
  kind: string;
  attemptId: string;
  phase: OAuthPhase;
  [key: string]: unknown;
}
export const oauthActive = (attempt: OAuthAttempt | null) =>
  !!attempt && !['success', 'error', 'cancelled'].includes(attempt.phase);
export function acceptOAuthStatus(
  current: OAuthAttempt | null,
  status: Record<string, unknown>,
): OAuthAttempt | null {
  if (
    !oauthActive(current) ||
    !current ||
    status['kind'] !== current.kind ||
    status['attemptId'] !== current.attemptId ||
    ![
      'awaiting_browser',
      'awaiting_code',
      'exchanging',
      'fetching_models',
      'success',
      'error',
    ].includes(String(status['phase']))
  )
    return current;
  return {
    ...status,
    kind: current.kind,
    attemptId: current.attemptId,
    phase: status['phase'] as OAuthPhase,
  };
}
export function oauthUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) &&
      url.hostname &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
export function oauthAliasIssue(
  alias: string,
  existing: readonly string[],
  newAccount: boolean,
  words = {
    invalid: 'Use 1–80 letters, digits, hyphens or underscores, starting with a letter or digit.',
    exists:
      'This connection already exists. Choose a new account name or reconnect the saved account.',
  },
): string | null {
  if (
    !/^[a-z0-9][a-z0-9_-]{0,79}$/i.test(alias) ||
    ['__proto__', 'prototype', 'constructor'].includes(alias.toLowerCase())
  )
    return words.invalid;
  if (newAccount && existing.includes(alias)) return words.exists;
  return null;
}
