/**
 * `@wrongstack/runtime/wrongforge-leader` — the machine's WrongForge as the
 * conversation's leader: `--provider wrongforge --model <id>`, `/model
 * wrongforge/<id>`. WrongForge runs each turn as a task and calls the session's
 * tools back over a per-session gateway.
 *
 * The provider factory every host registers and the picker entry: one
 * implementation for the CLI and the standalone engine behind WebUI/desktop.
 * It reads the same process-wide host binding as the ACP leader
 * (`@wrongstack/runtime/acp-leader-host`).
 */
export {
  type LeaderGateway,
  startLeaderGateway,
} from './wrongforge-leader/wrongforge-leader-gateway.js';
export { wrongForgeLeaderPickable } from './wrongforge-leader/wrongforge-leader-picker.js';
export {
  createWrongForgeLeaderProviderFactory,
  WRONGFORGE_LEADER_PROVIDER_ID,
  WrongForgeLeaderProvider,
  type WrongForgeLeaderProviderOptions,
} from './wrongforge-leader/wrongforge-leader-provider.js';
export { runWrongForgeTask, WfQueueTimeout } from './wrongforge-leader/wrongforge-task.js';
