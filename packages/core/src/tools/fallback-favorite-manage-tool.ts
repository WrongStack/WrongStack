import { normalizeModelRef } from '../core/fallback-model.js';
import type { JSONSchema, Tool } from '../types/tool.js';
import type { FallbackManageToolOptions } from './fallback-manage-tool-options.js';
import { modelList, normalizeRef } from './fallback-manage-helpers.js';

export const FAVORITE_MANAGE_TOOL_NAME = 'favorite_manage';

const FAVORITE_MANAGE_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['list', 'add', 'remove'],
      description:
        'Operation to perform: list (show all), add (add a favorite), remove (remove by index or ref).',
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

export function createFavoriteManageTool(
  opts: FallbackManageToolOptions,
): Tool<FavoriteManageInput, FavoriteManageOutput> {
  return {
    name: FAVORITE_MANAGE_TOOL_NAME,
    description:
      'Manage your favorite provider/model list. Favorites are the only models ' +
      'that can be added to fallback chains and profiles. The LLM uses this tool ' +
      'to curate which models are available for fallback and role assignment.',
    usageHint:
      'Start with "list" to see current favorites. Use "add <provider/model>" to add. Use "remove <index|ref>" to remove.',
    category: 'config',
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
            : `Favorites (${favorites.length}):\n` +
              favorites.map((f, i) => `  ${i + 1}. ${f}`).join('\n');
        return { status: 'ok', message: msg, favorites: [...favorites] };
      }

      if (input.action === 'add') {
        if (!input.model) {
          return {
            status: 'error',
            message: 'Provide "model" (e.g. "anthropic/claude-haiku-3") to add a favorite.',
          };
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
            return {
              status: 'error',
              message: `Index ${input.index} is out of range (1–${favorites.length}).`,
            };
          }
          const [removed] = favorites.splice(idx, 1);
          await opts.updateConfig((cfg) => {
            cfg.favoriteModels = favorites;
          });
          return {
            status: 'ok',
            message: `✓ Removed favorite: ${removed}`,
            favorites: [...favorites],
          };
        }
        if (input.model) {
          const ref = normalizeRef(input.model);
          const canonical = normalizeModelRef(ref, config.provider);
          const idx = favorites.findIndex(
            (f) => normalizeModelRef(f, config.provider) === canonical,
          );
          if (idx === -1) {
            return {
              status: 'error',
              message: `Favorite "${ref}" not found. Use "list" to see all favorites.`,
            };
          }
          const [removed] = favorites.splice(idx, 1);
          await opts.updateConfig((cfg) => {
            cfg.favoriteModels = favorites;
          });
          return {
            status: 'ok',
            message: `✓ Removed favorite: ${removed}`,
            favorites: [...favorites],
          };
        }
        return {
          status: 'error',
          message: 'Provide either "model" or "index" to remove a favorite.',
        };
      }

      return {
        status: 'error',
        message: `Unknown action: "${input.action}". Use "list", "add", or "remove".`,
      };
    },
  };
}
