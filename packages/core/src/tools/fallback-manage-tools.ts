/**
 * LLM-accessible tools covering every provider/model/fallback configurable area
 * in the system: favorites, fallback chains & profiles, provider management,
 * API key handling, leader model, per-role model assignment, and system view.
 *
 * DESIGN: Every operation that accepts a provider/model reference validates
 * the entry against the user's `favoriteModels` list FIRST. This means all
 * fallback additions, profiles, and role assignments are restricted to
 * user-curated favorites — the LLM cannot add arbitrary unknown models.
 *
 * Exceptions:
 * - Removing entries (chain, profile, favorites) works on any existing entry.
 * - Listing/viewing works unconditionally.
 * - The active leader model itself is not restricted (it's already set).
 *
 * Tools (8 total):
 *   favorite_manage      — List, add, remove favorite models.
 *   fallback_chain_manage — View, add, insert, remove, clear the active chain.
 *   fallback_profile_manage — List, create/update, delete named profiles.
 *   agent_model_assign   — Assign model/profile to role/phase/* in the matrix.
 *   provider_manage      — List, add, configure, remove provider entries.
 *   provider_key_set     — Set API key via env var, direct key, or interactive prompt.
 *   leader_model_set     — View/set leader model, derive from profile, toggle settings.
 *   system_config_view   — Comprehensive view + validation doctor for full config.
 *
 * Usage from an agent:
 * ```
 * favorite_manage({ action: "list" })
 * favorite_manage({ action: "add", model: "anthropic/claude-sonnet-4" })
 * fallback_chain_manage({ action: "add", model: "anthropic/claude-haiku-3" })
 * fallback_profile_manage({ action: "set", name: "fast", chain: ["openai/gpt-4o-mini"] })
 * agent_model_assign({ role: "security-scanner", provider: "anthropic", model: "claude-haiku-3" })
 * provider_key_set({ provider: "openai", envVar: "OPENAI_API_KEY" })
 * leader_model_set({ action: "show" })
 * system_config_view({ section: "all" })
 * ```
 */
import type { JSONSchema, Tool } from '../types/tool.js';
import { isValidMatrixKey } from '../coordination/model-matrix.js';
import {
  isFavoriteRef,
  notFavoriteError,
  profileList,
} from './fallback-manage-helpers.js';
import { createFallbackChainManageTool } from './fallback-chain-manage-tool.js';
import { createFavoriteManageTool } from './fallback-favorite-manage-tool.js';
import { parseRefInternal } from './fallback-model-ref-parse.js';
import type { FallbackManageToolOptions } from './fallback-manage-tool-options.js';
import { storeProviderKey } from './fallback-provider-key-store.js';
import { createSystemConfigViewTool } from './fallback-system-config-view-tool.js';

// ── Public types ────────────────────────────────────────────────────────────

export { FALLBACK_CHAIN_MANAGE_TOOL_NAME } from './fallback-chain-manage-tool.js';
export const FALLBACK_PROFILE_MANAGE_TOOL_NAME = 'fallback_profile_manage';
export const AGENT_MODEL_ASSIGN_TOOL_NAME = 'agent_model_assign';
export { FAVORITE_MANAGE_TOOL_NAME } from './fallback-favorite-manage-tool.js';
export * from './fallback-system-config-view-tool.js';
export type { FallbackManageToolOptions } from './fallback-manage-tool-options.js';

// ── 3. FALLBACK_PROFILE_MANAGE ──────────────────────────────────────────────

const FALLBACK_PROFILE_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['list', 'set', 'delete'],
      description: 'Operation: list (show all profiles), set (create/update), delete (remove a profile).',
    },
    name: {
      type: 'string',
      description:
        'Profile name (e.g. "fast", "economy", "reliable"). Required for "set" and "delete".',
    },
    chain: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Ordered list of model references for the profile. ' +
        'Each entry must be a favorite model. Required for "set". Example: ["anthropic/claude-haiku-3", "openai/gpt-4o-mini"].',
    },
  },
  required: ['action'],
  additionalProperties: false,
};

