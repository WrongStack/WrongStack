/**
 * Moved to `@wrongstack/runtime/wrongforge-leader` so the standalone engine
 * behind WebUI/desktop leads with WrongForge the same way the CLI does. This
 * module keeps the CLI's import paths working.
 */
export {
  createWrongForgeLeaderProviderFactory,
  WRONGFORGE_LEADER_PROVIDER_ID,
  WrongForgeLeaderProvider,
  type WrongForgeLeaderProviderOptions,
} from '@wrongstack/runtime/wrongforge-leader';
