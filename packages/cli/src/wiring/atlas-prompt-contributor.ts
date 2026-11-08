/**
 * Re-export shim — the Atlas prompt contributor moved into
 * `@wrongstack/runtime/system-prompt-contributors` so the standalone engine
 * behind WebUI/desktop puts the same brief in its prompt as the CLI.
 */

export {
  type AtlasPromptContributorOptions,
  createAtlasPromptContributor,
  DEFAULT_BRIEF_MAX_TOKENS,
  renderAtlasBrief,
} from '@wrongstack/runtime/system-prompt-contributors';
