import { ProviderAuthRegistry } from '@wrongstack/core/registry';
import type {
  ProviderAuthOutcome,
  ProviderAuthSession,
  ProviderAuthStrategy,
  WireFamily,
} from '@wrongstack/core/types';
import { beginOAuthLogin } from './legacy.js';
import { createOpenRouterAuthStrategy } from './openrouter.js';
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
    id: 'claude',
    providerId: 'anthropic-oauth',
    label: 'Claude',
    description: 'Pro / Max → anthropic-oauth',
    aliases: ['anthropic', 'claude-pro', 'claude-max', 'anthropic-oauth', 'max'],
    interactionTypes: ['browser'],
    async begin(deps, signal) {
      return adaptSession(await beginOAuthLogin('claude', deps as BeginOAuthDeps, signal));
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
];

export function registerBuiltinProviderAuthStrategies(registry: ProviderAuthRegistry): void {
  for (const strategy of BUILTIN_PROVIDER_AUTH_STRATEGIES) registry.register(strategy);
}

export function createBuiltinProviderAuthRegistry(): ProviderAuthRegistry {
  const registry = new ProviderAuthRegistry();
  registerBuiltinProviderAuthStrategies(registry);
  return registry;
}
