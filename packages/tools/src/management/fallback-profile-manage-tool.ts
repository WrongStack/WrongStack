import { ToolValidationError } from '@wrongstack/contracts/types/errors';
import type { JSONSchema, Tool } from '@wrongstack/contracts/types/tool';
import { isFavoriteRef, profileList } from './fallback-manage-helpers.js';
import type { FallbackManageToolOptions } from './fallback-manage-tool-options.js';

export const FALLBACK_PROFILE_MANAGE_TOOL_NAME = 'fallback_profile_manage';

const FALLBACK_PROFILE_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['list', 'set', 'delete'],
      description:
        'Operation: list (show all profiles), set (create/update), delete (remove a profile).',
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
  status: 'ok';
  message: string;
  profiles?: Record<string, string[]>;
}

export function createFallbackProfileManageTool(
  opts: FallbackManageToolOptions,
): Tool<FallbackProfileInput, FallbackProfileOutput> {
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
          throw new ToolValidationError({
            message: 'Provide "name" for the profile (e.g. "fast").',
            field: 'name',
          });
        }
        if (!input.chain || input.chain.length === 0) {
          throw new ToolValidationError({
            message: 'Provide "chain" — a non-empty array of model references.',
            field: 'chain',
          });
        }
        const invalid: string[] = [];
        for (const ref of input.chain) {
          if (!isFavoriteRef(ref, config)) {
            invalid.push(ref);
          }
        }
        if (invalid.length > 0) {
          throw new ToolValidationError({
            message:
              `The following entries are not in your favorites list:\n  ${invalid.join('\n  ')}\n\n` +
              'Add them first with favorite_manage({ action: "add", model: "<ref>" }).',
            field: 'chain',
          });
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
          throw new ToolValidationError({
            message: 'Provide "name" of the profile to delete.',
            field: 'name',
          });
        }
        if (!(input.name in profiles)) {
          throw new ToolValidationError({
            message: `Profile "${input.name}" not found.`,
            field: 'name',
          });
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

      throw new ToolValidationError({
        message: `Unknown action: "${input.action}".`,
        field: 'action',
      });
    },
  };
}
