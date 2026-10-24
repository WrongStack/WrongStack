import type {
  Capabilities,
  Provider,
  ProviderApiKey,
  ProviderContextLimit,
  Request,
  StreamEvent,
} from '@wrongstack/contracts/types';
import { ConfigError, ProviderError } from '@wrongstack/contracts/types';
import { getProxyConfig, rewriteBaseUrl } from '@wrongstack/core/wiring/proxy-rewrite';
import { aggregateStream } from './aggregate.js';
import { AnthropicProvider } from './anthropic.js';
import { capabilitiesForFamily } from './family-capabilities.js';
import { refreshChatGPTDirect } from './oauth/chatgpt-direct.js';
import { refreshDeviceSubscription } from './oauth/subscription-flows.js';
import { fetchSubscriptionModels, subscriptionModelsPath } from './oauth/subscription-models.js';
import { OAuthRefreshCoordinator } from './oauth-refresh-coordinator.js';
import { OpenAIResponsesProvider } from './openai-responses.js';
import type { OAuthRefreshedTokens, ProviderLiveModel } from './provider-account-types.js';
import {
  hasSubscriptionRefreshTransaction,
  renewSubscriptionCredential,
} from './subscription-refresh-store.js';

export const SUBSCRIPTION_ENDPOINTS: Readonly<Record<string, string>> = {
  xai: 'https://api.x.ai/v1',
  kimi: 'https://api.kimi.com/coding/v1',
  meta: 'https://api.meta.ai/v1',
  'chatgpt-api': 'https://api.openai.com/v1',
};

export interface SubscriptionOAuthOptions {
  id: string;
  credential: ProviderApiKey;
  baseUrl?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
  headers?: Record<string, string> | undefined;
  onRefresh?: ((tokens: OAuthRefreshedTokens) => void) | undefined;
  onModels?: ((models: ProviderLiveModel[], credential: ProviderApiKey) => void) | undefined;
}

/** Renewable account auth composed with the existing Messages/Responses transports. */
export class SubscriptionOAuthProvider implements Provider {
  readonly id: string;
  readonly capabilities: Capabilities;
  private credential: ProviderApiKey;
  private inner: Provider;
  private readonly coordinator: OAuthRefreshCoordinator<ProviderApiKey, OAuthRefreshedTokens>;
  private readonly opts: SubscriptionOAuthOptions;
  private readonly endpoint: string;
  private models: ProviderLiveModel[] | undefined;
  private checkedAt = 0;

  constructor(opts: SubscriptionOAuthOptions) {
    this.opts = opts;
    this.id = opts.id;
    this.credential = { ...opts.credential };
    const strategy = this.credential.oauthStrategyId;
    const defaultEndpoint =
      strategy && Object.hasOwn(SUBSCRIPTION_ENDPOINTS, strategy)
        ? SUBSCRIPTION_ENDPOINTS[strategy]
        : undefined;
    if (!defaultEndpoint || this.credential.authMethod !== 'oauth')
      throw new ConfigError({
        message: 'Unknown subscription OAuth credential.',
        code: 'CONFIG_INVALID',
      });
    // Tokens may use the host's enabled WrongProxy route, but the upstream
    // must still be an exact official endpoint. A /proxy/ path alone is no trust proof.
    const requestedEndpoint = opts.baseUrl?.replace(/\/+$/, '');
    const endpoint = requestedEndpoint ?? defaultEndpoint;
    const allowedEndpoints =
      strategy === 'kimi' ? [defaultEndpoint, 'https://api.kimi.ai/coding/v1'] : [defaultEndpoint];
    const proxy = getProxyConfig();
    const usesConfiguredProxy =
      proxy.enabled &&
      proxy.active &&
      !!proxy.url &&
      allowedEndpoints.some((official) => rewriteBaseUrl(official, proxy.url) === endpoint);
    if (!allowedEndpoints.includes(endpoint) && !usesConfiguredProxy)
      throw new ConfigError({
        message: `OAuth account "${opts.id}" must use ${allowedEndpoints.join(' or ')}. Add an API-key profile for another endpoint.`,
        code: 'CONFIG_INVALID',
      });
    this.endpoint = endpoint;
    this.assertPermission();
    this.capabilities = capabilitiesForFamily(strategy === 'kimi' ? 'anthropic' : 'openai', {
      reasoning: true,
    });
    this.inner = this.transport();
    this.coordinator = new OAuthRefreshCoordinator<ProviderApiKey, OAuthRefreshedTokens>({
      label: `Subscription OAuth ${strategy}`,
      initialRefreshKey: this.credential.refreshToken,
      initialExpiresAt: this.credential.expiresAt
        ? Date.parse(this.credential.expiresAt)
        : undefined,
      hooks: {
        refreshFn: async (refreshToken, signal) => {
          try {
            return await renewSubscriptionCredential(
              this.id,
              { ...this.credential, refreshToken },
              (current) =>
                strategy === 'chatgpt-api'
                  ? refreshChatGPTDirect(current, opts.fetchImpl, signal)
                  : refreshDeviceSubscription(current, opts.fetchImpl, signal),
            );
          } catch (error) {
            if (error instanceof ProviderError && error.providerId !== this.id) {
              throw new ProviderError(error.message, error.status, error.retryable, this.id, {
                body: error.body,
                kind: error.kind,
                cause: error,
              });
            }
            throw error;
          }
        },
        projectTokens: (credential) => ({
          accessToken: credential.apiKey,
          refreshKey: credential.refreshToken,
          expiresAt: Date.parse(credential.expiresAt!),
        }),
        applyTokens: (_derived, credential) => {
          this.credential = { ...credential };
          this.assertPermission();
          this.inner = this.transport();
        },
        formatPayload: (credential) => {
          return {
            accessToken: credential.apiKey,
            refreshToken: credential.refreshToken,
            expiresAt: Date.parse(credential.expiresAt!),
            scope: credential.scope,
            idToken: credential.idToken,
            oauthClientId: credential.oauthClientId,
            oauthSubject: credential.oauthSubject,
          };
        },
        onRefresh: (payload) => {
          if (!hasSubscriptionRefreshTransaction()) opts.onRefresh?.(payload);
        },
      },
    });
  }

