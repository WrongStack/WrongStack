import type { ProviderApiKey, ProviderConfig } from '@wrongstack/contracts/types';
import { ProviderError } from '@wrongstack/contracts/types';

type Renewal = (credential: ProviderApiKey) => Promise<ProviderApiKey>;
export type SubscriptionRefreshTransaction = (
  providerId: string,
  source: ProviderApiKey,
  renew: Renewal,
) => Promise<ProviderApiKey>;
type ProviderMutator = (
  mutator: (providers: Record<string, ProviderConfig>) => Promise<void>,
) => Promise<void>;

let transaction: SubscriptionRefreshTransaction | undefined;

/** Hosts supply their existing encrypted-config transaction; libraries stay in-memory. */
export function setSubscriptionRefreshTransaction(
  value: SubscriptionRefreshTransaction | undefined,
): void {
  transaction = value;
}
export function hasSubscriptionRefreshTransaction(): boolean {
  return transaction !== undefined;
}

export function renewSubscriptionCredential(
  providerId: string,
  source: ProviderApiKey,
  renew: Renewal,
): Promise<ProviderApiKey> {
  return transaction ? transaction(providerId, source, renew) : renew(source);
}

/** Token pair of a provider whose refresh token is single-use (rotated on every exchange). */
export interface RotatingOAuthTokens {
  access: string;
  refresh: string;
  /** Absolute expiry, epoch ms. */
  expires: number;
}

export interface RotatingRenewalOptions<T extends RotatingOAuthTokens> {
  providerId: string;
  /** The stored account entry the provider was built from. */
  stored: ProviderApiKey;
  /** What this instance holds now; differs from disk when another process rotated. */
  accessToken: string;
  refreshToken: string;
  exchange: (refreshToken: string) => Promise<T>;
  /** Stored fields derived from a fresh token pair (e.g. the Codex account id). */
  project?: ((tokens: T, current: ProviderApiKey) => Partial<ProviderApiKey>) | undefined;
  /** Shown when the entry on disk has no refresh token left. */
  signInHint: string;
}

/**
 * Exchange a single-use refresh token inside the host transaction.
 *
 * Codex and Claude rotate the refresh token on every exchange. Renewing
 * process-locally let two processes holding the same stored pair (TUI + WebUI,
 * an editor's `wstack acp`) both spend it: the second got `invalid_grant` /
 * `refresh_token_reused` and the account needed a fresh sign-in. Under the
 * host lock the entry is re-read from disk, a pair another process already
 * rotated is adopted, and the new pair is written before the lock is released.
 *
 * Returns undefined when no host transaction is installed (library use,
 * tests); the caller then exchanges directly and persists through its own hook.
 */
export async function renewRotatingOAuthCredential<T extends RotatingOAuthTokens>(
  opts: RotatingRenewalOptions<T>,
): Promise<{ credential: ProviderApiKey; tokens: RotatingOAuthTokens } | undefined> {
  if (!transaction) return undefined;
  const credential = await transaction(
    opts.providerId,
    { ...opts.stored, apiKey: opts.accessToken, refreshToken: opts.refreshToken },
    async (current) => {
      if (!current.refreshToken)
        throw new ProviderError(opts.signInHint, 401, false, opts.providerId, { kind: 'auth' });
      const tokens = await opts.exchange(current.refreshToken);
      return {
        ...current,
        apiKey: tokens.access,
        refreshToken: tokens.refresh,
        expiresAt: new Date(tokens.expires).toISOString(),
        ...opts.project?.(tokens, current),
      };
    },
  );
  const expires = credential.expiresAt ? Date.parse(credential.expiresAt) : Number.NaN;
  return {
    credential,
    tokens: {
      access: credential.apiKey,
      refresh: credential.refreshToken ?? opts.refreshToken,
      // An entry without an expiry counts as already stale, so the next request
      // renews it again rather than trusting an invented lifetime.
      expires: Number.isFinite(expires) ? expires : Date.now(),
    },
  };
}

/** Re-read, exchange and persist under the SAME host file lock, including across processes. */
export function createSubscriptionRefreshTransaction(
  mutate: ProviderMutator,
): SubscriptionRefreshTransaction {
  return async (providerId, source, renew) => {
    let result: ProviderApiKey | undefined;
    await mutate(async (providers) => {
      const provider = Object.hasOwn(providers, providerId) ? providers[providerId] : undefined;
      const current = provider?.apiKeys?.find((key) => key.label === source.label);
      if (
        current?.authMethod !== 'oauth' ||
        current.oauthStrategyId !== source.oauthStrategyId ||
        current.oauthClientId !== source.oauthClientId ||
        current.oauthSubject !== source.oauthSubject
      ) {
        throw new ProviderError(
          `The OAuth account "${providerId}/${source.label}" changed or was removed. Select the account again.`,
          401,
          false,
          providerId,
        );
      }
      const changed =
        current.apiKey !== source.apiKey || current.refreshToken !== source.refreshToken;
      const expiry = current.expiresAt ? Date.parse(current.expiresAt) : 0;
      // A sibling already rotated this account, or the user reauthorized it.
      // An unchanged token still renews on an explicit 401 refresh.
      if (changed && Number.isFinite(expiry) && expiry > Date.now() + 60_000) {
        result = { ...current };
        return;
      }
      const renewed = await renew({ ...current });
      result = { ...renewed, label: current.label, createdAt: current.createdAt };
      provider!.apiKeys = provider!.apiKeys!.map((key) =>
        key.label === current.label ? result! : key,
      );
    });
    if (!result) throw new Error('OAuth renewal did not return a credential.');
    return result;
  };
}
