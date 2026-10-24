import { createHash } from 'node:crypto';
import type {
  ProviderApiKey,
  ProviderAuthOutcome,
  ProviderAuthSession,
  ProviderAuthStrategy,
} from '@wrongstack/contracts/types';
import { chatGPTHostId } from './chatgpt-host.js';
import { verifyChatGPTIdentity } from './chatgpt-identity.js';
import { oauthExpiry, oauthFailure, oauthForm, oauthSignal, requiredOAuthString } from './http.js';
import { createState, generatePkce, startLoopbackServer } from './shared.js';
import { fetchSubscriptionModels, subscriptionModelsPath } from './subscription-models.js';

const AUTHORIZE_URL = 'https://auth.openai.com/api/accounts/authorize';
const TOKEN_URL = 'https://auth.openai.com/api/accounts/oauth/token';
export const CHATGPT_DIRECT_BASE_URL = 'https://api.openai.com/v1';
const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
const SCOPE = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`;

async function directCredential(
  body: Record<string, unknown>,
  clientId: string,
  nonce: string | undefined,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
  previous?: ProviderApiKey,
  renewal = false,
): Promise<ProviderApiKey> {
  const apiKey = requiredOAuthString(body, 'access_token');
  // On renewal the server may keep (not rotate) the refresh token and may omit
  // the unchanged scope; both are then the previous ones. A sign-in has no
  // previous values, so it still requires them.
  const refreshToken =
    renewal && typeof body.refresh_token !== 'string' && previous?.refreshToken
      ? previous.refreshToken
      : requiredOAuthString(body, 'refresh_token');
  const scope =
    renewal && typeof body.scope !== 'string' && previous?.scope
      ? previous.scope
      : requiredOAuthString(body, 'scope');
  if (!scope.split(/\s+/).includes(PLAN_SCOPE))
    throw new Error('ChatGPT plan usage was not granted. Enable plan usage and sign in again.');
  const expiresAt = oauthExpiry(body);
  const idToken = typeof body.id_token === 'string' ? body.id_token : undefined;
  if (nonce !== undefined && !idToken) throw new Error('ChatGPT sign-in returned no ID token.');
  // Identity is established at sign-in (nonce-bound) and pinned in
  // `oauthSubject`. A refresh token cannot change accounts, so re-verifying on
  // renewal adds no protection -- but it ran AFTER the server had already
  // rotated the refresh token, and a JWKS blip or a few seconds of clock skew
  // threw the new pair away and forced a fresh sign-in.
  const identity =
    idToken && !renewal
      ? await verifyChatGPTIdentity(idToken, clientId, nonce, fetchImpl, signal)
      : undefined;
  if (previous?.oauthSubject && identity && previous.oauthSubject !== identity.subject) {
    throw new Error(
      'ChatGPT account changed during reauthorization. Add it as a separate account.',
    );
  }
  return {
    ...previous,
    label:
      previous?.label ??
      `oauth-${createHash('sha256').update(clientId).digest('hex').slice(0, 12)}`,
    createdAt: previous?.createdAt ?? new Date().toISOString(),
    apiKey,
    refreshToken,
    expiresAt,
    scope,
    authMethod: 'oauth',
    oauthStrategyId: 'chatgpt-api',
    oauthClientId: clientId,
    tokenType: 'bearer',
    ...(identity ? { oauthSubject: identity.subject } : {}),
    ...(idToken ? { idToken } : {}),
  };
}

export function createChatGPTDirectAuthStrategy(
  fetchImpl: typeof fetch = fetch,
  getHostId: () => Promise<string> = chatGPTHostId,
): ProviderAuthStrategy {
  return {
    id: 'chatgpt-api',
    providerId: 'openai-chatgpt',
    label: 'Continue with ChatGPT',
    description: 'ChatGPT plan usage through the public Responses API',
    aliases: ['openai-chatgpt', 'chatgpt-direct'],
    interactionTypes: ['browser'],
    notes: [
      'Authorize ChatGPT plan usage in the browser. Models and limits come from the selected ChatGPT account.',
    ],
    async begin(deps, signal): Promise<ProviderAuthSession> {
      const previous =
        deps?.credential?.oauthStrategyId === 'chatgpt-api' ? deps.credential : undefined;
      const hostId = await getHostId();
      const state = createState();
      const nonce = createState();
      const pkce = generatePkce();
      const owner = new AbortController();
      const ownedSignal = oauthSignal(
        signal ? AbortSignal.any([signal, owner.signal]) : owner.signal,
        10 * 60_000,
      );
      const server = await startLoopbackServer({
        port: 0,
        host: '127.0.0.1',
        path: '/auth/callback',
        expectedState: state,
        signal: ownedSignal,
      });
      if (!server.bound)
        throw new Error('Could not start the ChatGPT callback listener. Try sign-in again.');
      const redirectUri = `http://127.0.0.1:${server.port}/auth/callback`;
      const url = new URL(AUTHORIZE_URL);
      url.search = new URLSearchParams({
        client_id: previous?.oauthClientId ?? 'dynamic_agent_client',
        ...(!previous?.oauthClientId ? { agent_name_hint: 'WrongStack' } : {}),
        ext_agent_host_id: hostId,
        response_type: 'code',
        redirect_uri: redirectUri,
        resource: CHATGPT_DIRECT_BASE_URL,
        scope: SCOPE,
        state,
        nonce,
        code_challenge_method: 'S256',
        code_challenge: pkce.challenge,
      }).toString();
      let completion: Promise<ProviderAuthOutcome> | undefined;
      const finish = (
        callback: { code: string; state: string; clientId?: string },
        finishSignal?: AbortSignal,
      ) => {
        if (callback.state !== state) throw new Error('ChatGPT OAuth state mismatch.');
        const clientId = callback.clientId ?? previous?.oauthClientId;
        if (!clientId || clientId === 'dynamic_agent_client')
          throw new Error('ChatGPT callback returned no issued client ID.');
        if (previous?.oauthClientId && clientId !== previous.oauthClientId)
          throw new Error('ChatGPT client registration changed.');
        completion ??= (async () => {
          const effective = finishSignal
            ? AbortSignal.any([ownedSignal, finishSignal])
            : ownedSignal;
          const { response, body } = await oauthForm(
            fetchImpl,
            TOKEN_URL,
            {
              grant_type: 'authorization_code',
              client_id: clientId,
              code: callback.code,
              code_verifier: pkce.verifier,
              redirect_uri: redirectUri,
              resource: CHATGPT_DIRECT_BASE_URL,
            },
            effective,
          );
          if (!response.ok) throw oauthFailure('chatgpt-api', response.status, body);
          const credential = await directCredential(
            body,
            clientId,
            nonce,
            fetchImpl,
            effective,
            previous,
          );
          const models = await fetchSubscriptionModels(
            CHATGPT_DIRECT_BASE_URL,
            credential.apiKey,
            fetchImpl,
            effective,
            subscriptionModelsPath('chatgpt-api'),
          );
          effective.throwIfAborted();
          return {
            providerId: 'openai-chatgpt',
            family: 'openai',
            baseUrl: CHATGPT_DIRECT_BASE_URL,
            models: models?.map((model) => model.id) ?? [],
            credential,
          };
        })();
        return completion;
      };
      return {
        strategyId: 'chatgpt-api',
        providerId: 'openai-chatgpt',
        interaction: { type: 'browser', authorizeUrl: url.href, bound: true },
        async waitForCompletion(waitSignal) {
          const onAbort = () => owner.abort();
          if (waitSignal?.aborted) owner.abort();
          waitSignal?.addEventListener('abort', onAbort, { once: true });
          try {
            const callback = await server.waitForCode();
            return callback ? finish(callback, waitSignal) : null;
          } finally {
            waitSignal?.removeEventListener('abort', onAbort);
          }
        },
        async completeWithCode(input, codeSignal) {
          const callback = new URL(input.trim());
          const expected = new URL(redirectUri);
          if (
            callback.origin !== expected.origin ||
            callback.pathname !== expected.pathname ||
            callback.searchParams.get('state') !== state
          )
            throw new Error("Paste this sign-in attempt's full ChatGPT callback URL.");
          if (callback.searchParams.has('error'))
            throw new Error('ChatGPT authorization was declined.');
          const code = callback.searchParams.get('code');
          if (!code) throw new Error('ChatGPT callback has no authorization code.');
          return finish(
            {
              code,
              state,
              ...(callback.searchParams.get('client_id')
                ? { clientId: callback.searchParams.get('client_id')! }
                : {}),
            },
            codeSignal,
          );
        },
        close() {
          server.close();
          owner.abort();
        },
      };
    },
  };
}

export async function refreshChatGPTDirect(
  credential: ProviderApiKey,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<ProviderApiKey> {
  if (!credential.oauthClientId || !credential.refreshToken)
    throw new Error(
      'ChatGPT account has no client registration or renewable token. Sign in again.',
    );
  const { response, body } = await oauthForm(
    fetchImpl,
    TOKEN_URL,
    {
      grant_type: 'refresh_token',
      client_id: credential.oauthClientId,
      refresh_token: credential.refreshToken,
      resource: CHATGPT_DIRECT_BASE_URL,
    },
    signal,
  );
  if (!response.ok) throw oauthFailure('chatgpt-api', response.status, body);
  return directCredential(
    body,
    credential.oauthClientId,
    undefined,
    fetchImpl,
    signal,
    credential,
    true,
  );
}