  private assertPermission(): void {
    if (
      this.credential.oauthStrategyId === 'chatgpt-api' &&
      !this.credential.scope?.split(/\s+/).includes('chatgpt.tokens.use.direct')
    ) {
      throw new ProviderError(
        'ChatGPT plan usage is not enabled. Sign in with chatgpt-api and authorize plan usage.',
        403,
        false,
        this.id,
      );
    }
  }

  private transport(): Provider {
    return this.credential.oauthStrategyId === 'kimi'
      ? new AnthropicProvider({
          id: this.id,
          apiKey: this.credential.apiKey,
          baseUrl: this.endpoint,
          fetchImpl: this.opts.fetchImpl,
        })
      : new OpenAIResponsesProvider({
          id: this.id,
          apiKey: this.credential.apiKey,
          baseUrl: this.endpoint,
          fetchImpl: this.opts.fetchImpl,
          headers: this.opts.headers,
          store: false,
          ...(this.credential.oauthStrategyId === 'chatgpt-api'
            ? { replayReasoning: true, chatGPTPlan: true }
            : {}),
        });
  }

  async *stream(req: Request, opts: { signal: AbortSignal }): AsyncIterable<StreamEvent> {
    await this.coordinator.ensureFreshToken(opts.signal);
    this.assertPermission();
    let emitted = false;
    try {
      for await (const event of this.inner.stream(req, opts)) {
        emitted = true;
        yield event;
      }
    } catch (error) {
      if (
        emitted ||
        !(error instanceof ProviderError) ||
        error.status !== 401 ||
        !this.credential.refreshToken
      )
        throw error;
      await this.coordinator.doRefresh(opts.signal);
      this.assertPermission();
      yield* this.inner.stream(req, opts);
    }
  }

  complete(req: Request, opts: { signal: AbortSignal }) {
    return aggregateStream(this.stream(req, opts));
  }

  /** Host-only post-turn quota reads must use the rotated token, not the construction snapshot. */
  get accountQuotaToken(): string {
    return this.credential.apiKey;
  }

  get chatGPTQuotaClientId(): string | undefined {
    return this.credential.oauthStrategyId === 'chatgpt-api'
      ? this.credential.oauthClientId
      : undefined;
  }

  /** Catalog probes use the same renewal and durable host transaction as inference. */
  async refreshAccountCredential(opts: { signal: AbortSignal }): Promise<ProviderApiKey> {
    await this.coordinator.ensureFreshToken(opts.signal);
    return { ...this.credential };
  }

  async refreshContextLimit(
    model: string,
    opts: { signal: AbortSignal },
  ): Promise<ProviderContextLimit | undefined> {
    await this.coordinator.ensureFreshToken(opts.signal);
    if (Date.now() - this.checkedAt >= 5 * 60_000) {
      const models = await fetchSubscriptionModels(
        this.endpoint,
        this.credential.apiKey,
        this.opts.fetchImpl,
        opts.signal,
        subscriptionModelsPath(this.credential.oauthStrategyId),
      );
      this.checkedAt = Date.now();
      if (models !== undefined) {
        this.models = models;
        this.opts.onModels?.(models, { ...this.credential });
      }
    }
    const entry = this.models?.find((item) => item.id === model);
    return entry?.maxContext ? { maxContext: entry.maxContext, source: 'provider' } : undefined;
  }
}
