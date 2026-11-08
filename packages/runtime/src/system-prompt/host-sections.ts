/**
 * The host-owned sections of the leader's system prompt.
 *
 * `DefaultSystemPromptBuilder` renders what it is given; which session plan,
 * which contributors and which glossary it is given is a host decision. The CLI
 * (`bindSystemPromptBuilder`) and the standalone engine behind WebUI/desktop
 * (`webui-server`'s boot builder and `rebuildSystemPrompt`) both take their
 * answer from here, so the same config and state yield the same prompt
 * sections on every surface. Before, the standalone built the prompt with none
 * of them: no ETERNAL AUTONOMY block, no re-injected session plan, no
 * WrongTrace digest, no Atlas brief, no `[Project Jargon Dictionary]`.
 *
 * Prompt-cache safety is the builder's: the plan, contributor and glossary
 * blocks all land in its `volatile` tail, after every cache breakpoint, and the
 * contributor order below is fixed.
 */

import type {
  MemoryPort,
  SystemPromptContributor,
  TokenSavingTier,
} from '@wrongstack/contracts/types';
import { type DefaultSystemPromptBuilder, isUnattendedAutonomy } from '@wrongstack/core/agent';
import { makeAutonomyPromptContributor } from '@wrongstack/core/execution';
import { sessionScopedPath } from '@wrongstack/core/utils';
import { createAtlasPromptContributor } from './atlas-prompt-contributor.js';
import { createDomainGlossaryAdapter, type DomainGlossaryListProvider } from './domain-glossary.js';
import { createWrongTracePromptContributor } from './wrongtrace-prompt-contributor.js';

export interface HostSystemPromptSectionsInput {
  /** `wpaths.projectGoal` — the goal the ETERNAL AUTONOMY block reads. */
  goalPath: string;
  /** `wpaths.projectSessions` — where `<sessionId>.plan.json` lives. */
  projectSessionsDir: string;
  /** The session whose plan is re-injected, read at build time (never a snapshot). */
  getSessionId: () => string | undefined;
  /**
   * The process-wide autonomy mode, consulted only when the conversation
   * carries none (`ctx.autonomy`). The CLI/TUI have one; a multi-tab host has
   * only per-conversation modes and omits it.
   */
  getProcessAutonomy?: (() => unknown) | undefined;
  /** The concrete tier the tool surface was built with. */
  tokenSavingMode?: TokenSavingTier | boolean | undefined;
  /** Project root for the Atlas brief. Omit to leave the brief out entirely. */
  projectRoot?: string | undefined;
  /** `config.indexing.atlas` — gates and budgets the brief. */
  atlas?:
    | { injectOnSessionStart?: boolean | undefined; briefMaxTokens?: number | undefined }
    | undefined;
  /** An explicit glossary source. Wins over `memoryStore`. */
  domainGlossary?: DomainGlossaryListProvider | undefined;
  /** SAGE store the `[Project Jargon Dictionary]` is read from, when no explicit source is given. */
  memoryStore?: MemoryPort | undefined;
}

/** The builder's glossary slot (typed as the full store; only `list()` is read). */
type BuilderGlossary = NonNullable<
  ConstructorParameters<typeof DefaultSystemPromptBuilder>[0]
>['domainGlossary'];

export interface HostSystemPromptSections {
  planPath: () => string | undefined;
  contributors: SystemPromptContributor[];
  domainGlossary?: BuilderGlossary;
}

/** Builder options for the host-owned prompt sections, in their fixed order. */
export function createHostSystemPromptSections(
  input: HostSystemPromptSectionsInput,
): HostSystemPromptSections {
  const domainGlossary =
    input.domainGlossary ??
    (input.memoryStore ? createDomainGlossaryAdapter(input.memoryStore) : undefined);
  return {
    planPath: () => {
      const sessionId = input.getSessionId();
      return sessionId
        ? sessionScopedPath(input.projectSessionsDir, sessionId, '.plan.json')
        : undefined;
    },
    contributors: [
      // The ETERNAL AUTONOMY block while the conversation runs eternal or
      // eternal-parallel autonomy. Without it the per-iteration directive is
      // the only place the model sees the rules — compaction can drop it and
      // the model forgets it is in autonomy mode. The CONVERSATION's mode
      // first: with four tabs on one process a process-wide ref is whichever
      // tab last switched.
      makeAutonomyPromptContributor({
        goalPath: input.goalPath,
        enabled: (ctx) => isUnattendedAutonomy(ctx.autonomy, input.getProcessAutonomy?.()),
      }),
      // Atlas digest + friction summary from the WrongTrace daemon when it is
      // reachable. Fail-open and deadline-bounded, so an absent or slow daemon
      // never stalls a prompt build.
      createWrongTracePromptContributor({ tokenSavingMode: input.tokenSavingMode }),
      // The repository's shape (packages, hub files, subsystem purposes) in
      // front of the agent instead of rediscovered by search every session.
      // Fail-open and deadline-bounded: no index simply contributes nothing.
      ...(input.projectRoot === undefined
        ? []
        : [
            createAtlasPromptContributor({
              projectRoot: input.projectRoot,
              enabled: input.atlas?.injectOnSessionStart ?? true,
              ...(input.atlas?.briefMaxTokens !== undefined
                ? { maxTokens: input.atlas.briefMaxTokens }
                : {}),
              tokenSavingMode: input.tokenSavingMode,
            }),
          ]),
    ],
    // `renderDomainGlossary` reads `list('project-memory', limit)` and nothing else.
    ...(domainGlossary ? { domainGlossary: domainGlossary as unknown as BuilderGlossary } : {}),
  };
}
