import type {
  ProviderAuthOutcome,
  ProviderAuthSession,
  ProviderAuthStrategy,
  WireFamily,
} from '@wrongstack/contracts/types';
import { ProviderAuthRegistry } from '@wrongstack/core/registry';
import { createAntigravityAuthStrategy } from './antigravity.js';
import { createChatGPTDirectAuthStrategy } from './chatgpt-direct.js';
import { beginOAuthLogin } from './legacy.js';
import { createOpenRouterAuthStrategy } from './openrouter.js';
import {
  createKimiAuthStrategy,
  createMetaAuthStrategy,
  createXaiAuthStrategy,
} from './subscription-flows.js';
import type { BeginOAuthDeps, OAuthLoginOutcome, OAuthSession } from './types.js';

function adaptOutcome(outcome: OAuthLoginOutcome): ProviderAuthOutcome {
  return {
    providerId: outcome.providerId,
    family: outcome.family as WireFamily,
    baseUrl: outcome.baseUrl,
    models: outcome.models,
    credential: outcome.apiKey,
  };
}

function adaptSession(session: OAuthSession): ProviderAuthSession {
  const interaction = session.verificationUri
    ? {
        type: 'device_code' as const,
        verificationUri: session.verificationUri,
        userCode: session.userCode ?? '',
      }
    : {
        type: 'browser' as const,
        authorizeUrl: session.authorizeUrl ?? '',
        bound: session.bound,
      };
  return {
    strategyId: session.kind,
    providerId: session.providerId,
    interaction,
    async waitForCompletion(signal) {
      const outcome = await session.waitForCompletion(signal);
      return outcome ? adaptOutcome(outcome) : null;
    },
    async completeWithCode(input, signal) {
      return adaptOutcome(await session.completeWithCode(input, signal));
    },
    close: () => session.close(),
  };
}

export const BUILTIN_PROVIDER_AUTH_STRATEGIES: readonly ProviderAuthStrategy[] = [
  {
    id: 'chatgpt',
    providerId: 'openai-codex',
    label: 'ChatGPT',
    description: 'Plus / Pro / Team → openai-codex',
    aliases: ['openai', 'codex', 'codex-cli', 'openai-codex', 'chatgpt-plus', 'plus', 'pro'],
    interactionTypes: ['browser'],
    async begin(deps, signal) {
      return adaptSession(await beginOAuthLogin('chatgpt', deps as BeginOAuthDeps, signal));
    },
  },
  {
    id: 'copilot',
    providerId: 'github-copilot',
    label: 'GitHub Copilot',
    description: 'Copilot subscription → github-copilot',
    aliases: ['github', 'gh', 'github-copilot'],
    interactionTypes: ['device_code'],
    async begin(deps, signal) {
      return adaptSession(await beginOAuthLogin('copilot', deps as BeginOAuthDeps, signal));
    },
  },
  createOpenRouterAuthStrategy(),
  createAntigravityAuthStrategy(),
  createXaiAuthStrategy(),
  createKimiAuthStrategy(),
  createMetaAuthStrategy(),
  createChatGPTDirectAuthStrategy(),
];

/**
 * Sign-ins that were removed, by every name they used to answer to. Claude's
 * only worked by presenting WrongStack as Claude Code (its OAuth client id,
 * User-Agent and system prompt); Anthropic has no OAuth client for third-party
 * apps, so the honest routes are an API key or Claude Code itself over ACP.
 */
const RETIRED_LOGIN_ALIASES = new Set([
  'claude',
  'anthropic',
  'claude-pro',
  'claude-max',
  'anthropic-oauth',
  'max',
]);

export const RETIRED_CLAUDE_LOGIN_HINT =
  'Claude sign-in was removed: it only worked by presenting WrongStack as Claude Code. ' +
  'Use an Anthropic API key instead: `wstack auth anthropic`. On a Claude Max or Team ' +
  'plan, link a Claude Console organization under claude.ai Settings → Billing first, so ' +
  'the key draws on your monthly API credits. To run on your subscription limits, use ' +
  'Claude Code as an ACP agent (`/acp`).';

/** Guidance for a login name that no longer exists, or undefined. */
export function retiredProviderAuthLoginHint(id: string): string | undefined {
  return RETIRED_LOGIN_ALIASES.has(id.trim().toLowerCase()) ? RETIRED_CLAUDE_LOGIN_HINT : undefined;
}

export function registerBuiltinProviderAuthStrategies(registry: ProviderAuthRegistry): void {
  for (const strategy of BUILTIN_PROVIDER_AUTH_STRATEGIES) registry.register(strategy);
}

export function createBuiltinProviderAuthRegistry(): ProviderAuthRegistry {
  const registry = new ProviderAuthRegistry();
  registerBuiltinProviderAuthStrategies(registry);
  return registry;
}
