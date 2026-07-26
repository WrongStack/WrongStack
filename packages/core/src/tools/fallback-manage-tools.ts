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
import type { Config } from '../types/config.js';
import type { Logger } from '../types/logger.js';
import type { JSONSchema, Tool } from '../types/tool.js';
import { AGENT_CATALOG } from '../coordination/agents/index.js';
import { isValidMatrixKey, phaseForRole, resolveSubagentModelTarget } from '../coordination/model-matrix.js';
import { normalizeModelRef } from '../core/fallback-model.js';
import { parseRefInternal } from './fallback-model-ref-parse.js';
import { storeProviderKey } from './fallback-provider-key-store.js';

// ── Public types ────────────────────────────────────────────────────────────

export const FAVORITE_MANAGE_TOOL_NAME = 'favorite_manage';
export const FALLBACK_CHAIN_MANAGE_TOOL_NAME = 'fallback_chain_manage';
export const FALLBACK_PROFILE_MANAGE_TOOL_NAME = 'fallback_profile_manage';
export const AGENT_MODEL_ASSIGN_TOOL_NAME = 'agent_model_assign';

export interface FallbackManageToolOptions {
  /** Returns the live config (re-read each call so changes are honored). */
  getConfig: () => Config;
  /**
   * Persist config mutations. Receives a mutator that receives the config
   * as a mutable JSON object — the tool sets the relevant fields and the
   * host writes back atomically + mirrors into the in-memory store.
   */
  updateConfig: (mutate: (cfg: Record<string, unknown>) => void) => Promise<void>;
  /**
   * Optional callback for requesting secure interactive input from the user.
   * When provided, tools like `provider_key_set` can use it to prompt the
   * user for secret values (API keys, tokens) without the value passing
   * through the LLM's context. The prompt string is shown to the user and
   * the returned string is the value they entered.
   *
   * When absent, `provider_key_set` returns a `needs_key` status and the
   * host is expected to handle it through other means (env var, CLI command).
   */
  requestInput?: ((prompt: string) => Promise<string>) | undefined;
  /** Optional logger for internal warnings. */
  logger?: Logger | undefined;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Canonicalize a model reference so equivalent spellings dedupe. */
function normalizeRef(ref: string): string {
  return ref
    .trim()
    .replace(/\s*\/\s*/g, '/')
    .replace(/\s+/g, ' ');
}

/**
 * Validate that a model reference is in the user's favorites list (or that
 * favorites are not enforced). Returns `true` when the ref is valid.
 */
function isFavoriteRef(ref: string, config: Config): boolean {
  const favorites = config.favoriteModels ?? [];
  if (favorites.length === 0) {
    // No favorites at all means the constraint is not active — allow anything
    return true;
  }
  const canonical = normalizeModelRef(ref, config.provider);
  return favorites.some((f) => normalizeModelRef(f, config.provider) === canonical);
}

/** Build a human-friendly error listing provider/model favorites. */
function notFavoriteError(ref: string, config: Config): string {
  const favorites = config.favoriteModels ?? [];
  return (
    `"${ref}" is not in your favorites list. ` +
    (favorites.length === 0
      ? 'Add some favorites first with favorite_manage({ action: "add", model: "<provider/model>" }).'
      : `Current favorites: ${favorites.join(', ') || '(none)'}. ` +
        'Use favorite_manage to add this model first.')
  );
}

function modelList(config: Config): string[] {
  return config.favoriteModels ?? [];
}

function profileList(config: Config): Record<string, string[]> {
  return (config.fallbackProfiles ?? {}) as Record<string, string[]>;
}

function chainList(config: Config): string[] {
  return config.fallbackModels ?? [];
}

// ── 1. FAVORITE_MANAGE ──────────────────────────────────────────────────────

const FAVORITE_MANAGE_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['list', 'add', 'remove'],
      description: 'Operation to perform: list (show all), add (add a favorite), remove (remove by index or ref).',
    },
    model: {
      type: 'string',
      description:
        'Model reference to add/remove (e.g. "anthropic/claude-haiku-3", "openai/gpt-4o-mini"). ' +
        'Required for "add" and "remove" (when removing by ref).',
    },
    index: {
      type: 'number',
      description: '1-based index for removal. Alternative to `model`. Used when action="remove".',
    },
  },
  required: ['action'],
  additionalProperties: false,
};

interface FavoriteManageInput {
  action: 'list' | 'add' | 'remove';
  model?: string | undefined;
  index?: number | undefined;
}

