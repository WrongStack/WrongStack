/**
 * Moved to `@wrongstack/runtime/acp-leader` so the standalone engine behind
 * WebUI/desktop leads with an ACP agent the same way the CLI does. This module
 * keeps the CLI's import paths working.
 */
export {
  ACP_LEADER_PROVIDER_ID,
  AcpLeaderProvider,
  type AcpLeaderProviderOptions,
  createAcpLeaderProviderFactory,
  explicitLeaderSideModel,
  isLeaderTurn,
  leaderSideModel,
} from '@wrongstack/runtime/acp-leader';
