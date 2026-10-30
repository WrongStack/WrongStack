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
export function mcpAuthSummary(status: McpAuthStatus, now = Date.now()): string {
  const expiry =
    status.expiresAt === undefined
      ? ''
      : status.expiresAt <= now
        ? ' The access token has expired.'
        : ` The access token expires ${new Date(status.expiresAt).toLocaleString()}.`;
  const refresh = status.canRefresh ? ' It can be refreshed without signing in again.' : '';
  switch (status.state) {
    case 'authorized':
      return `Signed in${status.scopes.length ? ` with ${status.scopes.join(', ')}` : ''}.${expiry}${refresh}`;
    case 'expired':
      return `The sign-in has expired.${refresh || ' Sign in again to use this connection.'}`;
    case 'pending':
      return 'A sign-in is waiting for the browser to finish.';
    default:
      return 'Not signed in.';
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