interface FavoriteManageOutput {
  status: 'ok' | 'error';
  message: string;
  favorites?: string[];
}

function createFavoriteManageTool(opts: FallbackManageToolOptions): Tool<FavoriteManageInput, FavoriteManageOutput> {
  return {
    name: FAVORITE_MANAGE_TOOL_NAME,
    description:
      'Manage your favorite provider/model list. Favorites are the only models ' +
      'that can be added to fallback chains and profiles. The LLM uses this tool ' +
      'to curate which models are available for fallback and role assignment.',
    usageHint: 'Start with "list" to see current favorites. Use "add <provider/model>" to add. Use "remove <index|ref>" to remove.',
    category: 'Config',
    inputSchema: FAVORITE_MANAGE_SCHEMA,
    permission: 'auto',
    mutating: true,
    riskTier: 'standard',
    icon: 'settings',
    async execute(input) {
      const config = opts.getConfig();
      const favorites = [...modelList(config)];

      if (input.action === 'list') {
        const msg =
          favorites.length === 0
            ? 'No favorites set. Add one with favorite_manage({ action: "add", model: "<provider/model>" }).'
            : `Favorites (${favorites.length}):\n` + favorites.map((f, i) => `  ${i + 1}. ${f}`).join('\n');
        return { status: 'ok', message: msg, favorites: [...favorites] };
      }

      if (input.action === 'add') {
        if (!input.model) {
          return { status: 'error', message: 'Provide "model" (e.g. "anthropic/claude-haiku-3") to add a favorite.' };
        }
        const ref = normalizeRef(input.model);
        const canonical = normalizeModelRef(ref, config.provider);
        if (favorites.some((f) => normalizeModelRef(f, config.provider) === canonical)) {
          return { status: 'error', message: `"${ref}" is already a favorite.` };
        }
        favorites.push(ref);
        await opts.updateConfig((cfg) => {
          cfg.favoriteModels = favorites;
        });
        return {
          status: 'ok',
          message: `✓ Added favorite: ${ref} (${favorites.length} total)`,
          favorites: [...favorites],
        };
      }

      if (input.action === 'remove') {
        if (input.index !== undefined) {
          const idx = input.index - 1;
          if (idx < 0 || idx >= favorites.length) {
            return { status: 'error', message: `Index ${input.index} is out of range (1–${favorites.length}).` };
          }
          const [removed] = favorites.splice(idx, 1);
          await opts.updateConfig((cfg) => {
            cfg.favoriteModels = favorites;
          });
          return { status: 'ok', message: `✓ Removed favorite: ${removed}`, favorites: [...favorites] };
        }
        if (input.model) {
          const ref = normalizeRef(input.model);
          const canonical = normalizeModelRef(ref, config.provider);
          const idx = favorites.findIndex((f) => normalizeModelRef(f, config.provider) === canonical);
          if (idx === -1) {
            return { status: 'error', message: `Favorite "${ref}" not found. Use "list" to see all favorites.` };
          }
          const [removed] = favorites.splice(idx, 1);
          await opts.updateConfig((cfg) => {
            cfg.favoriteModels = favorites;
          });
          return { status: 'ok', message: `✓ Removed favorite: ${removed}`, favorites: [...favorites] };
        }
        return { status: 'error', message: 'Provide either "model" or "index" to remove a favorite.' };
      }

      return { status: 'error', message: `Unknown action: "${input.action}". Use "list", "add", or "remove".` };
    },
  };
}

// ── 2. FALLBACK_CHAIN_MANAGE ────────────────────────────────────────────────

const FALLBACK_CHAIN_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['list', 'add', 'insert', 'remove', 'clear'],
      description:
        'Operation: list (show chain), add (append), insert (insert at position), ' +
        'remove (by index or ref), clear (empty the chain).',
    },
    model: {
      type: 'string',
      description:
        'Model reference for add/insert/remove (e.g. "anthropic/claude-haiku-3"). ' +
        'Must be in your favorites list for add/insert. Required for add, insert, and remove (when removing by ref).',
    },
    index: {
      type: 'number',
      description:
        '1-based insertion position (for action="insert") or removal index (for action="remove"). ' +
        'For insert: the new entry is placed before this position. Omit to append. ' +
        'For remove: alternative to model. Omit to remove by model ref.',
    },
  },
  required: ['action'],
  additionalProperties: false,
};