interface FallbackProfileInput {
  action: 'list' | 'set' | 'delete';
  name?: string | undefined;
  chain?: string[] | undefined;
}

interface FallbackProfileOutput {
  status: 'ok' | 'error';
  message: string;
  profiles?: Record<string, string[]>;
}

function createFallbackProfileManageTool(opts: FallbackManageToolOptions): Tool<FallbackProfileInput, FallbackProfileOutput> {
  return {
    name: FALLBACK_PROFILE_MANAGE_TOOL_NAME,
    description:
      'Manage named fallback profiles. A profile is a reusable, ordered list of ' +
      'model references that can be assigned to agent roles. Every entry in a profile ' +
      'must be a FAVORITE model — add it via favorite_manage first. ' +
      'Use /setmodel or agent_model_assign to assign a profile to a role.',
    usageHint:
      '"list" to see all profiles. ' +
      '"set" with name and chain (array of model refs) to create or replace a profile. ' +
      '"delete" with name to remove a profile.',
    category: 'config',
    inputSchema: FALLBACK_PROFILE_SCHEMA,
    permission: 'auto',
    mutating: true,
    riskTier: 'standard',
    icon: 'settings',
    async execute(input) {
      const config = opts.getConfig();
      const profiles = { ...profileList(config) };

      if (input.action === 'list') {
        const names = Object.keys(profiles);
        if (names.length === 0) {
          return {
            status: 'ok',
            message: 'No fallback profiles. Create one with "set".',
            profiles: {},
          };
        }
        const msg = names
          .sort()
          .map((name) => `  ${name} → ${profiles[name]?.join(' → ') || '(empty)'}`)
          .join('\n');
        return { status: 'ok', message: `Fallback profiles:\n${msg}`, profiles: { ...profiles } };
      }

      if (input.action === 'set') {
        if (!input.name) {
          return { status: 'error', message: 'Provide "name" for the profile (e.g. "fast").' };
        }
        if (!input.chain || input.chain.length === 0) {
          return { status: 'error', message: 'Provide "chain" — a non-empty array of model references.' };
        }
        // Validate every entry against favorites
        const invalid: string[] = [];
        for (const ref of input.chain) {
          if (!isFavoriteRef(ref, config)) {
            invalid.push(ref);
          }
        }
        if (invalid.length > 0) {
          return {
            status: 'error',
            message:
              `The following entries are not in your favorites list:\n  ${invalid.join('\n  ')}\n\n` +
              'Add them first with favorite_manage({ action: "add", model: "<ref>" }).',
          };
        }
        profiles[input.name] = [...input.chain];
        await opts.updateConfig((cfg) => {
          cfg.fallbackProfiles = profiles;
        });
        return {
          status: 'ok',
          message: `✓ Profile "${input.name}" → ${input.chain.join(' → ')}`,
          profiles: { ...profiles },
        };
      }

      if (input.action === 'delete') {
        if (!input.name) {
          return { status: 'error', message: 'Provide "name" of the profile to delete.' };
        }
        if (!(input.name in profiles)) {
          return { status: 'error', message: `Profile "${input.name}" not found.` };
        }
        delete profiles[input.name];
        await opts.updateConfig((cfg) => {
          cfg.fallbackProfiles = profiles;
        });
        return {
          status: 'ok',
          message: `✓ Deleted profile: ${input.name}`,
          profiles: { ...profiles },
        };
      }

      return { status: 'error', message: `Unknown action: "${input.action}".` };
    },
  };
}

// ── 4. AGENT_MODEL_ASSIGN ───────────────────────────────────────────────────

