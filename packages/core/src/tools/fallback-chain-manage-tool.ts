import type { JSONSchema, Tool } from '../types/tool.js';
import {
  chainList,
  isFavoriteRef,
  notFavoriteError,
  normalizeRef,
} from './fallback-manage-helpers.js';
import type { FallbackManageToolOptions } from './fallback-manage-tool-options.js';

export const FALLBACK_CHAIN_MANAGE_TOOL_NAME = 'fallback_chain_manage';

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

export function createFallbackChainManageTool(
  opts: FallbackManageToolOptions,
): Tool<FallbackChainInput, FallbackChainOutput> {
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
        return {
          status: 'ok',
          message: `Fallback chain (${chain.length}):\n${msg}`,
          chain: [...chain],
        };
      }

      if (input.action === 'add') {
        if (!input.model) {
          return {
            status: 'error',
            message: 'Provide "model" (e.g. "anthropic/claude-haiku-3") to add to the chain.',
          };
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
        let pos = chain.length;
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
            return {
              status: 'error',
              message: `Index ${input.index} is out of range (1–${chain.length}).`,
            };
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
        return {
          status: 'ok',
          message: '✓ Cleared the fallback chain. Auto fallback will take over when enabled.',
        };
      }

      return { status: 'error', message: `Unknown action: "${input.action}".` };
    },
  };
}
