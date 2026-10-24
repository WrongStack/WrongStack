import type {
  ProviderApiKey,
  ProviderAuthOutcome,
  ProviderAuthSession,
  ProviderAuthStrategy,
} from '@wrongstack/contracts/types';
import { oauthFailure, oauthForm, oauthSignal, oauthSleep, requiredOAuthString } from './http.js';
import { fetchSubscriptionModels } from './subscription-models.js';

export interface DeviceSubscriptionFlow {
  strategy: Omit<ProviderAuthStrategy, 'begin'>;
  family: ProviderAuthOutcome['family'];
  baseUrl: string;
  deviceUrl: string;
  tokenUrl: string;
  clientId: string;
  scope?: string;
  deviceFields?: Record<string, string>;
  modelPath?: string;
  credential(body: Record<string, unknown>, signal: AbortSignal): Promise<ProviderApiKey>;
}

function verificationUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error('OAuth response has no verification URL.');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password)
    throw new Error('Untrusted OAuth verification URL.');
  return url.href;
}

/** Shared bounded RFC 8628 polling for xAI, Kimi and Meta. */
export function createDeviceSubscriptionStrategy(
  flow: DeviceSubscriptionFlow,
  fetchImpl: typeof fetch = fetch,
): ProviderAuthStrategy {
  return {
    ...flow.strategy,
    async begin(_deps, signal): Promise<ProviderAuthSession> {
      const owner = new AbortController();
      const ownedSignal = signal ? AbortSignal.any([signal, owner.signal]) : owner.signal;
      const start = await oauthForm(
        fetchImpl,
        flow.deviceUrl,
        {
          client_id: flow.clientId,
          ...(flow.scope ? { scope: flow.scope } : {}),
          ...flow.deviceFields,
        },
        ownedSignal,
      );
      if (!start.response.ok)
        throw oauthFailure(flow.strategy.id, start.response.status, start.body);
      const deviceCode = requiredOAuthString(start.body, 'device_code');
      const userCode = requiredOAuthString(start.body, 'user_code');
      const uri = verificationUrl(
        start.body.verification_uri_complete ?? start.body.verification_uri,
      );
      const lifetime = start.body.expires_in ?? 900;
      if (
        typeof lifetime !== 'number' ||
        !Number.isFinite(lifetime) ||
        lifetime <= 0 ||
        lifetime > 3600
      ) {
        throw new Error('OAuth response has invalid device expiry.');
      }
      const deadline = Date.now() + lifetime * 1000;
      const initialInterval = start.body.interval;
      let intervalMs =
        typeof initialInterval === 'number' &&
        Number.isFinite(initialInterval) &&
        initialInterval > 0
          ? Math.max(1000, initialInterval * 1000)
          : 5000;
      let completion: Promise<ProviderAuthOutcome | null> | undefined;
      const poll = async (waitSignal?: AbortSignal): Promise<ProviderAuthOutcome> => {
        const effective = waitSignal ? AbortSignal.any([ownedSignal, waitSignal]) : ownedSignal;
        const bounded = oauthSignal(effective, Math.max(1, deadline - Date.now()));
        while (Date.now() < deadline) {
          await oauthSleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())), bounded);
          bounded.throwIfAborted();
          if (Date.now() >= deadline) break;
          const token = await oauthForm(
            fetchImpl,
            flow.tokenUrl,
            {
              grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
              client_id: flow.clientId,
              device_code: deviceCode,
            },
            bounded,
          );
          if (token.response.ok) {
            const credential = await flow.credential(token.body, bounded);
            const models = await fetchSubscriptionModels(
              flow.baseUrl,
              credential.apiKey,
              fetchImpl,
              bounded,
              flow.modelPath,
            );
            bounded.throwIfAborted();
            return {
              providerId: flow.strategy.providerId,
              family: flow.family,
              baseUrl: flow.baseUrl,
              models: models?.map((model) => model.id) ?? [],
              credential,
            };
          }
          if (token.body.error === 'authorization_pending') continue;
          if (token.body.error === 'slow_down') {
            const reported = token.body.interval;
            intervalMs = Math.max(
              intervalMs + 5000,
              typeof reported === 'number' && Number.isFinite(reported) && reported > 0
                ? reported * 1000
                : 0,
            );
            continue;
          }
          throw oauthFailure(flow.strategy.id, token.response.status, token.body);
        }
        throw new Error('Device sign-in expired. Start sign-in again.');
      };
      return {
        strategyId: flow.strategy.id,
        providerId: flow.strategy.providerId,
        interaction: { type: 'device_code', verificationUri: uri, userCode },
        waitForCompletion(waitSignal) {
          completion ??= poll(waitSignal);
          return completion;
        },
        async completeWithCode() {
          throw new Error('Approve this device code in your browser; no redirect paste is needed.');
        },
        close() {
          owner.abort();
        },
      };
    },
  };
}
