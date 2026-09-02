import type { JSONSchema, Tool } from '../types/tool.js';
import type { FallbackManageToolOptions } from './fallback-manage-tool-options.js';

export const PROVIDER_MANAGE_TOOL_NAME = 'provider_manage';

const PROVIDER_MANAGE_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['list', 'add', 'configure', 'remove'],
      description:
        'Operation: list (show all providers), add (add a new provider config), ' +
        'configure (update fields of an existing provider), remove (delete a provider config).',
    },
    provider: {
      type: 'string',
      description:
        'Provider id (e.g. "openai", "anthropic"). Required for all actions except list.',
    },
    type: {
      type: 'string',
      description: 'Provider type (e.g. "openai", "anthropic"). Required for "add".',
    },
    models: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Model list to restrict visibility for this provider. Optional for add/configure.',
    },
    baseUrl: {
      type: 'string',
      description: 'Custom base URL (e.g. for self-hosted endpoints). Optional.',
    },
    family: {
      type: 'string',
      description:
        'Wire-family override (e.g. "openai", "openai-compatible", "anthropic"). ' +
        'When set, the provider can be constructed without a catalog entry.',
    },
    envVars: {
      type: 'array',
      items: { type: 'string' },
      description: 'Custom env var names to probe when apiKey is missing. Optional.',
    },
    autoDiscoverModels: {
      type: 'boolean',
      description: 'Auto-fetch model list from {baseUrl}/models. Optional.',
    },
    apiKey: {
      type: 'string',
      description:
        '**NOT RECOMMENDED** — use provider_key_set instead. ' +
        'The LLM output may contain this value; use env var references for safety.',
    },
  },
  required: ['action'],
  additionalProperties: false,
};

interface ProviderManageInput {
  action: 'list' | 'add' | 'configure' | 'remove';
  provider?: string | undefined;
  type?: string | undefined;
  models?: string[] | undefined;
  baseUrl?: string | undefined;
  family?: string | undefined;
  envVars?: string[] | undefined;
  autoDiscoverModels?: boolean | undefined;
  apiKey?: string | undefined;
}

interface ProviderManageOutput {
  status: 'ok' | 'error';
  message: string;
  providers?: string[];
}

export const CREDENTIAL_SELECTOR_FIELDS = ['apiKey', 'apiKeys', 'activeKey', 'envVars'] as const;

export function envVarsClaimedByOtherProviders(
  providers: Record<string, Record<string, unknown>>,
  exceptProvider: string,
): Map<string, string> {
  const claimed = new Map<string, string>();
  for (const [id, entry] of Object.entries(providers)) {
    if (id === exceptProvider) continue;
    const names = entry?.['envVars'];
    if (!Array.isArray(names)) continue;
    for (const name of names) {
      if (typeof name === 'string' && !claimed.has(name)) claimed.set(name, id);
    }
  }
  return claimed;
}

export function rejectBorrowedEnvVars(
  providers: Record<string, Record<string, unknown>>,
  provider: string,
  requested: readonly unknown[] | undefined,
): string | null {
  if (!requested) return null;
  const claimed = envVarsClaimedByOtherProviders(providers, provider);
  for (const name of requested) {
    const owner = typeof name === 'string' ? claimed.get(name) : undefined;
    if (owner !== undefined) {
      return `Environment variable "${String(name)}" already supplies the key for provider "${owner}". Reading another provider's credential from "${provider}" is not allowed; use provider_key_set to give "${provider}" its own key.`;
    }
  }
  return null;
}

export function validateProviderBaseUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `Invalid baseUrl: ${raw} is not a valid URL.`;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return `Invalid baseUrl: ${url.protocol} is not supported — use http: or https:.`;
  }
  if (url.username || url.password) {
    return 'Invalid baseUrl: credentials embedded in the URL are not accepted.';
  }
  return null;
}

