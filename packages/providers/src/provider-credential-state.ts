import {
  type Provider,
  type ProviderApiKey,
  type ProviderConfig,
  ProviderError,
} from '@wrongstack/contracts/types';
import { isExternalRefreshPlaceholder } from './external-credential-refresh.js';

/** A host-renewed account's in-memory placeholder is no refresh token at all. */
function storedRefreshToken(value: string | undefined): string | undefined {
  return isExternalRefreshPlaceholder(value) ? undefined : value;
}

export function unavailableProviderCredentials(
  id: string,
  capabilities: Provider['capabilities'],
  message = `The auth profile "${id}" changed or was removed. Configure its credentials or select another account.`,
): Provider {
  const failure = () => new ProviderError(message, 401, false, id, { kind: 'auth' });
  return {
    id,
    capabilities,
    complete: async (_request, { signal }) => {
      signal.throwIfAborted();
      throw failure();
    },
    stream: (_request, { signal }) => ({
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          signal.throwIfAborted();
          throw failure();
        },
      }),
    }),
  };
}

/**
 * A provider whose memory-only HQ key has not arrived, or lapsed (see
 * leased-credentials). A request first asks for the lease and waits for it
 * (`whenLeased` resolves the real provider, or undefined when none came in
 * time), so the first request of a fresh process does not lose the race with
 * the lease fetch; without one it fails, never with another key.
 */
export function awaitingLeaseProvider(
  id: string,
  capabilities: Provider['capabilities'],
  whenLeased?: (signal: AbortSignal) => Promise<Provider | undefined>,
): Provider {
  const missing = unavailableProviderCredentials(
    id,
    capabilities,
    `"${id}" uses a key HQ leases to this machine in memory only, and no lease is held right now. Check that HQ is reachable; it is asked again shortly.`,
  );
  if (!whenLeased) return missing;
  let real: Provider | undefined;
  const ready = async (signal: AbortSignal): Promise<Provider> => {
    real ??= await whenLeased(signal);
    signal.throwIfAborted();
    return real ?? missing;
  };
  return {
    id,
    capabilities,
    complete: async (request, context) => (await ready(context.signal)).complete(request, context),
    stream: (request, context) => ({
      [Symbol.asyncIterator]: () => {
        let inner: AsyncIterator<unknown> | undefined;
        return {
          next: async () => {
            inner ??= (await ready(context.signal))
              .stream(request, context)
              [Symbol.asyncIterator]();
            return inner.next();
          },
          return: async (value?: unknown) =>
            (await inner?.return?.(value)) ?? { done: true as const, value },
        };
      },
    }),
  } as Provider;
}

type CredentialSource = {
  label?: string | undefined;
  accessToken: string;
  refreshToken?: string | undefined;
};
type RefreshedCredential = {
  accessToken: string;
  refreshToken?: string | undefined;
  expiresAt: number;
  accountId?: string | undefined;
  scope?: string | undefined;
  idToken?: string | undefined;
  oauthClientId?: string | undefined;
  oauthSubject?: string | undefined;
};

function credentialKeys(config: ProviderConfig): ProviderApiKey[] {
  if (config.apiKeys?.length) return config.apiKeys.map((key) => ({ ...key }));
  return config.apiKey ? [{ label: 'default', apiKey: config.apiKey, createdAt: '' }] : [];
}
function matches(key: ProviderApiKey, source: CredentialSource): boolean {
  return (
    (source.label === undefined || key.label === source.label) &&
    key.apiKey === source.accessToken &&
    key.refreshToken === storedRefreshToken(source.refreshToken)
  );
}
export function matchesActiveProviderCredential(
  config: ProviderConfig,
  source: CredentialSource,
): boolean {
  const keys = credentialKeys(config);
  const active = keys.find((key) => key.label === config.activeKey) ?? keys[0];
  return !!active && matches(active, source);
}

/** Persist only the credential that started this rotation, preserving selection. */
export function applyProviderOAuthRefresh(
  config: ProviderConfig,
  creds: RefreshedCredential,
  source?: CredentialSource,
): boolean {
  const keys = credentialKeys(config);
  const key = source
    ? keys.find((key) => matches(key, source))
    : (keys.find((key) => key.label === config.activeKey) ?? keys[0]);
  if (!key) return false;
  key.apiKey = creds.accessToken;
  const refreshToken = storedRefreshToken(creds.refreshToken);
  if (refreshToken !== undefined) key.refreshToken = refreshToken;
  key.expiresAt = new Date(creds.expiresAt).toISOString();
  if (creds.accountId) key.accountId = creds.accountId;
  if (creds.scope !== undefined) key.scope = creds.scope;
  if (creds.idToken !== undefined) key.idToken = creds.idToken;
  if (creds.oauthClientId !== undefined) key.oauthClientId = creds.oauthClientId;
  if (creds.oauthSubject !== undefined) key.oauthSubject = creds.oauthSubject;
  config.apiKeys = keys;
  delete config.apiKey;
  if (!keys.some((key) => key.label === config.activeKey)) config.activeKey = keys[0]!.label;
  return true;
}
