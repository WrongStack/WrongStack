/**
 * `@wrongstack/runtime/acp-leader` — an ACP agent (Claude Code, through the
 * user's own install) as the conversation's leader: `--provider acp --model
 * claude-code`, `/model acp/claude-code` (docs/plans/acp-leader-mode.md).
 *
 * The provider factory every host registers, the host services it is bound to
 * once the agent exists, the WebUI/desktop picker entry and the pieces the
 * WrongForge leader shares. One implementation for the CLI and the standalone
 * engine behind WebUI/desktop.
 *
 * The process-wide binding alone (what the CLI needs on every exit) is the
 * light `@wrongstack/runtime/acp-leader-host` entry.
 */
export {
  confirmThroughEvents,
  type EventConfirmRequest,
  rememberConfirmAnswer,
} from './acp-leader/acp-leader-confirm.js';
export { LeaderContext, publishLeaderContext } from './acp-leader/acp-leader-context.js';
export {
  FLEET_SERVER_NAME,
  FLEET_TOOLS,
  type FleetEndpoint,
  fleetNote,
  fleetToolName,
  startFleetEndpoint,
} from './acp-leader/acp-leader-fleet.js';
export * from './acp-leader/acp-leader-host.js';
export {
  type AcpLeaderHostOptions,
  createAcpLeaderHost,
} from './acp-leader/acp-leader-host-binding.js';
export {
  acpLeaderPickable,
  buildAcpLeaderProvider,
  type PickableHostProvider,
} from './acp-leader/acp-leader-picker.js';
export {
  AcpLeaderProvider,
  type AcpLeaderProviderOptions,
  createAcpLeaderProviderFactory,
  explicitLeaderSideModel,
  isLeaderTurn,
  leaderSideModel,
} from './acp-leader/acp-leader-provider.js';
export {
  type LeaderSessionRecord,
  readLeaderSession,
  writeLeaderSession,
} from './acp-leader/acp-leader-resume.js';
export { externalSkillDirective, externalSkillLoader } from './acp-leader/acp-leader-skills.js';
export {
  agentTurnError,
  cardOutputForText,
  earlierConversation,
  latestUserText,
  StreamQueue,
  TextBlocks,
  ToolCardRelay,
  turnStopReason,
  turnUsage,
} from './acp-leader/acp-leader-stream.js';