interface FallbackChainInput {
  action: 'list' | 'add' | 'insert' | 'remove' | 'clear';
  model?: string | undefined;
  index?: number | undefined;
}

interface FallbackChainOutput {
  status: 'ok' | 'error';
  message: string;
  chain?: string[];
}

function createFallbackChainManageTool(opts: FallbackManageToolOptions): Tool<FallbackChainInput, FallbackChainOutput> {
  return {
    name: FALLBACK_CHAIN_MANAGE_TOOL_NAME,
    description:
      'View or change the active rate-limit fallback chain. When the primary model ' +
      'is overloaded (429/5xx), the agent rotates through this chain in order. ' +
      'Every new entry must be a FAVORITE model — add it via favorite_manage first. ' +
      'Use insert to place a fallback at a specific position; use remove to delete an entry.',
    usageHint:
      '"list" to see the current chain. "add" with a favorite model to append. ' +
      '"insert" with an index (1-based) to place before that position. ' +
      '"remove" with index or model ref. "clear" to empty the chain (auto fallback takes over).',
    category: 'Config',
    inputSchema: FALLBACK_CHAIN_SCHEMA,
    permission: 'auto',
    mutating: true,
    riskTier: 'standard',
    icon: 'settings',
    async execute(input) {
      const config = opts.getConfig();
      const chain = [...chainList(config)];

      if (input.action === 'list') {
        if (chain.length === 0) {
          return {
            status: 'ok',
            message: 'Fallback chain is empty. Add entries with "add" or enable auto fallback.',
            chain: [],
          };
        }
        const msg = chain.map((ref, i) => `  ${i + 1}. ${ref}`).join('\n');
        return { status: 'ok', message: `Fallback chain (${chain.length}):\n${msg}`, chain: [...chain] };
      }

      if (input.action === 'add') {
        if (!input.model) {
          return { status: 'error', message: 'Provide "model" (e.g. "anthropic/claude-haiku-3") to add to the chain.' };
        }
        const ref = normalizeRef(input.model);
        if (!isFavoriteRef(ref, config)) {
          return { status: 'error', message: notFavoriteError(ref, config) };
        }
        if (chain.some((e) => normalizeRef(e) === ref)) {
          return { status: 'error', message: `"${ref}" is already in the chain.` };
        }
        chain.push(ref);
        await opts.updateConfig((cfg) => {
          cfg.fallbackModels = chain;
        });
        return {
          status: 'ok',
          message: `✓ Added to chain: ${ref} (position ${chain.length})`,
          chain: [...chain],
        };
      }

      if (input.action === 'insert') {
        if (!input.model) {
          return { status: 'error', message: 'Provide "model" to insert into the chain.' };
        }
        const ref = normalizeRef(input.model);
        if (!isFavoriteRef(ref, config)) {
          return { status: 'error', message: notFavoriteError(ref, config) };
        }
        if (chain.some((e) => normalizeRef(e) === ref)) {
          return { status: 'error', message: `"${ref}" is already in the chain.` };
        }
        let pos = chain.length; // default: append
        if (input.index !== undefined) {
          pos = Math.max(0, Math.min(chain.length, input.index - 1));
        }
        chain.splice(pos, 0, ref);
        await opts.updateConfig((cfg) => {
          cfg.fallbackModels = chain;
        });
        return {
          status: 'ok',
          message: `✓ Inserted at position ${pos + 1}: ${ref}`,
          chain: [...chain],
        };
      }

      if (input.action === 'remove') {
        if (chain.length === 0) {
          return { status: 'error', message: 'Chain is empty — nothing to remove.' };
        }
        if (input.index !== undefined) {
          const idx = input.index - 1;
          if (idx < 0 || idx >= chain.length) {
            return { status: 'error', message: `Index ${input.index} is out of range (1–${chain.length}).` };
          }
          const [removed] = chain.splice(idx, 1);
          await opts.updateConfig((cfg) => {
            cfg.fallbackModels = chain;
          });
          return { status: 'ok', message: `✓ Removed: ${removed}`, chain: [...chain] };
        }
        if (input.model) {
          const ref = normalizeRef(input.model);
          const idx = chain.findIndex((e) => normalizeRef(e) === ref);
          if (idx === -1) {
            return { status: 'error', message: `"${ref}" not found in chain.` };
          }
          const [removed] = chain.splice(idx, 1);
          await opts.updateConfig((cfg) => {
            cfg.fallbackModels = chain;
          });
          return { status: 'ok', message: `✓ Removed: ${removed}`, chain: [...chain] };
        }
        return { status: 'error', message: 'Provide "index" or "model" to remove from the chain.' };
      }

      if (input.action === 'clear') {
        if (chain.length === 0) {
          return { status: 'ok', message: 'Chain is already empty.' };
        }
        await opts.updateConfig((cfg) => {
          cfg.fallbackModels = [];
        });
        return { status: 'ok', message: '✓ Cleared the fallback chain. Auto fallback will take over when enabled.' };
      }

      return { status: 'error', message: `Unknown action: "${input.action}".` };
    },
  };
}

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
    category: 'Config',
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
    category: 'Config',
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
    category: 'Config',
    inputSchema: PROVIDER_MANAGE_SCHEMA,
    permission: 'auto',
    mutating: true,
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
        const entry: Record<string, unknown> = { ...providers[input.provider] };
        if (input.models !== undefined) entry.models = input.models;
        if (input.baseUrl !== undefined) entry.baseUrl = input.baseUrl || undefined;
        if (input.family !== undefined) entry.family = input.family || undefined;
        if (input.envVars !== undefined) entry.envVars = input.envVars;
        if (input.autoDiscoverModels !== undefined) entry.autoDiscoverModels = input.autoDiscoverModels;
        if (input.apiKey !== undefined) entry.apiKey = input.apiKey || undefined;
        providers[input.provider] = entry;
        await opts.updateConfig((cfg) => {
          cfg.providers = providers;
        });
        const updated = Object.keys({ ...entry }).filter((k) => k !== 'apiKey').join(', ');
        return { status: 'ok', message: `✓ Updated ${input.provider}: ${updated}` };
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
    category: 'Config',
    inputSchema: PROVIDER_KEY_SET_SCHEMA,
    permission: 'auto',
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
    category: 'Config',
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
        await opts.updateConfig((cfg) => {
          cfg.provider = input.provider;
          cfg.model = input.model;
        });
        return { status: 'ok', message: `✓ Leader → ${input.provider}/${input.model}` };
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
        await opts.updateConfig((cfg) => {
          cfg.provider = provider;
          cfg.model = model;
          cfg.fallbackModels = rest;
        });
        return {
          status: 'ok',
          message: `✓ Leader → ${provider}/${model} (profile: ${input.profile})` +
            (rest.length > 0 ? `\n  Fallback chain: ${rest.join(' → ')}` : ''),
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

// ── 8. SYSTEM_CONFIG_VIEW ───────────────────────────────────────────────────

export const SYSTEM_CONFIG_VIEW_TOOL_NAME = 'system_config_view';

const SYSTEM_CONFIG_VIEW_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    section: {
      type: 'string',
      enum: ['all', 'providers', 'models', 'fallbacks', 'matrix', 'agents', 'refiner', 'doctor'],
      description:
        'Which section to show: all (everything), providers (configured providers + keys), ' +
        'models (favorites + leader), fallbacks (chain + profiles + toggles), ' +
        'matrix (per-role assignments), agents (every catalog agent with resolved model), ' +
        'refiner (goal refinement config), doctor (validate config and show issues/warnings). ' +
        'Default: all.',
    },
  },
  additionalProperties: false,
};

