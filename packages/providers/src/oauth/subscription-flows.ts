import type { ProviderApiKey, ProviderAuthStrategy } from '@wrongstack/contracts/types';
import { createDeviceSubscriptionStrategy } from './device-code.js';
import {
  oauthExpiry,
  oauthFailure,
  oauthForm,
  oauthRequest,
  oauthSignal,
  oauthSleep,
  requiredOAuthString,
} from './http.js';

// Public native-client identifiers, matching the device protocols used by Pi.
// These are client identifiers, not credentials or client secrets.
const XAI_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
const KIMI_CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098';
const META_CLIENT_ID = '1031625952748946';
const XAI_TOKEN_URL = 'https://auth.x.ai/oauth2/token';
const KIMI_TOKEN_URL = 'https://auth.kimi.ai/api/oauth/token';
const META_KEY_URL = 'https://api.meta.ai/muse-code/key';

function tokenCredential(
  strategyId: string,
  body: Record<string, unknown>,
  previous?: ProviderApiKey,
): ProviderApiKey {
  return {
    ...previous,
    label: previous?.label ?? 'oauth-default',
    createdAt: previous?.createdAt ?? new Date().toISOString(),
    apiKey: requiredOAuthString(body, 'access_token'),
    refreshToken:
      body.refresh_token === undefined && previous?.refreshToken
        ? previous.refreshToken
        : requiredOAuthString(body, 'refresh_token'),
    expiresAt: oauthExpiry(body, strategyId === 'xai' ? 3600 : undefined),
    authMethod: 'oauth',
    oauthStrategyId: strategyId,
    tokenType: 'bearer',
    ...(typeof body.scope === 'string' ? { scope: body.scope } : {}),
  };
}

async function mintMetaKey(
  identityToken: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
  previous?: ProviderApiKey,
): Promise<ProviderApiKey> {
  const { response, body } = await oauthRequest(fetchImpl, META_KEY_URL, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: `Bearer ${identityToken}`,
      'x-api-version': '1.0.0',
    },
    body: '{}',
    signal: oauthSignal(signal),
  });
  if (!response.ok) throw oauthFailure('meta', response.status, body);
  return {
    ...previous,
    label: previous?.label ?? 'oauth-default',
    createdAt: previous?.createdAt ?? new Date().toISOString(),
    apiKey: requiredOAuthString(body, 'api_key'),
    refreshToken: identityToken,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    authMethod: 'oauth',
    oauthStrategyId: 'meta',
    tokenType: 'bearer',
  };
}

export function createXaiAuthStrategy(fetchImpl: typeof fetch = fetch): ProviderAuthStrategy {
  return createDeviceSubscriptionStrategy(
    {
      strategy: {
        id: 'xai',
        providerId: 'xai',
        label: 'xAI / Grok',
        description: 'Sign in with SuperGrok or X Premium',
        aliases: ['grok', 'xai-oauth'],
        interactionTypes: ['device_code'],
      },
      family: 'openai-compatible',
      baseUrl: 'https://api.x.ai/v1',
      deviceUrl: 'https://auth.x.ai/oauth2/device/code',
      tokenUrl: XAI_TOKEN_URL,
      clientId: XAI_CLIENT_ID,
      scope: 'openid profile email offline_access grok-cli:access api:access',
      deviceFields: { referrer: 'wrongstack' },
      modelPath: 'language-models',
      credential: async (body) => tokenCredential('xai', body),
    },
    fetchImpl,
  );
}

export function createKimiAuthStrategy(fetchImpl: typeof fetch = fetch): ProviderAuthStrategy {
  return createDeviceSubscriptionStrategy(
    {
      strategy: {
        id: 'kimi',
        providerId: 'kimi-for-coding',
        label: 'Kimi Code',
        description: 'Kimi Code account via device sign-in',
        aliases: ['kimi-coding', 'kimi-code', 'kimi-for-coding'],
        interactionTypes: ['device_code'],
      },
      family: 'anthropic',
      baseUrl: 'https://api.kimi.com/coding/v1',
      deviceUrl: 'https://auth.kimi.ai/api/oauth/device_authorization',
      tokenUrl: KIMI_TOKEN_URL,
      clientId: KIMI_CLIENT_ID,
      credential: async (body) => tokenCredential('kimi', body),
    },
    fetchImpl,
  );
}

export function createMetaAuthStrategy(fetchImpl: typeof fetch = fetch): ProviderAuthStrategy {
  return createDeviceSubscriptionStrategy(
    {
      strategy: {
        id: 'meta',
        providerId: 'meta',
        label: 'Meta / Muse',
        description: 'Meta account → Model API access',
        aliases: ['muse', 'meta-oauth'],
        interactionTypes: ['device_code'],
        notes: [
          'Meta controls eligibility and billing for the minted Model API key; sign-in alone does not guarantee subscription access.',
        ],
      },
      family: 'openai-compatible',
      baseUrl: 'https://api.meta.ai/v1',
      deviceUrl: 'https://auth.meta.com/oidc/device/authorization/',
      tokenUrl: 'https://auth.meta.com/oidc/device/token/',
      clientId: META_CLIENT_ID,
      credential: (body, signal) =>
        mintMetaKey(requiredOAuthString(body, 'access_token'), fetchImpl, signal),
    },
    fetchImpl,
  );
}

/** The refresh contract returns a complete replacement account credential. */
export async function refreshDeviceSubscription(
  credential: ProviderApiKey,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<ProviderApiKey> {
  const strategy = credential.oauthStrategyId;
  if (!credential.refreshToken)
    throw new Error(`${strategy} has no renewable session. Sign in again.`);
  if (strategy === 'meta')
    return mintMetaKey(credential.refreshToken, fetchImpl, signal, credential);
  if (strategy !== 'kimi' && strategy !== 'xai')
    throw new Error(`Unknown device subscription: ${strategy}`);
  const bounded = oauthSignal(signal);
  for (let attempt = 0; ; attempt++) {
    const { response, body } = await oauthForm(
      fetchImpl,
      strategy === 'kimi' ? KIMI_TOKEN_URL : XAI_TOKEN_URL,
      {
        grant_type: 'refresh_token',
        client_id: strategy === 'kimi' ? KIMI_CLIENT_ID : XAI_CLIENT_ID,
        refresh_token: credential.refreshToken,
      },
      bounded,
    );
    if (response.ok) return tokenCredential(strategy, body, credential);
    if (strategy === 'kimi' && attempt < 3 && (response.status === 429 || response.status >= 500)) {
      await oauthSleep(1000 * 2 ** attempt, bounded);
      continue;
    }
    throw oauthFailure(strategy, response.status, body);
  }
}
