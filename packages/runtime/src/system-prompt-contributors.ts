/**
 * `@wrongstack/runtime/system-prompt-contributors` — the host-owned sections
 * of the leader's system prompt, shared by the CLI and the standalone engine.
 */

export {
  type AtlasPromptContributorOptions,
  createAtlasPromptContributor,
  DEFAULT_BRIEF_MAX_TOKENS,
  renderAtlasBrief,
} from './system-prompt/atlas-prompt-contributor.js';
export {
  createDomainGlossaryAdapter,
  type DomainGlossaryListProvider,
} from './system-prompt/domain-glossary.js';
export {
  createHostSystemPromptSections,
  type HostSystemPromptSections,
  type HostSystemPromptSectionsInput,
} from './system-prompt/host-sections.js';
export {
  createWrongTracePromptContributor,
  type WrongTracePromptContributorOptions,
} from './system-prompt/wrongtrace-prompt-contributor.js';