const AGENT_MODEL_ASSIGN_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    role: {
      type: 'string',
      description:
        'Matrix key: a catalog role (e.g. "security-scanner", "bug-hunter"), a phase ' +
        'name (e.g. "review", "implementation"), or "*" for the fleet-wide default.',
    },
    provider: {
      type: 'string',
      description:
        'Provider id (e.g. "anthropic", "openai"). When omitted, the leader provider is used. ' +
        'The provider.model combination must be in your favorites list.',
    },
    model: {
      type: 'string',
      description:
        'Model id (e.g. "claude-haiku-3", "gpt-4o-mini"). When omitted together with provider, ' +
        'the role falls back to the leader model. Must be in your favorites list.',
    },
    profile: {
      type: 'string',
      description:
        'Named fallback profile to assign (e.g. "fast", "economy"). Alternative to provider+model. ' +
        'When set, the first profile entry becomes the primary model and the rest are the fallback chain.',
    },
    clear: {
      type: 'boolean',
      description:
        'Set to true to remove the matrix entry for this role (it will fall through to phase/*/leader).',
    },
  },
  // Flattened from a top-level oneOf — Anthropic-family endpoints reject
  // top-level combinators (omniroute 400: "input_schema does not support
  // oneOf, allOf, or anyOf at the top level"). Combination rules are
  // enforced in the handler instead.
  required: ['role'],
  additionalProperties: false,
};

interface AgentModelAssignInput {
  role: string;
  provider?: string | undefined;
  model?: string | undefined;
  profile?: string | undefined;
  clear?: boolean | undefined;
}

interface AgentModelAssignOutput {
  status: 'ok' | 'error';
  message: string;
  role?: string;
}

function createAgentModelAssignTool(opts: FallbackManageToolOptions): Tool<AgentModelAssignInput, AgentModelAssignOutput> {
  return {
    name: AGENT_MODEL_ASSIGN_TOOL_NAME,
    description:
      'Assign a provider/model or a fallback profile to a specific agent role, phase, ' +
      'or the fleet-wide default. This is the LLM-accessible equivalent of /setmodel set. ' +
      'The provider+model combination must be in your favorites list (unless only clearing). ' +
      'Resolution precedence: exact role → phase → * → leader model.',
    usageHint:
      'Use "list" as role to see current assignments. ' +
      'Set with role + model, or role + provider + model, or role + profile. ' +
      'Set role + clear=true to remove a matrix entry. ' +
      'The provider/model must be a favorite.',
    category: 'config',
    inputSchema: AGENT_MODEL_ASSIGN_SCHEMA,
    permission: 'auto',
    mutating: true,
    riskTier: 'standard',
    icon: 'settings',
    async execute(input) {
      const config = opts.getConfig();

      // Reject conflicting combination rules — only one mode at a time
      const modes = [input.clear ? 'clear' : null, input.profile ? 'profile' : null, input.model ? 'model' : null].filter(Boolean);
      if (modes.length > 1) {
        return {
          status: 'error',
          message: `Conflicting assignment modes: ${modes.join(' + ')}. ` +
            'Use exactly one: clear=true, profile="name", or model="name" (optionally with provider).',
        };
      }

      // Special case: "list" role shows current matrix
      if (input.role === 'list') {
        const matrix = (config.modelMatrix ?? {}) as Record<string, unknown>;
        const keys = Object.keys(matrix);
        if (keys.length === 0) {
          return { status: 'ok', message: 'No matrix assignments. All roles use the leader model.' };
        }
        const msg = keys.sort().map((k) => `  ${k} → ${JSON.stringify(matrix[k])}`).join('\n');
        return { status: 'ok', message: `Model matrix (${keys.length} entries):\n${msg}` };
      }

      // Validate key
      if (!isValidMatrixKey(input.role)) {
        return {
          status: 'error',
          message:
            `"${input.role}" is not a valid matrix key. Use a catalog role (e.g. "security-scanner"), ` +
            'a phase (e.g. "review"), or "*" for the fleet-wide default.',
        };
      }

      // Clear entry
      if (input.clear) {
        const matrix = { ...((config.modelMatrix ?? {}) as Record<string, unknown>) };
        if (!(input.role in matrix)) {
          return { status: 'ok', message: `No matrix entry for "${input.role}" to clear.` };
        }
        delete matrix[input.role];
        await opts.updateConfig((cfg) => {
          cfg.modelMatrix = matrix;
        });
        return { status: 'ok', message: `✓ Cleared matrix entry for "${input.role}".` };
      }

      // Show current assignment for this role
      if (!input.model && !input.profile && !input.provider) {
        const matrix = (config.modelMatrix ?? {}) as Record<string, unknown>;
        const entry = matrix[input.role];
        if (!entry) {
          return { status: 'ok', message: `No specific assignment for "${input.role}". It uses the leader model or phase/* fallback.` };
        }
        return { status: 'ok', message: `"${input.role}" → ${JSON.stringify(entry)}` };
      }

      // Assign profile (no model required)
      if (input.profile && !input.model) {
        const profiles = profileList(config);
        if (!profiles[input.profile]) {
          return { status: 'error', message: `Profile "${input.profile}" not found. Create it with fallback_profile_manage first.` };
        }
        const matrix = { ...((config.modelMatrix ?? {}) as Record<string, unknown>) };
        matrix[input.role] = { fallbackProfile: input.profile };
        await opts.updateConfig((cfg) => {
          cfg.modelMatrix = matrix;
        });
        return { status: 'ok', message: `✓ "${input.role}" → profile: ${input.profile}` };
      }

      // Assign provider+model (must be a favorite)
      if (input.model) {
        const effectiveProvider = input.provider ?? config.provider;
        const ref = `${effectiveProvider}/${input.model}`;
        if (!isFavoriteRef(ref, config)) {
          return { status: 'error', message: notFavoriteError(ref, config) };
        }
        const matrix = { ...((config.modelMatrix ?? {}) as Record<string, unknown>) };
        const previousRuntime = (matrix[input.role] as Record<string, unknown>)?.modelRuntime;
        matrix[input.role] = input.provider
          ? { provider: input.provider, model: input.model, ...(previousRuntime ? { modelRuntime: previousRuntime } : {}) }
          : { model: input.model, ...(previousRuntime ? { modelRuntime: previousRuntime } : {}) };
        await opts.updateConfig((cfg) => {
          cfg.modelMatrix = matrix;
        });
        const display = input.provider ? `${input.provider}/${input.model}` : `${input.model} (leader provider)`;
        return { status: 'ok', message: `✓ "${input.role}" → ${display}` };
      }

      return { status: 'error', message: 'Provide model, profile, or clear=true for the role assignment.' };
    },
  };
}