interface SystemConfigViewInput {
  section?: 'all' | 'providers' | 'models' | 'fallbacks' | 'matrix' | 'agents' | 'refiner' | 'doctor' | undefined;
}

interface SystemConfigViewOutput {
  status: 'ok';
  message: string;
}

function createSystemConfigViewTool(opts: FallbackManageToolOptions): Tool<SystemConfigViewInput, SystemConfigViewOutput> {
  return {
    name: SYSTEM_CONFIG_VIEW_TOOL_NAME,
    description:
      'Get a comprehensive view of all provider, model, fallback, and matrix configuration. ' +
      'Shows the complete state across all configurable areas so you can see what is available ' +
      'and make informed decisions when assigning models, creating fallback profiles, or ' +
      'managing providers. Use the section parameter to focus on specific areas.',
    usageHint:
      '"section: all" for everything. "section: providers" for configured providers and key status. ' +
      '"section: models" for leader model and favorites. ' +
      '"section: fallbacks" for chains, profiles, and toggles. ' +
      '"section: matrix" for per-role assignments. ' +
      '"section: refiner" for goal refinement config.',
    category: 'Config',
    inputSchema: SYSTEM_CONFIG_VIEW_SCHEMA,
    permission: 'auto',
    mutating: false,
    riskTier: 'safe',
    icon: 'settings',
    async execute(input) {
      const config = opts.getConfig();
      const section = input.section ?? 'all';
      const sections: string[] = [];
      const addSection = (title: string, content: string) => {
        sections.push(`── ${title} ──\n${content}`);
      };

      // Always show provider/model header
      addSection(
        'Leader',
        `  ${config.provider}/${config.model}`,
      );

      if (section === 'all' || section === 'providers') {
        const providers = (config.providers ?? {}) as unknown as Record<string, Record<string, unknown>>;
        const ids = Object.keys(providers);
        if (ids.length === 0) {
          addSection('Providers', '  (none configured)');
        } else {
          const lines = ids.sort().map((id) => {
            const e = providers[id] ?? {};
            const type = (e.type as string) ?? '?';
            const models = Array.isArray(e.models) ? `[${(e.models as string[]).join(', ')}]` : '(all)';
            const hasKey = e.apiKey || (Array.isArray(e.apiKeys) && e.apiKeys.length > 0) ? '✓' : '✗';
            const baseUrl = e.baseUrl ? ` url:${e.baseUrl}` : '';
            const family = e.family ? ` family:${e.family}` : '';
            const envVars = Array.isArray(e.envVars) ? ` env:[${(e.envVars as string[]).join(', ')}]` : '';
            return `  ${id === config.provider ? '★' : ' '} ${id} (${type}) key:${hasKey} models:${models}${baseUrl}${family}${envVars}`;
          });
          addSection('Providers', lines.join('\n'));
        }
      }

      if (section === 'all' || section === 'models') {
        const favorites = config.favoriteModels ?? [];
        addSection(
          'Favorites',
          favorites.length > 0
            ? favorites.map((f, i) => `  ${i + 1}. ${f}`).join('\n')
            : '  (none — use favorite_manage to add)',
        );
        addSection(
          'Settings',
          `  fallbackAuto: ${config.fallbackAuto !== false ? 'on' : 'off'}\n` +
          `  favoriteModelsOnly: ${config.favoriteModelsOnly ? 'on' : 'off'}`,
        );
      }

      if (section === 'all' || section === 'fallbacks') {
        const fallbackModels = config.fallbackModels ?? [];
        const profiles = (config.fallbackProfiles ?? {}) as Record<string, string[]>;
        addSection(
          'Fallback Chain',
          fallbackModels.length > 0
            ? fallbackModels.map((f, i) => `  ${i + 1}. ${f}`).join('\n')
            : '  (empty — auto fallback applies when fallbackAuto is on)',
        );
        const profileNames = Object.keys(profiles);
        addSection(
          'Fallback Profiles',
          profileNames.length > 0
            ? profileNames.sort().map((n) => `  ${n} → ${profiles[n]?.join(' → ') ?? '(empty)'}`).join('\n')
            : '  (none)',
        );
      }

      if (section === 'all' || section === 'matrix') {
        const matrix = (config.modelMatrix ?? {}) as Record<string, Record<string, unknown>>;
        const keys = Object.keys(matrix);
        addSection(
          'Model Matrix (role assignments)',
          keys.length > 0
            ? keys.sort().map((k) => `  ${k} → ${JSON.stringify(matrix[k])}`).join('\n')
            : '  (empty — all roles use the leader model)',
        );
      }

      if (section === 'all' || section === 'agents') {
        const roleNames = Object.keys(AGENT_CATALOG).sort();
        const lines = roleNames.map((role) => {
          const phase = phaseForRole(role) ?? '?';
          const target = resolveSubagentModelTarget(config, role);
          const model = target?.provider
            ? `${target.provider}/${target.model ?? '(default)'}`
            : `${config.provider}/${config.model ?? '(leader)'}`;
          const src = target?.diversified
            ? ' (diversified)'
            : target?.source === 'matrix'
              ? ` (matrix:${target.matrixSource ?? '?'})`
              : '';
          return `  ${role.padEnd(24)} ${phase.padEnd(14)} ${model}${src}`;
        });
        addSection(
          `Agent Models (${roleNames.length} roles)`,
          lines.length > 0
            ? `  ${'ROLE'.padEnd(24)} ${'PHASE'.padEnd(14)} RESOLVED MODEL\n` + lines.join('\n')
            : '  (no agents in catalog)',
        );
      }

      if (section === 'all' || section === 'doctor') {
        const issues: string[] = [];
        const warnings: string[] = [];
        const ok: string[] = [];
        const providers = (config.providers ?? {}) as unknown as Record<string, Record<string, unknown>>;
        const favorites = config.favoriteModels ?? [];
        const profiles = (config.fallbackProfiles ?? {}) as Record<string, string[]>;
        const chain = config.fallbackModels ?? [];
        const matrix = (config.modelMatrix ?? {}) as Record<string, Record<string, unknown>>;

        // 1. Check favorites against provider model lists
        for (const fav of favorites) {
          const p = parseRefInternal(fav);
          const provId = p.provider ?? config.provider;
          const model = p.model;
          const prov = providers[provId];
          if (!prov) {
            warnings.push(`Favorite "${fav}" references unknown provider "${provId}"`);
            continue;
          }
          const provModels = prov.models as string[] | undefined;
          if (provModels && provModels.length > 0 && !provModels.includes(model)) {
            warnings.push(`Favorite "${fav}" — model "${model}" not in ${provId} model list (${provModels.join(', ')})`);
          } else {
            ok.push(`Favorite "${fav}" — provider ${provId} is configured`);
          }
        }

        // 2. Check fallback chain entries
        for (const entry of chain) {
          const p = parseRefInternal(entry);
          const provId = p.provider ?? config.provider;
          if (!providers[provId] && provId !== config.provider) {
            issues.push(`Chain entry "${entry}" references unknown provider "${provId}"`);
          } else {
            ok.push(`Chain entry "${entry}" — provider OK`);
          }
        }

        // 3. Check fallback profile entries
        for (const [pname, pchain] of Object.entries(profiles)) {
          if (!pchain || pchain.length === 0) {
            warnings.push(`Profile "${pname}" is empty`);
            continue;
          }
          for (const entry of pchain) {
            const p = parseRefInternal(entry);
            const provId = p.provider ?? config.provider;
            if (!providers[provId] && provId !== config.provider) {
              issues.push(`Profile "${pname}" entry "${entry}" references unknown provider "${provId}"`);
            }
          }
        }

        // 4. Check matrix assignments
        for (const [key, entry] of Object.entries(matrix)) {
          const eProvider = (entry.provider as string) ?? config.provider;
          const eModel = entry.model as string | undefined;
          if (eModel) {
            const provData = providers[eProvider];
            if (!provData && eProvider !== config.provider) {
              issues.push(`Matrix "${key}" references unknown provider "${eProvider}"`);
            }
            const provModels = provData?.models as string[] | undefined;
            if (provModels && provModels.length > 0 && !provModels.includes(eModel)) {
              warnings.push(`Matrix "${key}" — model "${eModel}" not in ${eProvider} model list`);
            }
          }
          // Check fallbackProfile reference
          const eProfile = entry.fallbackProfile as string | undefined;
          if (eProfile && !profiles[eProfile]) {
            issues.push(`Matrix "${key}" references unknown fallback profile "${eProfile}"`);
          }
        }

        // 5. Check leader provider
        if (!providers[config.provider] && Object.keys(providers).length > 0) {
          warnings.push(`Leader provider "${config.provider}" has no explicit config entry`);
        }

        // 6. Summary
        const summary = `  ✓ ${ok.length} checks passed\n` +
          `  ⚠ ${warnings.length} warnings\n` +
          `  ✗ ${issues.length} issues`;
        const lines: string[] = [summary, ''];
        if (warnings.length > 0) {
          lines.push('── Warnings ──');
          lines.push(...warnings.map((w) => `  ⚠ ${w}`));
          lines.push('');
        }
        if (issues.length > 0) {
          lines.push('── Issues ──');
          lines.push(...issues.map((i) => `  ✗ ${i}`));
          lines.push('');
        }
        if (warnings.length === 0 && issues.length === 0 && ok.length > 0) {
          lines.push('  All checks passed — configuration is healthy.');
        }
        addSection('Configuration Doctor', lines.join('\n'));
      }

      if (section === 'all' || section === 'refiner') {
        const ref = config.autonomy;
        addSection(
          'Goal Refinement',
          `  refinerProvider: ${ref?.refinerProvider ?? '(same as leader)'}\n` +
          `  refinerModel: ${ref?.refinerModel ?? '(default for provider)'}\n` +
          `  refinerFallbackProfile: ${ref?.refinerFallbackProfile ?? '(none)'}`,
        );
      }

      return { status: 'ok', message: sections.join('\n\n') };
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
