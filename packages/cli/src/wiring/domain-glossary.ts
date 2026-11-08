/**
 * Re-export shim — the `[Project Jargon Dictionary]` adapter moved into
 * `@wrongstack/runtime/system-prompt-contributors` so the standalone engine
 * behind WebUI/desktop renders the same glossary as the CLI.
 */

export {
  createDomainGlossaryAdapter,
  type DomainGlossaryListProvider,
} from '@wrongstack/runtime/system-prompt-contributors';
