import type { JSONSchema, Tool } from '../types/tool.js';
import type { FallbackManageToolOptions } from './fallback-manage-tool-options.js';
import { parseRefInternal } from './fallback-model-ref-parse.js';

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
      description:
        'Fallback profile name to derive the leader + chain from. Required for "profile".',
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

export function createLeaderModelSetTool(
  opts: FallbackManageToolOptions,
): Tool<LeaderModelSetInput, LeaderModelSetOutput> {
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
        const first = chain[0]!;
        const p = parseRefInternal(first);
        const provider = p.provider ?? config.provider;
        const model = p.model;
        if (!model) {
          return {
            status: 'error',
            message: `Cannot parse "${first}" as a valid model reference.`,
          };
        }
        const rest = chain.slice(1);
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
          message:
            `✓ Leader → ${provider}/${model} (profile: ${input.profile})` +
            (rest.length > 0 ? `\n  Fallback chain: ${rest.join(' → ')}` : '') +
            profileLiveNote,
        };
      }

      if (input.action === 'toggle') {
        if (!input.toggle || input.value === undefined) {
          return {
            status: 'error',
            message: 'Provide "toggle" (fallbackAuto | favoriteModelsOnly) and "value" (boolean).',
          };
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