// ── 5. Factory ──────────────────────────────────────────────────────────────

// ── 5. PROVIDER_MANAGE ──────────────────────────────────────────────────────

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
      description: 'Provider id (e.g. "openai", "anthropic"). Required for all actions except list.',
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

/**
 * Reject provider base URLs that are malformed, non-HTTP, or carry embedded
 * credentials (WS-013). Private and loopback hosts stay allowed on purpose —
 * Ollama, LM Studio and omniroute are first-class local providers.
 */
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

function createProviderManageTool(opts: FallbackManageToolOptions): Tool<ProviderManageInput, ProviderManageOutput> {
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
    // WS-013: without a subjectKey the approval subject collapses to the bare
    // tool name, so one "always allow" answered for `list` also authorised any
    // future call with any baseUrl. Bind it to the endpoint, mirroring
    // packages/tools/src/fetch.ts:74.
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
        const msg = ids.sort().map((id) => {
          const entry = providers[id] ?? {};
          const type = (entry.type as string) ?? '(unknown)';
          const models = Array.isArray(entry.models) ? (entry.models as string[]).join(', ') : '(all)';
          const hasKey = entry.apiKey ? '✓' : entry.apiKeys ? '✓' : '✗';
          const prefix = id === leaderProvider ? '★ ' : '  ';
          const baseUrl = entry.baseUrl ? ` url:${entry.baseUrl}` : '';
          const family = entry.family ? ` family:${entry.family}` : '';
          return `  ${prefix}${id} (${type}) key:${hasKey} models:[${models}]${baseUrl}${family}`;
        }).join('\n');
        return {
          status: 'ok',
          message: `Providers (leader: ${leaderProvider}):\n${msg}`,
          providers: ids,
        };
      }

      if (input.action === 'add') {
        if (!input.provider || !input.type) {
          return { status: 'error', message: 'Provide "provider" (id) and "type" to add a provider.' };
        }
        if (providers[input.provider]) {
          return { status: 'error', message: `Provider "${input.provider}" already exists. Use "configure" to update.` };
        }
        if (input.baseUrl) {
          const invalid = validateProviderBaseUrl(input.baseUrl);
          if (invalid) return { status: 'error', message: invalid };
        }
        const entry: Record<string, unknown> = { type: input.type };
        if (input.models) entry.models = input.models;
        if (input.baseUrl) entry.baseUrl = input.baseUrl;
        if (input.family) entry.family = input.family;
        if (input.envVars) entry.envVars = input.envVars;
        if (input.autoDiscoverModels !== undefined) entry.autoDiscoverModels = input.autoDiscoverModels;
        if (input.apiKey) entry.apiKey = input.apiKey;
        providers[input.provider] = entry;
        await opts.updateConfig((cfg) => {
          cfg.providers = providers;
        });
        return { status: 'ok', message: `✓ Added provider: ${input.provider} (type: ${input.type})` };
      }

      if (input.action === 'configure') {
        if (!input.provider) {
          return { status: 'error', message: 'Provide "provider" id to configure.' };
        }
        if (!providers[input.provider]) {
          return { status: 'error', message: `Provider "${input.provider}" not found. Use "add" first or check "list".` };
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
        if (input.autoDiscoverModels !== undefined) entry.autoDiscoverModels = input.autoDiscoverModels;
        if (input.apiKey !== undefined) entry.apiKey = input.apiKey || undefined;

        // WS-013: an API key is issued for one endpoint. Spreading the previous
        // entry carried it across a baseUrl change, so a single `configure` call
        // could repoint the provider at an attacker-chosen host and every
        // subsequent request — plus the boot-time /v1/models probe — would send
        // the stored key there. Moving the endpoint now drops the key unless the
        // caller supplies a new one in the same call.
        const endpointChanged =
          input.baseUrl !== undefined && (entry.baseUrl ?? undefined) !== (previous.baseUrl ?? undefined);
        const keyDropped = endpointChanged && input.apiKey === undefined && previous.apiKey !== undefined;
        if (keyDropped) entry.apiKey = undefined;

        providers[input.provider] = entry;
        await opts.updateConfig((cfg) => {
          cfg.providers = providers;
        });
        const updated = Object.keys({ ...entry }).filter((k) => k !== 'apiKey').join(', ');
        const keyNote = keyDropped
          ? ' — stored API key cleared because the base URL changed; set it again with provider_key_set'
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
          return { status: 'error', message: `Cannot remove the active leader provider "${input.provider}". Switch the leader first.` };
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

// ── 6. PROVIDER_KEY_SET ─────────────────────────────────────────────────────

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
        'The API key value. When provided directly, it is stored as the provider\'s ' +
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
  // Flattened from a top-level oneOf — Anthropic-family endpoints reject
  // top-level combinators (omniroute 400). Combination rules are enforced
  // in the handler instead.
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

function createProviderKeySetTool(opts: FallbackManageToolOptions): Tool<ProviderKeySetInput, ProviderKeySetOutput> {
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
    // 'confirm', not 'auto' — this tool writes credentials to disk (and can
    // read arbitrary env vars into the config file), so the user must see it.
    permission: 'confirm',
    mutating: true,
    riskTier: 'standard',
    icon: 'settings',
    async execute(input) {
      const config = opts.getConfig();
      const providers = {
        ...((config.providers ?? {}) as unknown as Record<string, Record<string, unknown>>),
      };

      // Reject when both key and envVar are supplied — ambiguous intent
      if (input.key && input.envVar) {
        return {
          status: 'error',
          message: 'Provide either key (direct, visible to LLM) OR envVar (reads from environment, ' +
            'never visible to LLM), not both. Use envVar for security.',
        };
      }

      // If no key or envVar is given, request interactive input
      if (!input.key && !input.envVar) {
        // Interactive input via host callback — LLM never sees the value
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
        // No interactive callback — return a status the host can intercept
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

      // Read from environment variable
      if (input.envVar) {
        const envValue = process.env[input.envVar];
        if (!envValue) {
          return {
            status: 'error',
            message: `Environment variable "${input.envVar}" is not set or empty. ` +
              `Set it first or use a different envVar.`,
          };
        }
        return storeProviderKey(providers, input, envValue, opts);
      }

      // Key provided directly
      if (input.key) {
        return storeProviderKey(providers, input, input.key, opts);
      }

      return { status: 'error', message: 'Unexpected — no key source available.' };
    },
  };
}

// ── 7. LEADER_MODEL_SET ─────────────────────────────────────────────────────

export const LEADER_MODEL_SET_TOOL_NAME = 'leader_model_set';

const LEADER_MODEL_SET_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['show', 'set', 'profile', 'toggle'],
      description:
        'Operation: show (current leader + toggles), set (change provider/model), ' +
        'profile (set from a fallback profile), toggle (change fallbackAuto/favoriteModelsOnly).',
    },
    provider: {
      type: 'string',
      description: 'Provider id for the leader (e.g. "anthropic", "openai"). Required for "set".',
    },
    model: {
      type: 'string',
      description: 'Model id for the leader (e.g. "claude-sonnet-4-20250514"). Required for "set".',
    },
    profile: {
      type: 'string',
      description: 'Fallback profile name to derive the leader + chain from. Required for "profile".',
    },
    toggle: {
      type: 'string',
      enum: ['fallbackAuto', 'favoriteModelsOnly'],
      description: 'Which toggle to change. Required for "toggle".',
    },
    value: {
      type: 'boolean',
      description: 'New value for the toggle. Required for "toggle".',
    },
  },
  additionalProperties: false,
};

