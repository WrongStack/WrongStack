/**
 * Google Antigravity sign-in — Google OAuth, then the Cloud Code bootstrap.
 *
 * A standard authorization-code + PKCE loopback flow against Google, with one
 * extra step no other provider in this file needs: a successful token exchange
 * is not yet a usable credential, because every Antigravity request carries a
 * Cloud Code project id. So the flow finishes by discovering (or provisioning)
 * that project and storing it on the credential.
 *
 * **The OAuth client is not embedded.** Google validates which client minted a
 * token, and the client Antigravity's own app uses is not published — obtaining
 * it means pulling it out of a proprietary binary. Shipping someone else's
 * extracted client secret in this repository is not a call we get to make on a
 * user's behalf, so the client is read from configuration:
 *
 *   WRONGSTACK_ANTIGRAVITY_CLIENT_ID      (required)
 *   WRONGSTACK_ANTIGRAVITY_CLIENT_SECRET  (required for the token exchange;
 *                                          Google's desktop clients have one)
 *
 * Without them the strategy refuses to start and says so, rather than opening
 * a browser at a consent screen that will reject the request. What a user can
 * legitimately put there — including the published Gemini CLI client, whose
 * entitlement may or may not extend to Antigravity — is documented in
 * `docs/antigravity-provider.md`.
 *
 * @module oauth/antigravity
 */

import type {
  ProviderAuthOutcome,
  ProviderAuthSession,
  ProviderAuthStrategy,
} from '@wrongstack/contracts/types';
import { bootstrapAntigravityProject } from '../google-antigravity-bootstrap.js';
import { fetchAntigravityModels } from '../google-antigravity-models.js';
import {
  ANTIGRAVITY_DEFAULT_HOST,
  ANTIGRAVITY_OAUTH_HOST,
  ANTIGRAVITY_OAUTH_SCOPES,
  antigravityUserAgent,
  GOOGLE_AUTH_URL,
  GOOGLE_TOKEN_URL,
} from '../google-antigravity-protocol.js';
import { ANTIGRAVITY_PROVIDER_ID } from '../presets/google-antigravity.js';
import { generatePkce, parseAuthorizationInput, startLoopbackServer } from './shared.js';

const CALLBACK_PATH = '/callback';

interface GoogleTokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
}

export interface AntigravityAuthClient {
  clientId: string;
  clientSecret?: string | undefined;
}

/** Read the OAuth client from the environment. */
export function resolveAntigravityAuthClient(
  env: NodeJS.ProcessEnv = process.env,
): AntigravityAuthClient | undefined {
  const clientId = env['WRONGSTACK_ANTIGRAVITY_CLIENT_ID']?.trim();
  if (!clientId) return undefined;
  const clientSecret = env['WRONGSTACK_ANTIGRAVITY_CLIENT_SECRET']?.trim();
  return { clientId, ...(clientSecret ? { clientSecret } : {}) };
}

function buildAuthorizeUrl(
  client: AntigravityAuthClient,
  redirectUri: string,
  challenge: string,
  state: string,
): string {
  const url = new URL(GOOGLE_AUTH_URL);
  url.search = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: ANTIGRAVITY_OAUTH_SCOPES.join(' '),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    // Without `offline` Google returns no refresh token, and the credential
    // would silently stop working an hour after sign-in. `consent` forces the
    // refresh token to be reissued even for an account that has already
    // approved this client — otherwise a re-login yields an access token only.
    access_type: 'offline',
    prompt: 'consent',
  }).toString();
  return url.toString();
}

