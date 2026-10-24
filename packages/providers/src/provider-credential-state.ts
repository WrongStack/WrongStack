import {
  type Provider,
  type ProviderApiKey,
  type ProviderConfig,
  ProviderError,
} from '@wrongstack/contracts/types';

export function unavailableProviderCredentials(
  id: string,
  capabilities: Provider['capabilities'],
): Provider {
  const failure = () =>
    new ProviderError(
      `The auth profile "${id}" changed or was removed. Configure its credentials or select another account.`,
      401,
      false,
      id,
      { kind: 'auth' },
    );
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
    key.refreshToken === source.refreshToken
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
  if (creds.refreshToken !== undefined) key.refreshToken = creds.refreshToken;
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
