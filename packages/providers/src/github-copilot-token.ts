import { FetchError, ParseError } from '@wrongstack/core/types';

// Copilot token minting + API-base derivation, split out of github-copilot.ts
// so the oauth entry (oauth/copilot.ts) can mint tokens without bundling the
// whole Copilot provider.

const COPILOT_TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token';
export const COPILOT_HEADERS: Record<string, string> = {
  'User-Agent': 'GitHubCopilotChat/0.35.0',
  'Editor-Version': 'vscode/1.107.0',
  'Editor-Plugin-Version': 'copilot-chat/0.35.0',
  'Copilot-Integration-Id': 'vscode-chat',
};
const DEFAULT_API_BASE = 'https://api.individual.githubcopilot.com';

/**
 * Allowed hostname suffixes for the Copilot `proxy-ep` token field.
 * Any other hostname (including IPs, private ranges, or unrelated domains)
 * is rejected and the default API base is used instead.
 * This prevents a malicious token with a crafted `proxy-ep` from redirecting
 * Copilot API traffic to an attacker-controlled server (SSRF).
 */
const SAFE_PROXY_EP_SUFFIXES = ['.githubcopilot.com'] as const;

/** Derive the Copilot API base URL from a Copilot token's `proxy-ep` field.
 *  Rejects hostnames that are not public Copilot endpoints (SSRF guard). */
export function copilotBaseUrlFromToken(token: string | undefined): string {
  if (token) {
    const m = token.match(/proxy-ep=([^;]+)/);
    if (m?.[1]) {
      const raw = m[1].replace(/^proxy\./, 'api.');
      try {
        const u = new URL(`https://${raw}`);
        const hostname = u.hostname.toLowerCase();
        if (
          SAFE_PROXY_EP_SUFFIXES.some((s) => hostname.endsWith(s)) &&
          !hostname.includes(':') &&
          !u.port &&
          (u.pathname === '/' || u.pathname === '') &&
          !u.search &&
          !u.username &&
          !u.password
        ) {
          return u.origin;
        }
      } catch {
        // invalid URL
      }
      // Unknown or private hostname — fall back to default rather than follow.
    }
  }
  return DEFAULT_API_BASE;
}

export interface CopilotTokenResult {
  /** The short-lived Copilot token (the access token used for chat). */
  token: string;
  /** Absolute expiry in epoch milliseconds. */
  expires: number;
}

/** Mint a fresh Copilot token from the long-lived GitHub OAuth token. */
export async function refreshCopilotToken(
  githubToken: string,
  signal?: AbortSignal,
): Promise<CopilotTokenResult> {
  const res = await fetch(COPILOT_TOKEN_URL, {
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${githubToken}`,
      ...COPILOT_HEADERS,
    },
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
      : AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // Preserve the real status: FetchError derives `recoverable` from it
    // (429/5xx → true). Hardcoding 401 marked every transient blip (503, 429)
    // as a non-recoverable auth failure, so callers dropped credentials and
    // forced a re-login instead of retrying.
    throw new FetchError({
      message: `Copilot token request failed (${res.status}): ${text || res.statusText}`,
      status: res.status,
      context: { provider: 'github-copilot' },
    });
  }
  const json = (await res.json()) as { token?: string; expires_at?: number } | null;
  if (!json?.token || typeof json.expires_at !== 'number') {
    throw new ParseError({
      message: 'Copilot token response missing fields',
      source: 'github-copilot',
    });
  }
  return { token: json.token, expires: json.expires_at * 1000 };
}
