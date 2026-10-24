import { ProviderError } from '@wrongstack/contracts/types';

export type OAuthJson = Record<string, unknown>;

export function oauthSignal(signal?: AbortSignal, timeoutMs = 30_000): AbortSignal {
  return signal
    ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
}

export async function oauthRequest(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<{ response: Response; body: OAuthJson }> {
  const response = await fetchImpl(url, { ...init, redirect: 'error' });
  const parsed: unknown = await response.json().catch(() => undefined);
  const body =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as OAuthJson) : {};
  return { response, body };
}

export async function oauthForm(
  fetchImpl: typeof fetch,
  url: string,
  fields: Record<string, string>,
  signal?: AbortSignal,
) {
  return oauthRequest(fetchImpl, url, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
    signal: oauthSignal(signal),
  });
}

export function oauthFailure(provider: string, status: number, body: OAuthJson): ProviderError {
  // Do not include raw token responses or descriptions that can echo secrets.
  const code =
    typeof body.error === 'string' && /^[a-z0-9_.-]{1,100}$/i.test(body.error)
      ? body.error
      : 'oauth_failed';
  const invalidSession = [
    'invalid_grant',
    'invalid_refresh_token',
    'refresh_token_expired',
    'refresh_token_invalidated',
    'refresh_token_reused',
  ].includes(code);
  return new ProviderError(
    `${provider} sign-in/token renewal failed (${status}, ${code}).${
      status === 401 || status === 403 || invalidSession ? ' Sign in again.' : ''
    }`,
    status,
    !invalidSession && (status === 429 || status >= 500),
    provider,
    { body: { code }, ...(invalidSession ? { kind: 'auth' as const } : {}) },
  );
}

export function requiredOAuthString(body: OAuthJson, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`OAuth response is missing ${key}.`);
  return value;
}

export function oauthExpiry(body: OAuthJson, fallbackSeconds?: number): string {
  const seconds = body.expires_in ?? fallbackSeconds;
  if (
    typeof seconds !== 'number' ||
    !Number.isFinite(seconds) ||
    seconds <= 0 ||
    seconds > 31_536_000
  ) {
    throw new Error('OAuth response has invalid expires_in.');
  }
  return new Date(Date.now() + seconds * 1000).toISOString();
}

export function oauthSleep(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
