import { randomUUID } from 'node:crypto';
import type {
  ProviderAuthOutcome,
  ProviderAuthSession,
  ProviderAuthStrategy,
} from '@wrongstack/core/types';
import { generatePkce, parseAuthorizationInput, startLoopbackServer } from './shared.js';

const AUTHORIZE_URL = 'https://openrouter.ai/auth';
const KEY_EXCHANGE_URL = 'https://openrouter.ai/api/v1/auth/keys';
const API_BASE_URL = 'https://openrouter.ai/api/v1';
const CALLBACK_HOST = '127.0.0.1';

interface OpenRouterKeyResponse {
  key?: unknown;
  error?: unknown;
  message?: unknown;
}

async function exchangeOpenRouterCode(
  code: string,
  verifier: string,
  signal: AbortSignal | undefined,
  fetchImpl: typeof fetch,
): Promise<string> {
  const response = await fetchImpl(KEY_EXCHANGE_URL, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
    ...(signal ? { signal } : {}),
  });
  let body: OpenRouterKeyResponse = {};
  try {
    body = (await response.json()) as OpenRouterKeyResponse;
  } catch {
    if (response.ok) throw new Error('OpenRouter OAuth returned invalid JSON');
  }
  if (!response.ok) {
    const detail =
      typeof body.message === 'string'
        ? body.message
        : typeof body.error === 'string'
          ? body.error
          : response.statusText;
    throw new Error(`OpenRouter OAuth key exchange failed (${response.status}): ${detail}`);
  }
  if (typeof body.key !== 'string' || !body.key.trim()) {
    throw new Error('OpenRouter OAuth response carries no API key');
  }
  return body.key;
}

function outcome(apiKey: string): ProviderAuthOutcome {
  return {
    providerId: 'openrouter',
    family: 'openai-compatible',
    baseUrl: API_BASE_URL,
    models: [],
    credential: {
      label: 'oauth-default',
      apiKey,
      createdAt: new Date().toISOString(),
      authMethod: 'oauth',
      tokenType: 'bearer',
    },
  };
}

export function createOpenRouterAuthStrategy(
  fetchImpl: typeof fetch = fetch,
): ProviderAuthStrategy {
  return {
    id: 'openrouter',
    providerId: 'openrouter',
    label: 'OpenRouter',
    description: 'PKCE sign-in → user-controlled OpenRouter API key',
    aliases: ['openrouter-login', 'openrouter-oauth'],
    interactionTypes: ['browser'],
    async begin(_deps, signal): Promise<ProviderAuthSession> {
      const pkce = generatePkce();
      const callbackPath = `/oauth/callback/${randomUUID()}`;
      const server = await startLoopbackServer({
        port: 0,
        host: CALLBACK_HOST,
        path: callbackPath,
        signal,
      });
      const callbackUrl = `http://${CALLBACK_HOST}:${server.port}${callbackPath}`;
      const authorizeUrl = new URL(AUTHORIZE_URL);
      authorizeUrl.search = new URLSearchParams({
        callback_url: callbackUrl,
        code_challenge: pkce.challenge,
        code_challenge_method: 'S256',
      }).toString();

      const exchange = async (code: string, exchangeSignal?: AbortSignal) =>
        outcome(
          await exchangeOpenRouterCode(code, pkce.verifier, exchangeSignal ?? signal, fetchImpl),
        );

      return {
        strategyId: 'openrouter',
        providerId: 'openrouter',
        interaction: {
          type: 'browser',
          authorizeUrl: authorizeUrl.toString(),
          bound: server.bound,
        },
        async waitForCompletion(waitSignal) {
          if (!server.bound) return null;
          const result = await server.waitForCode();
          return result?.code ? exchange(result.code, waitSignal) : null;
        },
        async completeWithCode(input, codeSignal) {
          const parsed = parseAuthorizationInput(input);
          if (!parsed.code) throw new Error('No authorization code found in the pasted value.');
          return exchange(parsed.code, codeSignal);
        },
        close: () => server.close(),
      };
    },
  };
}
