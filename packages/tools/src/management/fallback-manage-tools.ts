/**
 * LLM-accessible tools covering every provider/model/fallback configurable area
 * in the system: favorites, fallback chains & profiles, provider management,
 * API key handling, leader model, per-role model assignment, and system view.
 */
import type { Tool } from '@wrongstack/contracts/types/tool';
import {
  AGENT_MODEL_ASSIGN_TOOL_NAME,
  createAgentModelAssignTool,
} from './fallback-agent-model-assign-tool.js';
import {
  createFallbackChainManageTool,
  FALLBACK_CHAIN_MANAGE_TOOL_NAME,
} from './fallback-chain-manage-tool.js';
import {
  createFavoriteManageTool,
  FAVORITE_MANAGE_TOOL_NAME,
} from './fallback-favorite-manage-tool.js';
import {
  createLeaderModelSetTool,
  LEADER_MODEL_SET_TOOL_NAME,
} from './fallback-leader-model-set-tool.js';
import {
  createFallbackProfileManageTool,
  FALLBACK_PROFILE_MANAGE_TOOL_NAME,
} from './fallback-profile-manage-tool.js';
import {
  createProviderKeySetTool,
  PROVIDER_KEY_SET_TOOL_NAME,
} from './fallback-provider-key-set-tool.js';
import {
  createProviderManageTool,
  PROVIDER_MANAGE_TOOL_NAME,
  validateProviderBaseUrl,
} from './fallback-provider-manage-tool.js';
import { createSystemConfigViewTool } from './fallback-system-config-view-tool.js';
import {
  createLeaderEffortSetTool,
  LEADER_EFFORT_SET_TOOL_NAME,
  type LeaderEffortSetToolOptions,
} from './leader-effort-set-tool.js';
import type { ModelTierSetToolOptions } from './model-tier-set-tool.js';
import { createModelTierSetTool } from './model-tier-set-tool.js';

export type { FallbackManageToolOptions } from './fallback-manage-tool-options.js';
export * from './fallback-system-config-view-tool.js';
export {
  AGENT_MODEL_ASSIGN_TOOL_NAME,
  FALLBACK_CHAIN_MANAGE_TOOL_NAME,
  FALLBACK_PROFILE_MANAGE_TOOL_NAME,
  FAVORITE_MANAGE_TOOL_NAME,
  LEADER_EFFORT_SET_TOOL_NAME,
  LEADER_MODEL_SET_TOOL_NAME,
  PROVIDER_KEY_SET_TOOL_NAME,
  PROVIDER_MANAGE_TOOL_NAME,
  validateProviderBaseUrl,
};

/**
 * Create all 10 provider/model/fallback management tools that LLMs can call.
 *
 * Register them all in the tool registry:
 * ```ts
 * const tools = createFallbackManageTools({ getConfig, updateConfig });
 * for (const tool of tools) toolRegistry.register(tool);
 * ```
 */
// Takes the tier tool's option bag, which EXTENDS FallbackManageToolOptions with
// optional live inputs (context size, turn counter, model prices). Callers that
// supply only the base options keep working; the tier guards then fall back to
// their structural checks.
export function createFallbackManageTools(
  opts: ModelTierSetToolOptions & LeaderEffortSetToolOptions,
): Tool[] {
  return [
    createFavoriteManageTool(opts),
    createFallbackChainManageTool(opts),
    createFallbackProfileManageTool(opts),
    createAgentModelAssignTool(opts),
    createProviderManageTool(opts),
    createProviderKeySetTool(opts),
    createLeaderModelSetTool(opts),
    createLeaderEffortSetTool(opts),
    createModelTierSetTool(opts),
    createSystemConfigViewTool(opts),
  ];
}
