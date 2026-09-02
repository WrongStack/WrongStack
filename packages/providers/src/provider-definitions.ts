import { TRUSTED_PROVIDER_PRESETS } from './trusted-presets.js';
import type { ProviderCatalogMetadata, ProviderDefinition } from './provider-definition-types.js';

export type {
  ProviderCatalogMetadata,
  ProviderDefinition,
  OpenAICompatiblePolicyId,
  ProviderReferral,
  ProviderUsage,
} from './provider-definition-types.js';

const CORE_PROVIDER_DEFINITIONS: readonly ProviderDefinition[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    family: 'openai',
    envVars: ['OPENAI_API_KEY'],
    models: [],
    usage: 'metered-api',
    docsUrl: 'https://platform.openai.com/api-keys',
    catalog: {
      description: 'GPT, o-series, and Codex models',
      icon: '🤖',
      color: 'from-success/12 to-success/5 border-success/30 hover:border-success/50',
      keyPlaceholder: 'sk-...',
    },
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    family: 'anthropic',
    envVars: ['ANTHROPIC_API_KEY'],
    models: [],
    usage: 'metered-api',
    docsUrl: 'https://console.anthropic.com/settings/keys',
    catalog: {
      description: 'Claude model access',
      icon: '🧠',
      color: 'from-warning/12 to-warning/5 border-warning/30 hover:border-warning/50',
      keyPlaceholder: 'sk-ant-...',
    },
  },
  {
    id: 'google',
    name: 'Google',
    family: 'google',
    envVars: ['GOOGLE_GENERATIVE_AI_API_KEY', 'GEMINI_API_KEY'],
    models: [],
    usage: 'metered-api',
    docsUrl: 'https://aistudio.google.com/apikey',
    catalog: {
      description: 'Gemini Pro, Flash, and Nano',
      icon: '✨',
      color: 'from-info/12 to-info/5 border-info/30 hover:border-info/50',
      keyPlaceholder: 'AIza...',
    },
  },
  {
    id: 'openai-codex',
    name: 'OpenAI Codex OAuth',
    family: 'openai-codex',
    envVars: [],
    models: [],
    usage: 'subscription-interactive',
    docsUrl: 'https://developers.openai.com/codex/',
  },
  {
    id: 'anthropic-oauth',
    name: 'Anthropic OAuth',
    family: 'anthropic-oauth',
    envVars: [],
    models: [],
    usage: 'subscription-interactive',
    docsUrl: 'https://docs.anthropic.com/',
  },
  {
    id: 'github-copilot',
    name: 'GitHub Copilot',
    family: 'github-copilot',
    envVars: [],
    models: [],
    usage: 'subscription-interactive',
    docsUrl: 'https://docs.github.com/en/copilot',
  },
  {
    id: 'opencode-go',
    name: 'OpenCode Go',
    family: 'openai-compatible',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    envVars: ['OPENCODE_API_KEY'],
    models: [],
    usage: 'subscription-interactive',
    docsUrl: 'https://opencode.ai/go?ref=6VZAER87H4',
    catalog: {
      description:
        'Global hosted API for 75+ LLM providers — stable access from US, EU, and Singapore',
      icon: '🌍',
      color: 'from-success/12 to-success/5 border-success/30 hover:border-success/50',
      keyPlaceholder: 'oc-...',
      referral: {
        code: '6VZAER87H4',
        reward: 'Support the project by signing up with this referral link',
        url: 'https://opencode.ai/go?ref=6VZAER87H4',
      },
    },
  },
  {
    id: 'xai',
    name: 'xAI',
    family: 'openai-compatible',
    baseUrl: 'https://api.x.ai/v1',
    envVars: ['XAI_API_KEY'],
    models: [],
    usage: 'metered-api',
    docsUrl: 'https://docs.x.ai/',
    requestPolicy: 'xai',
  },
  {
    id: 'ai-gateway',
    name: 'Vercel AI Gateway',
    // Cosmetic, and deliberately so: `makeProviderFromConfig` routes on
    // `cfg.type === 'ai-gateway'` BEFORE the family switch, so the real
    // transport is always AiGatewayProvider (AI SDK 7). Declaring
    // `openai-compatible` is what keeps this entry inside
    // `projectCompatibleProviderPresets`, which is the gate for auto-discovery.
    family: 'openai-compatible',
    // The MODEL-LIST endpoint, not the wire endpoint. AI SDK talks to the
    // Gateway's own protocol at `/v4/ai` and supplies that default itself, so
    // leaving `providers.<id>.baseUrl` unset keeps the two independent —
    // `discoveryOnlyBaseUrl` is what holds the setup flows to that.
    baseUrl: 'https://ai-gateway.vercel.sh/v1',
    discoveryOnlyBaseUrl: true,
    envVars: ['AI_GATEWAY_API_KEY'],
    models: [],
    usage: 'metered-api',
    docsUrl: 'https://vercel.com/docs/ai-gateway',
    autoDiscover: true,
    catalog: {
      description: 'Every model behind one key — routed by Vercel AI Gateway',
      icon: '▲',
      color: 'from-primary/12 to-primary/5 border-primary/30 hover:border-primary/50',
      keyPlaceholder: 'vck_...',
    },
  },
] as const;

