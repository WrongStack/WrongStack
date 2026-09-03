import { isValidMatrixKey } from '../coordination/model-matrix.js';
import type { JSONSchema, Tool } from '../types/tool.js';
import { isFavoriteRef, notFavoriteError, profileList } from './fallback-manage-helpers.js';
import type { FallbackManageToolOptions } from './fallback-manage-tool-options.js';

export const AGENT_MODEL_ASSIGN_TOOL_NAME = 'agent_model_assign';

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

export function createAgentModelAssignTool(
  opts: FallbackManageToolOptions,
): Tool<AgentModelAssignInput, AgentModelAssignOutput> {
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

      const modes = [
        input.clear ? 'clear' : null,
        input.profile ? 'profile' : null,
        input.model ? 'model' : null,
      ].filter(Boolean);
      if (modes.length > 1) {
        return {
          status: 'error',
          message:
            `Conflicting assignment modes: ${modes.join(' + ')}. ` +
            'Use exactly one: clear=true, profile="name", or model="name" (optionally with provider).',
        };
      }

      if (input.role === 'list') {
        const matrix = (config.modelMatrix ?? {}) as Record<string, unknown>;
        const keys = Object.keys(matrix);
        if (keys.length === 0) {
          return {
            status: 'ok',
            message: 'No matrix assignments. All roles use the leader model.',
          };
        }
        const msg = keys
          .sort()
          .map((k) => `  ${k} → ${JSON.stringify(matrix[k])}`)
          .join('\n');
        return { status: 'ok', message: `Model matrix (${keys.length} entries):\n${msg}` };
      }

      if (!isValidMatrixKey(input.role)) {
        return {
          status: 'error',
          message:
            `"${input.role}" is not a valid matrix key. Use a catalog role (e.g. "security-scanner"), ` +
            'a phase (e.g. "review"), or "*" for the fleet-wide default.',
        };
      }

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

      if (!input.model && !input.profile && !input.provider) {
        const matrix = (config.modelMatrix ?? {}) as Record<string, unknown>;
        const entry = matrix[input.role];
        if (!entry) {
          return {
            status: 'ok',
            message: `No specific assignment for "${input.role}". It uses the leader model or phase/* fallback.`,
          };
        }
        return { status: 'ok', message: `"${input.role}" → ${JSON.stringify(entry)}` };
      }

      if (input.profile && !input.model) {
        const profiles = profileList(config);
        if (!profiles[input.profile]) {
          return {
            status: 'error',
            message: `Profile "${input.profile}" not found. Create it with fallback_profile_manage first.`,
          };
        }
        const matrix = { ...((config.modelMatrix ?? {}) as Record<string, unknown>) };
        matrix[input.role] = { fallbackProfile: input.profile };
        await opts.updateConfig((cfg) => {
          cfg.modelMatrix = matrix;
        });
        return { status: 'ok', message: `✓ "${input.role}" → profile: ${input.profile}` };
      }

      if (input.model) {
        const effectiveProvider = input.provider ?? config.provider;
        const ref = `${effectiveProvider}/${input.model}`;
        if (!isFavoriteRef(ref, config)) {
          return { status: 'error', message: notFavoriteError(ref, config) };
        }
        const matrix = { ...((config.modelMatrix ?? {}) as Record<string, unknown>) };
        const previousRuntime = (matrix[input.role] as Record<string, unknown>)?.modelRuntime;
        matrix[input.role] = input.provider
          ? {
              provider: input.provider,
              model: input.model,
              ...(previousRuntime ? { modelRuntime: previousRuntime } : {}),
            }
          : { model: input.model, ...(previousRuntime ? { modelRuntime: previousRuntime } : {}) };
        await opts.updateConfig((cfg) => {
          cfg.modelMatrix = matrix;
        });
        const display = input.provider
          ? `${input.provider}/${input.model}`
          : `${input.model} (leader provider)`;
        return { status: 'ok', message: `✓ "${input.role}" → ${display}` };
      }

      // provider without model: validate the provider is a known favorite base.
      // input.model is falsy here (guarded by above), so this is the only
      // remaining mutating path that can reach this point.
      if (input.provider) {
        const ref = `${input.provider}/`;
        if (!isFavoriteRef(ref, config)) {
          return { status: 'error', message: notFavoriteError(ref, config) };
        }
        const matrix = { ...((config.modelMatrix ?? {}) as Record<string, unknown>) };
        const previousRuntime = (matrix[input.role] as Record<string, unknown>)?.modelRuntime;
        matrix[input.role] = {
          provider: input.provider,
          ...(previousRuntime ? { modelRuntime: previousRuntime } : {}),
        };
        await opts.updateConfig((cfg) => {
          cfg.modelMatrix = matrix;
        });
        return { status: 'ok', message: `✓ "${input.role}" → ${input.provider} (provider only)` };
      }

      return {
        status: 'error',
        message: 'Provide model, profile, or clear=true for the role assignment.',
      };
    },
  };
}
