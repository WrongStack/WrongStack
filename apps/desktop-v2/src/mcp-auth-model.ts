import { displayDateTime } from './display-dates';
import { record } from './engine-values';

export interface McpAuthStatus {
  state: 'not_authorized' | 'pending' | 'authorized' | 'expired';
  expiresAt?: number | undefined;
  scopes: string[];
  canRefresh: boolean;
}

const STATES = ['not_authorized', 'pending', 'authorized', 'expired'] as const;

/** The non-secret `mcp.auth.status` reply; null when the engine sent something else. */
export function mcpAuthStatus(value: unknown): McpAuthStatus | null {
  const row = record(value);
  const state = row['state'];
  if (!STATES.includes(state as McpAuthStatus['state'])) return null;
  return {
    state: state as McpAuthStatus['state'],
    ...(typeof row['expiresAt'] === 'number' ? { expiresAt: row['expiresAt'] } : {}),
    scopes: Array.isArray(row['scopes']) ? row['scopes'].map(String) : [],
    canRefresh: row['canRefresh'] === true,
  };
}

/** One line describing the stored authorization. */
/** English wording of the summary; the desktop passes the display-language catalog. */
const AUTH_WORDS = {
  signedIn: 'Signed in.',
  signedInWith: 'Signed in with {{scopes}}.',
  tokenExpired: 'The access token has expired.',
  tokenExpires: 'The access token expires {{at}}.',
  refreshable: 'It can be refreshed without signing in again.',
  expired: 'The sign-in has expired.',
  signInAgain: 'Sign in again to use this connection.',
  pending: 'A sign-in is waiting for the browser to finish.',
  none: 'Not signed in.',
} as const;
export type McpAuthWord = keyof typeof AUTH_WORDS;
export type McpAuthSay = (word: McpAuthWord, values?: Record<string, string>) => string;
const english: McpAuthSay = (word, values = {}) =>
  AUTH_WORDS[word].replace(/\{\{(\w+)\}\}/g, (_, name: string) => values[name] ?? '');

export function mcpAuthSummary(
  status: McpAuthStatus,
  now = Date.now(),
  say: McpAuthSay = english,
): string {
  const expiry =
    status.expiresAt === undefined
      ? []
      : [
          status.expiresAt <= now
            ? say('tokenExpired')
            : say('tokenExpires', { at: displayDateTime(status.expiresAt) }),
        ];
  const refresh = status.canRefresh ? [say('refreshable')] : [];
  switch (status.state) {
    case 'authorized':
      return [
        status.scopes.length
          ? say('signedInWith', { scopes: status.scopes.join(', ') })
          : say('signedIn'),
        ...expiry,
        ...refresh,
      ].join(' ');
    case 'expired':
      return [say('expired'), ...(refresh.length ? refresh : [say('signInAgain')])].join(' ');
    case 'pending':
      return say('pending');
    default:
      return say('none');
  }
}

/** Only an https authorization page (or a loopback http one) is opened in the browser. */
export function safeAuthorizationUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    return url.protocol === 'https:' || (url.protocol === 'http:' && loopback) ? url.href : null;
  } catch {
    return null;
  }
}

/** Space- or comma-separated scopes, without blanks or repeats. */
export function mcpAuthScopes(value: string): string[] {
  return [...new Set(value.split(/[\s,]+/).filter(Boolean))].slice(0, 64);
}