export const LOCAL_PROVIDER_DEFINITIONS: readonly ProviderDefinition[] = [
  {
    id: 'omniroute',
    name: 'OmniRoute',
    family: 'openai-compatible',
    baseUrl: 'http://localhost:20128/v1',
    envVars: [],
    models: [],
    usage: 'local',
    quirks: { stripThinkTags: true },
    autoDiscover: true,
    local: {
      noAuth: true,
      hint: 'WrongStack local gateway · port 20128 · no key · auto-discovers models',
    },
  },
  {
    id: 'ollama',
    name: 'Ollama',
    family: 'openai-compatible',
    baseUrl: 'http://localhost:11434/v1',
    envVars: [],
    models: [],
    usage: 'local',
    docsUrl: 'https://ollama.com',
    local: { noAuth: true, hint: 'ollama.com · port 11434 · no key' },
  },
  {
    id: 'vllm',
    name: 'vLLM',
    family: 'openai-compatible',
    baseUrl: 'http://localhost:8000/v1',
    envVars: [],
    models: [],
    usage: 'local',
    docsUrl: 'https://docs.vllm.ai',
    local: { noAuth: false, hint: 'docs.vllm.ai · port 8000 · optional key' },
  },
  {
    id: 'lmstudio',
    name: 'LM Studio',
    family: 'openai-compatible',
    baseUrl: 'http://localhost:1234/v1',
    envVars: [],
    models: [],
    usage: 'local',
    docsUrl: 'https://lmstudio.ai',
    local: { noAuth: false, hint: 'lmstudio.ai · port 1234 · optional key' },
  },
] as const;

/** Every product-level provider fact exposed by WrongStack. */
export const PROVIDER_DEFINITIONS: Readonly<Record<string, ProviderDefinition>> =
  Object.fromEntries(
    [
      ...CORE_PROVIDER_DEFINITIONS,
      ...Object.values(TRUSTED_PROVIDER_PRESETS),
      ...LOCAL_PROVIDER_DEFINITIONS,
    ].map((definition) => [definition.id, definition]),
  );

/** Resolve canonical ids and trusted `<id>-<alias>` variants. */
export function resolveProviderDefinition(id: string): ProviderDefinition | undefined {
  const exact = PROVIDER_DEFINITIONS[id];
  if (exact) return exact;

  let bestMatch: ProviderDefinition | undefined;
  for (const definition of Object.values(TRUSTED_PROVIDER_PRESETS)) {
    if (!id.startsWith(`${definition.id}-`)) continue;
    if (!bestMatch || definition.id.length > bestMatch.id.length) bestMatch = definition;
  }
  return bestMatch;
}

export interface LocalProviderPresetProjection {
  id: string;
  label: string;
  defaultBaseUrl: string;
  noAuth: boolean;
  hint: string;
}

export interface PopularProviderProjection extends ProviderCatalogMetadata {
  id: string;
  name: string;
  family: ProviderDefinition['family'];
  docsUrl?: string;
}

export interface CompatibleProviderProjection {
  defaultBaseUrl?: string;
  quirks?: ProviderDefinition['quirks'];
  autoDiscover?: boolean;
}

/** Builds the mutable host-facing shape without duplicating provider facts. */
export function projectLocalProviderPresets(): LocalProviderPresetProjection[] {
  return LOCAL_PROVIDER_DEFINITIONS.map((definition) => {
    if (!definition.baseUrl || !definition.local) {
      throw new Error(`Local provider definition is incomplete: ${definition.id}`);
    }
    return {
      id: definition.id,
      label: definition.name,
      defaultBaseUrl: definition.baseUrl,
      noAuth: definition.local.noAuth,
      hint: definition.local.hint,
    };
  });
}

/** Curated setup catalog generated from the same runtime definitions. */
export function projectPopularProviderCatalog(): PopularProviderProjection[] {
  return Object.values(PROVIDER_DEFINITIONS)
    .filter(
      (definition): definition is ProviderDefinition & { catalog: ProviderCatalogMetadata } =>
        definition.catalog !== undefined,
    )
    .map((definition) => ({
      id: definition.id,
      name: definition.name,
      family: definition.family,
      description: definition.catalog.description,
      icon: definition.catalog.icon,
      color: definition.catalog.color,
      keyPlaceholder: definition.catalog.keyPlaceholder,
      ...(definition.docsUrl ? { docsUrl: definition.docsUrl } : {}),
      ...(definition.catalog.referral ? { referral: { ...definition.catalog.referral } } : {}),
    }));
}

/** Factory tuning for compatible providers, projected from the registry. */
export function projectCompatibleProviderPresets(): Record<string, CompatibleProviderProjection> {
  return Object.fromEntries(
    Object.values(PROVIDER_DEFINITIONS)
      .filter(
        (definition) =>
          definition.family === 'openai-compatible' &&
          (definition.baseUrl !== undefined ||
            definition.quirks !== undefined ||
            definition.autoDiscover !== undefined),
      )
      .map((definition) => [
        definition.id,
        {
          ...(definition.baseUrl ? { defaultBaseUrl: definition.baseUrl } : {}),
          ...(definition.quirks ? { quirks: { ...definition.quirks } } : {}),
          ...(definition.autoDiscover !== undefined
            ? { autoDiscover: definition.autoDiscover }
            : {}),
        },
      ]),
  );
}
