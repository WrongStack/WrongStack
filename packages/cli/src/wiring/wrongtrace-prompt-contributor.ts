/**
 * Re-export shim — the WrongTrace prompt contributor moved into
 * `@wrongstack/runtime/system-prompt-contributors` so the standalone engine
 * behind WebUI/desktop carries the same observability block as the CLI.
 */

export {
  createWrongTracePromptContributor,
  type WrongTracePromptContributorOptions,
} from '@wrongstack/runtime/system-prompt-contributors';
