import type { JSONSchema, Tool } from '../types/tool.js';
import type { FallbackManageToolOptions } from './fallback-manage-tool-options.js';
import { storeProviderKey } from './fallback-provider-key-store.js';

export const PROVIDER_KEY_SET_TOOL_NAME = 'provider_key_set';

const PROVIDER_KEY_SET_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    provider: {
      type: 'string',
      description: 'Provider id (e.g. "openai", "anthropic"). Required.',
    },
    key: {
      type: 'string',
      description:
        "The API key value. When provided directly, it is stored as the provider's " +
        'primary key. ⚠️ This value is visible to the LLM — for secrets, omit this field ' +
        'and use envVar instead, or provide the key through the interactive prompt.',
    },
    envVar: {
      type: 'string',
      description:
        'Environment variable name that contains the key (e.g. "OPENAI_API_KEY"). ' +
        'The key is read from the environment at tool execution time — the value is never ' +
        'visible to the LLM. Preferred over passing the key directly.',
    },
    label: {
      type: 'string',
      description:
        'Optional label for the key entry (e.g. "work", "personal"). Useful when managing multiple keys.',
    },
    setActive: {
      type: 'boolean',
      description: 'Whether to make this the active key. Default: true.',
    },
  },
  required: ['provider'],
  additionalProperties: false,
};

interface ProviderKeySetInput {
  provider: string;
  key?: string | undefined;
  envVar?: string | undefined;
  label?: string | undefined;
  setActive?: boolean | undefined;
}

interface ProviderKeySetOutput {
  status: 'ok' | 'error' | 'needs_key';
  message: string;
}

export function createProviderKeySetTool(
  opts: FallbackManageToolOptions,
): Tool<ProviderKeySetInput, ProviderKeySetOutput> {
  return {
    name: PROVIDER_KEY_SET_TOOL_NAME,
    description:
      'Set the API key for a provider. For security, prefer using envVar (reads from ' +
      'environment variable, value never visible to the LLM) over passing the key directly. ' +
      'When neither key nor envVar is provided, the tool returns a prompt for interactive key entry — ' +
      'the UI will present an input field and the key is stored without LLM visibility.\n\n' +
      'After setting a key, the provider becomes usable for model assignments and fallback chains. ' +
      'Add its models to favorites with favorite_manage to unlock them for fallback/profile use.',
    usageHint:
      'Preferred: provider_key_set({ provider: "openai", envVar: "OPENAI_API_KEY" }). ' +
      'For interactive input: provider_key_set({ provider: "openai" }) — the UI will prompt. ' +
      'Direct key: provider_key_set({ provider: "openai", key: "sk-..." }) — visible to LLM.',
    category: 'config',
    inputSchema: PROVIDER_KEY_SET_SCHEMA,
    permission: 'confirm',
    mutating: true,
    riskTier: 'standard',
    icon: 'settings',
    async execute(input) {
      const config = opts.getConfig();
      const providers = {
        ...((config.providers ?? {}) as unknown as Record<string, Record<string, unknown>>),
      };

      if (input.key && input.envVar) {
        return {
          status: 'error',
          message:
            'Provide either key (direct, visible to LLM) OR envVar (reads from environment, ' +
            'never visible to LLM), not both. Use envVar for security.',
        };
      }

      if (!input.key && !input.envVar) {
        if (opts.requestInput) {
          try {
            const value = await opts.requestInput(
              `Enter API key for "${input.provider}" (will be stored securely, LLM will not see it):`,
            );
            if (!value || value.trim().length === 0) {
              return { status: 'error', message: 'No key was entered. Operation cancelled.' };
            }
            return storeProviderKey(providers, input, value.trim(), opts);
          } catch (err) {
            return {
              status: 'error',
              message: `Interactive input failed or was cancelled: ${err instanceof Error ? err.message : String(err)}`,
            };
          }
        }
        return {
          status: 'needs_key',
          message:
            `To set the API key for "${input.provider}", use provider_key_set ` +
            `with either:\n` +
            `  1. envVar: "${input.provider.toUpperCase()}_API_KEY" (reads from env, LLM never sees it)\n` +
            `  2. key: "sk-..." (pass directly, visible to LLM)\n\n` +
            `Interactive key entry is handled by the UI — enter your key through the prompt surface.`,
        };
      }

      if (input.envVar) {
        const envValue = process.env[input.envVar];
        if (!envValue) {
          return {
            status: 'error',
            message:
              `Environment variable "${input.envVar}" is not set or empty. ` +
              `Set it first or use a different envVar.`,
          };
        }
        return storeProviderKey(providers, input, envValue, opts);
      }

      if (input.key) {
        return storeProviderKey(providers, input, input.key, opts);
      }

      return { status: 'error', message: 'Unexpected — no key source available.' };
    },
  };
}