export function createProviderManageTool(
  opts: FallbackManageToolOptions,
): Tool<ProviderManageInput, ProviderManageOutput> {
  return {
    name: PROVIDER_MANAGE_TOOL_NAME,
    description:
      'View or configure provider entries. List all configured providers with their ' +
      'type, model lists, base URL, and key status. Add new providers, update their ' +
      'settings, or remove unused ones. API keys should be set via provider_key_set ' +
      'instead of passing them here — they are visible in the LLM output.',
    usageHint:
      '"list" to see all providers. "add" with provider id and type to create. ' +
      '"configure" to update models, baseUrl, family, or envVars. ' +
      '"remove" to delete a provider. Use provider_key_set for API key management.',
    category: 'config',
    inputSchema: PROVIDER_MANAGE_SCHEMA,
    permission: 'auto',
    mutating: true,
    subjectKey: 'baseUrl',
    riskTier: 'standard',
    icon: 'settings',
    async execute(input) {
      const config = opts.getConfig();
      const providers = {
        ...((config.providers ?? {}) as unknown as Record<string, Record<string, unknown>>),
      };
      const leaderProvider: string = config.provider ?? '';

      if (input.action === 'list') {
        const ids = Object.keys(providers);
        if (ids.length === 0) {
          return { status: 'ok', message: 'No providers configured.', providers: [] };
        }
        const msg = ids
          .sort()
          .map((id) => {
            const entry = providers[id] ?? {};
            const type = (entry.type as string) ?? '(unknown)';
            const models = Array.isArray(entry.models)
              ? (entry.models as string[]).join(', ')
              : '(all)';
            const hasKey = entry.apiKey ? '✓' : entry.apiKeys ? '✓' : '✗';
            const prefix = id === leaderProvider ? '★ ' : '  ';
            const baseUrl = entry.baseUrl ? ` url:${entry.baseUrl}` : '';
            const family = entry.family ? ` family:${entry.family}` : '';
            return `  ${prefix}${id} (${type}) key:${hasKey} models:[${models}]${baseUrl}${family}`;
          })
          .join('\n');
        return {
          status: 'ok',
          message: `Providers (leader: ${leaderProvider}):\n${msg}`,
          providers: ids,
        };
      }

      if (input.action === 'add') {
        if (!input.provider || !input.type) {
          return {
            status: 'error',
            message: 'Provide "provider" (id) and "type" to add a provider.',
          };
        }
        if (providers[input.provider]) {
          return {
            status: 'error',
            message: `Provider "${input.provider}" already exists. Use "configure" to update.`,
          };
        }
        if (input.baseUrl) {
          const invalid = validateProviderBaseUrl(input.baseUrl);
          if (invalid) return { status: 'error', message: invalid };
        }
        const borrowed = rejectBorrowedEnvVars(providers, input.provider, input.envVars);
        if (borrowed) return { status: 'error', message: borrowed };
        const entry: Record<string, unknown> = { type: input.type };
        if (input.models) entry.models = input.models;
        if (input.baseUrl) entry.baseUrl = input.baseUrl;
        if (input.family) entry.family = input.family;
        if (input.envVars) entry.envVars = input.envVars;
        if (input.autoDiscoverModels !== undefined)
          entry.autoDiscoverModels = input.autoDiscoverModels;
        if (input.apiKey) entry.apiKey = input.apiKey;
        providers[input.provider] = entry;
        await opts.updateConfig((cfg) => {
          cfg.providers = providers;
        });
        return {
          status: 'ok',
          message: `✓ Added provider: ${input.provider} (type: ${input.type})`,
        };
      }

      if (input.action === 'configure') {
        if (!input.provider) {
          return { status: 'error', message: 'Provide "provider" id to configure.' };
        }
        if (!providers[input.provider]) {
          return {
            status: 'error',
            message: `Provider "${input.provider}" not found. Use "add" first or check "list".`,
          };
        }
        if (input.baseUrl) {
          const invalid = validateProviderBaseUrl(input.baseUrl);
          if (invalid) return { status: 'error', message: invalid };
        }
        const previous: Record<string, unknown> = { ...providers[input.provider] };
        const entry: Record<string, unknown> = { ...previous };
        if (input.models !== undefined) entry.models = input.models;
        if (input.baseUrl !== undefined) entry.baseUrl = input.baseUrl || undefined;
        if (input.family !== undefined) entry.family = input.family || undefined;
        if (input.envVars !== undefined) entry.envVars = input.envVars;
        if (input.autoDiscoverModels !== undefined)
          entry.autoDiscoverModels = input.autoDiscoverModels;
        if (input.apiKey !== undefined) entry.apiKey = input.apiKey || undefined;

        const endpointChanged =
          input.baseUrl !== undefined &&
          (entry.baseUrl ?? undefined) !== (previous.baseUrl ?? undefined);
        const explicitlySupplied = new Set<string>([
          ...(input.apiKey !== undefined ? ['apiKey'] : []),
          ...(input.envVars !== undefined ? ['envVars'] : []),
        ]);
        const droppedFields = endpointChanged
          ? CREDENTIAL_SELECTOR_FIELDS.filter(
              (field) => !explicitlySupplied.has(field) && previous[field] !== undefined,
            )
          : [];
        for (const field of droppedFields) entry[field] = undefined;

        const borrowed = rejectBorrowedEnvVars(providers, input.provider, input.envVars);
        if (borrowed) return { status: 'error', message: borrowed };

        providers[input.provider] = entry;
        await opts.updateConfig((cfg) => {
          cfg.providers = providers;
        });
        const updated = Object.keys({ ...entry })
          .filter((k) => k !== 'apiKey')
          .join(', ');
        const keyNote =
          droppedFields.length > 0
            ? ` — cleared ${droppedFields.join(', ')} because the base URL changed; set the key again with provider_key_set`
            : '';
        return { status: 'ok', message: `✓ Updated ${input.provider}: ${updated}${keyNote}` };
      }

      if (input.action === 'remove') {
        if (!input.provider) {
          return { status: 'error', message: 'Provide "provider" id to remove.' };
        }
        if (!providers[input.provider]) {
          return { status: 'error', message: `Provider "${input.provider}" not found.` };
        }
        if (input.provider === leaderProvider) {
          return {
            status: 'error',
            message: `Cannot remove the active leader provider "${input.provider}". Switch the leader first.`,
          };
        }
        delete providers[input.provider];
        await opts.updateConfig((cfg) => {
          cfg.providers = providers;
        });
        return { status: 'ok', message: `✓ Removed provider: ${input.provider}` };
      }

      return { status: 'error', message: `Unknown action: "${input.action}".` };
    },
  };
}
