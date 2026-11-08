/**
 * Moved to `@wrongstack/runtime/acp-leader` so the standalone engine behind
 * WebUI/desktop leads with an ACP agent the same way the CLI does. This module
 * keeps the CLI's import paths working.
 */
export {
  acpLeaderPickable,
  buildAcpLeaderProvider,
  isHostBuiltLeader,
  type PickableHostProvider,
} from '@wrongstack/runtime/acp-leader';