async function exchangeCode(
  code: string,
  client: AntigravityAuthClient,
  redirectUri: string,
  verifier: string,
  signal: AbortSignal | undefined,
  fetchImpl: typeof fetch,
): Promise<{ accessToken: string; refreshToken: string | undefined; expiresAt: number }> {
  const body = new URLSearchParams({
    client_id: client.clientId,
    code,
    code_verifier: verifier,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  });
  if (client.clientSecret) body.set('client_secret', client.clientSecret);
  const res = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
      // The client identity is checked on the exchange too, not only on the
      // Cloud Code calls that follow it.
      'user-agent': antigravityUserAgent(),
    },
    body: body.toString(),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Google token exchange failed (${res.status}): ${text || res.statusText}`);
  }
  const json = (await res.json()) as GoogleTokenResponse;
  if (typeof json.access_token !== 'string' || json.access_token.length === 0) {
    throw new Error('Google token exchange returned no access token.');
  }
  const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : 3_600;
  return {
    accessToken: json.access_token,
    refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : undefined,
    expiresAt: Date.now() + expiresIn * 1_000,
  };
}

/**
 * Turn a fresh token into a storable credential, bootstrapping the project.
 *
 * A bootstrap failure is fatal to the sign-in on purpose. A credential with no
 * project cannot serve a single request, so storing one would turn a clear
 * "sign-in could not finish, here is why" into a provider that appears
 * connected and fails on first use.
 */
async function buildOutcome(
  tokens: { accessToken: string; refreshToken: string | undefined; expiresAt: number },
  signal: AbortSignal | undefined,
  fetchImpl: typeof fetch,
): Promise<ProviderAuthOutcome> {
  const bootstrap = await bootstrapAntigravityProject({
    accessToken: tokens.accessToken,
    fetchImpl,
    ...(signal ? { signal } : {}),
  });
  if (!bootstrap.ok) {
    throw new Error(
      bootstrap.reason === 'byop_required'
        ? 'Signed in, but this Google account has no Antigravity (Cloud Code) project and ' +
            'Google declined to create one. The account needs its own GCP project.'
        : 'Signed in, but could not reach Antigravity to determine the account project. ' +
            'Check the network and try again.',
    );
  }
  // Antigravity is not in models.dev, so this call is the only answer to "what
  // can I select". It cannot fail the sign-in: a catalog lookup is not worth
  // discarding a working credential over, and it resolves empty instead of
  // throwing.
  const models = await fetchAntigravityModels({
    accessToken: tokens.accessToken,
    project: bootstrap.project,
    fetchImpl,
    ...(signal ? { signal } : {}),
  });
  return {
    providerId: ANTIGRAVITY_PROVIDER_ID,
    family: 'google-antigravity',
    baseUrl: ANTIGRAVITY_DEFAULT_HOST,
    models,
    credential: {
      label: 'oauth-default',
      apiKey: tokens.accessToken,
      createdAt: new Date().toISOString(),
      authMethod: 'oauth',
      expiresAt: new Date(tokens.expiresAt).toISOString(),
      ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
      project: bootstrap.project,
    },
  };
}

export function createAntigravityAuthStrategy(
  fetchImpl: typeof fetch = fetch,
  resolveClient: () => AntigravityAuthClient | undefined = resolveAntigravityAuthClient,
): ProviderAuthStrategy {
  return {
    id: 'antigravity',
    providerId: ANTIGRAVITY_PROVIDER_ID,
    label: 'Google Antigravity',
    description: 'Gemini subscription via Antigravity → google-antigravity',
    aliases: ['agy', 'google-antigravity', 'gemini-subscription'],
    interactionTypes: ['browser'],
    async begin(_deps, signal): Promise<ProviderAuthSession> {
      const client = resolveClient();
      if (!client) {
        throw new Error(
          'Antigravity sign-in needs a Google OAuth client. Set ' +
            'WRONGSTACK_ANTIGRAVITY_CLIENT_ID (and _CLIENT_SECRET) — see ' +
            'docs/antigravity-provider.md for why this is not bundled.',
        );
      }
      const { verifier, challenge } = generatePkce();
      const state = generatePkce().verifier;
      // An ephemeral port: a Google desktop client accepts any loopback port,
      // so taking a free one is strictly better than contending for a fixed
      // one that another tool may already hold.
      const server = await startLoopbackServer({
        port: 0,
        host: ANTIGRAVITY_OAUTH_HOST,
        path: CALLBACK_PATH,
        expectedState: state,
        signal,
      });
      const redirectUri = `http://${ANTIGRAVITY_OAUTH_HOST}:${server.port}${CALLBACK_PATH}`;
      const authorizeUrl = buildAuthorizeUrl(client, redirectUri, challenge, state);

      const finish = async (code: string, codeSignal?: AbortSignal) => {
        const effective = codeSignal ?? signal;
        const tokens = await exchangeCode(
          code,
          client,
          redirectUri,
          verifier,
          effective,
          fetchImpl,
        );
        return buildOutcome(tokens, effective, fetchImpl);
      };

      return {
        strategyId: 'antigravity',
        providerId: ANTIGRAVITY_PROVIDER_ID,
        interaction: { type: 'browser', authorizeUrl, bound: server.bound },
        async waitForCompletion(waitSignal) {
          if (!server.bound) return null;
          const got = await server.waitForCode();
          return got?.code ? finish(got.code, waitSignal) : null;
        },
        async completeWithCode(input, codeSignal) {
          const parsed = parseAuthorizationInput(input);
          // Google only ever returns the code on the redirect URL, which always
          // carries `state` — there is no console page that shows a bare code.
          // So a paste without state is not a legitimate shape here; accepting
          // it would leave PKCE as the only thing binding the code to this
          // login. Unlike the Claude/ChatGPT strategies, require it.
          if (!parsed.state) {
            throw new Error(
              'Paste the full redirect URL (it includes the state parameter), not just the code.',
            );
          }
          if (parsed.state !== state) {
            throw new Error('State mismatch — please restart the login flow.');
          }
          if (!parsed.code) throw new Error('No authorization code found in the pasted value.');
          return finish(parsed.code, codeSignal);
        },
        close(): void {
          server.close();
        },
      };
    },
  };
}