interface LeaderModelSetInput {
  action: 'show' | 'set' | 'profile' | 'toggle';
  provider?: string | undefined;
  model?: string | undefined;
  profile?: string | undefined;
  toggle?: 'fallbackAuto' | 'favoriteModelsOnly' | undefined;
  value?: boolean | undefined;
}

interface LeaderModelSetOutput {
  status: 'ok' | 'error';
  message: string;
}

function createLeaderModelSetTool(opts: FallbackManageToolOptions): Tool<LeaderModelSetInput, LeaderModelSetOutput> {
  return {
    name: LEADER_MODEL_SET_TOOL_NAME,
    description:
      'View or change the leader provider/model and system toggles. The leader is the ' +
      'primary model used for the main agent interactions. ' +
      '"set" changes it directly. "profile" derives it from a named fallback profile ' +
      '(first entry becomes leader, rest become the fallback chain). ' +
      '"toggle" controls fallbackAuto (smart default fallback) and favoriteModelsOnly ' +
      '(restrict auto-fallback to favorites only).',
    usageHint:
      '"show" to see current state. "set" with provider+model to change. ' +
      '"profile" with name to derive from a profile. ' +
      '"toggle" with toggle name and value to change a boolean setting.',
    category: 'config',
    inputSchema: LEADER_MODEL_SET_SCHEMA,
    permission: 'auto',
    mutating: true,
    riskTier: 'standard',
    icon: 'settings',
    async execute(input) {
      const config = opts.getConfig();

      if (input.action === 'show') {
        const lines: string[] = [
          `  ${'leader'}: ${config.provider}/${config.model}`,
          `  ${'fallbackAuto'}: ${config.fallbackAuto !== false ? 'on' : 'off'}`,
          `  ${'favoriteModelsOnly'}: ${config.favoriteModelsOnly ? 'on' : 'off'}`,
          '',
          `  ${'fallback models'}: ${(config.fallbackModels ?? []).length > 0 ? (config.fallbackModels ?? []).join(' → ') : 'empty (auto fallback)'}`,
          `  ${'favorites'}: ${(config.favoriteModels ?? []).length > 0 ? `${(config.favoriteModels ?? []).length} models` : '(none)'}`,
          `  ${'refiner'}: ${config.autonomy?.refinerProvider ? `${config.autonomy.refinerProvider}/${config.autonomy.refinerModel ?? '(default model)'}` : '(same as leader)'}`,
        ];
        return { status: 'ok', message: lines.join('\n') };
      }

      if (input.action === 'set') {
        if (!input.provider || !input.model) {
          return { status: 'error', message: 'Provide "provider" and "model" for the leader.' };
        }
        // Route through the host's live switch FIRST when wired — it swaps the
        // agent's provider instance/model and refreshes context caps, and it
        // validates the target, so a bad provider/model never gets persisted.
        // Mutating cfg.provider/model directly here left the live session on
        // the old model while config claimed the new one.
        if (opts.switchProviderAndModel) {
          const switchError = await opts.switchProviderAndModel(input.provider, input.model);
          if (switchError) {
            return {
              status: 'error',
              message: `Could not switch to ${input.provider}/${input.model}: ${switchError}. Config was not changed.`,
            };
          }
        }
        await opts.updateConfig((cfg) => {
          cfg.provider = input.provider;
          cfg.model = input.model;
        });
        const liveNote = opts.switchProviderAndModel
          ? ''
          : ' (config updated — the live session keeps its current model until restart or /setmodel)';
        return { status: 'ok', message: `✓ Leader → ${input.provider}/${input.model}${liveNote}` };
      }

      if (input.action === 'profile') {
        if (!input.profile) {
          return { status: 'error', message: 'Provide "profile" name to derive the leader from.' };
        }
        const profiles = (config.fallbackProfiles ?? {}) as Record<string, string[]>;
        const chain = profiles[input.profile];
        if (!chain || chain.length === 0) {
          return { status: 'error', message: `Profile "${input.profile}" not found or empty.` };
        }
        // Parse first entry as leader provider/model
        const first = chain[0]!;
        const p = parseRefInternal(first);
        const provider = p.provider ?? config.provider;
        const model = p.model;
        if (!model) {
          return { status: 'error', message: `Cannot parse "${first}" as a valid model reference.` };
        }
        const rest = chain.slice(1);
        // Same live-switch-first ordering as the "set" action (see above).
        if (opts.switchProviderAndModel) {
          const switchError = await opts.switchProviderAndModel(provider, model);
          if (switchError) {
            return {
              status: 'error',
              message: `Could not switch to ${provider}/${model}: ${switchError}. Config was not changed.`,
            };
          }
        }
        await opts.updateConfig((cfg) => {
          cfg.provider = provider;
          cfg.model = model;
          cfg.fallbackModels = rest;
        });
        const profileLiveNote = opts.switchProviderAndModel
          ? ''
          : '\n  (config updated — the live session keeps its current model until restart or /setmodel)';
        return {
          status: 'ok',
          message: `✓ Leader → ${provider}/${model} (profile: ${input.profile})` +
            (rest.length > 0 ? `\n  Fallback chain: ${rest.join(' → ')}` : '') +
            profileLiveNote,
        };
      }

      if (input.action === 'toggle') {
        if (!input.toggle || input.value === undefined) {
          return { status: 'error', message: 'Provide "toggle" (fallbackAuto | favoriteModelsOnly) and "value" (boolean).' };
        }
        await opts.updateConfig((cfg) => {
          if (input.toggle === 'fallbackAuto') {
            cfg.fallbackAuto = input.value;
          } else if (input.toggle === 'favoriteModelsOnly') {
            cfg.favoriteModelsOnly = input.value;
          }
        });
        return {
          status: 'ok',
          message: `✓ ${input.toggle} → ${input.value ? 'on' : 'off'}`,
        };
      }

      return { status: 'error', message: `Unknown action: "${input.action}".` };
    },
  };
}

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create all 8 provider/model/fallback management tools that LLMs can call.
 *
 * Register them all in the tool registry:
 * ```ts
 * const tools = createFallbackManageTools({ getConfig, updateConfig });
 * for (const tool of tools) toolRegistry.register(tool);
 * ```
 */
export function createFallbackManageTools(opts: FallbackManageToolOptions): Tool[] {
  return [
    createFavoriteManageTool(opts),
    createFallbackChainManageTool(opts),
    createFallbackProfileManageTool(opts),
    createAgentModelAssignTool(opts),
    createProviderManageTool(opts),
    createProviderKeySetTool(opts),
    createLeaderModelSetTool(opts),
    createSystemConfigViewTool(opts),
  ];
}
