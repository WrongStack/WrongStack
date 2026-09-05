// PR 5 of Issue #29: extract the SystemPromptBuilder container
// binding (the block that runs after `resolveModeAndCapabilities()`
// returns and before the tool registry is built) into a
// dedicated helper.
//
// Why this split:
//
//   - The 48-line inline block is one of the largest
//     contiguous pieces of main() that doesn't need access
//     to anything except the container and a handful of
//     forward-declared refs (autonomyModeRef, sessionRef).
//     Lifting the binding into a helper means readers can
//     scan main() and see "the system prompt is wired here"
//     instead of having to read 48 lines of contributor
//     factories to find the same conclusion.
//
//   - The `autonomyModeRef` / `sessionRef` forward
//     declarations are an *intentional* two-step pattern:
//     the contributor factories read from a ref because the
//     refs are mutated later in main() (autonomy engine
//     setup, session bring-up) and the contributor needs
//     the *current* value, not a snapshot. The helper's
//     signature pins that contract: callers pass the
//     ref-shapes in, the helper doesn't own them.
//
//   - The closure over `wpaths` (used to compute
//     `planPath` and `goalPath`) means a refactor of
//     `wpaths`'s shape would otherwise require touching
//     main(). Pulling the wiring into a helper that takes
//     a `paths: SystemPromptBuilderPaths` argument means a
//     `wpaths` shape change is a single touchpoint.
//
//   - The helper is unit-testable: the bind closure is
//     pure (no async, no process state) so the test can
//     mock the container's `bind` and assert that the
//     builder is constructed with the right contributor
//     set, the right `modeId`/`modePrompt` props, and the
//     right `planPath` callback.
//
// Why this helper does *not* use core's `Container` /
// `MemoryStore` / `ModeStore` / `SkillLoader` types as
// direct dependencies:
//
//   - The CLI's main() has historically been the
//     canary-call-site for breaking changes in those
//     types. By declaring local `InterfaceX` placeholders
//     (see below) we ensure this helper has zero
//     compile-time coupling to the core type names, and
//     can be re-pointed at runtime by changing only the
//     call site in main(). The unit test exercises the
//     helper with fakes that satisfy the local interfaces.

import { DefaultSystemPromptBuilder, type SystemInstructionVariant } from '@wrongstack/core/agent';
import { makeAutonomyPromptContributor } from '@wrongstack/core/execution';
import type { TokenSavingTier } from '@wrongstack/core/types';
import { sessionScopedPath } from '@wrongstack/core/utils';
import type { AutonomyMode } from '../services/autonomy-mode.js';
import { createWrongTracePromptContributor } from '../wiring/wrongtrace-prompt-contributor.js';

export interface MutableRef<T> {
  current: T | undefined;
}

/**
 * Paths the SystemPromptBuilder needs from `wpaths`.
 * Kept as a structural subset so the helper doesn't depend
 * on the full WstackPaths shape (which is huge and subject
 * to change).
 */
interface SystemPromptBuilderPaths {
  projectGoal: string;
  projectSessions: string;
  globalInstructions?: string | undefined;
  inProjectInstructions?: string | undefined;
}

/**
 * Local `path.join`-shaped helper. We don't import `node:path`
 * directly so the unit test doesn't have to mock node modules.
 */
interface PathJoiner {
  join(a: string, b: string): string;
}

/**
 * Narrow adapter for the `[Project Jargon Dictionary]` block.
 *
 * Re-exported from `../wiring/domain-glossary.ts` so the helper keeps
 * its zero-coupling contract (no direct import of core's
 * `MemoryStore` / `MemoryEntry` types). The CLI provides a closure
 * over the resolved SAGE `memoryStore` that calls
 * `searchSage('domain-term', { limit })` and maps the result to the
 * canonical `MemoryEntry` shape that `renderDomainGlossary` in core
 * is typed against.
 */
import type { DomainGlossaryListProvider as DomainGlossaryAdapter } from '../wiring/domain-glossary.js';

export type { DomainGlossaryListProvider } from '../wiring/domain-glossary.js';

interface BindSystemPromptBuilderDeps {
  /**
   * The `container` from main(). The helper only calls
   * `container.bind(token, factory)`. To keep the helper
   * testable, the type is structural rather than the
   * concrete `Container` from core.
   */
  container: {
    bind(token: unknown, factory: () => unknown): void;
  };
  modeStore: unknown;
  memoryStore: unknown;
  skillLoader: unknown;
  /** Forward declaration: mutated later in main() by the
   *  session bring-up. The contributor's `planPath`
   *  callback reads from this ref so the plan path is
   *  computed against the current session, not a snapshot. */
  sessionRef: MutableRef<{ id: string } | undefined>;
  /** Forward declaration: mutated later in main() by the
   *  autonomy / eternal engine setup. The contributor's
   *  `enabled` callback reads from this ref so the ETERNAL
   *  AUTONOMY block is injected only when the current mode
   *  is `eternal` or `eternal-parallel`. */
  autonomyModeRef: MutableRef<AutonomyMode>;
  modeId: string;
  modePrompt: string;
  modelCapabilities:
    | {
        maxContextTokens: number;
        supportsTools: boolean;
        supportsVision: boolean;
        supportsReasoning: boolean;
      }
    | (() =>
        | {
            maxContextTokens: number;
            supportsTools: boolean;
            supportsVision: boolean;
            supportsReasoning: boolean;
          }
        | undefined)
    | undefined;
  /** `config.features.skills` \u2014 if false, the skillLoader
   *  is not passed to the builder. */
  skillsEnabled: boolean;
  /** `config.skills.mode` — `'progressive'` injects only a skill manifest (the agent loads bodies via the `skill` tool). */
  skillMode?: 'eager' | 'progressive' | undefined;
  /** `config.skills.eagerMaxChars` — total skill-body budget in eager mode. */
  skillEagerMaxChars?: number | undefined;
  /** `config.features.tokenSavingMode` — forwarded so prompt guidance matches tool tiering. */
  tokenSavingMode?: TokenSavingTier | boolean | undefined;
  /** `config.systemPrompt.variant` — selects system.md, system-lite.md, or system-pro.md. */
  systemPromptVariant?: SystemInstructionVariant | undefined;
  paths: SystemPromptBuilderPaths;
  /**
   * Optional narrow `domain-term` adapter for the prompt glossary block.
   * The CLI provides a closure over the resolved SAGE `memoryStore` that
   * calls `search({ query: 'domain-term', scope: 'project-memory', limit })`
   * and returns only the tagged subset, then forwards the result through the
   * `DomainGlossary.list` shape consumed by
   * `packages/core/src/core/system-prompt-glossary.ts`.
   *
   * Omit → no `[Project Jargon Dictionary]` block in the prompt.
   */
  domainGlossary?: DomainGlossaryAdapter | undefined;
  /** `path.join`-shaped helper from the runtime. */
  pathJoiner: PathJoiner;
  /** The `TOKENS.SystemPromptBuilder` token, opaque to the
   *  helper. We just need to call `container.bind(token,
   *  factory)`. */
  systemPromptBuilderToken: unknown;
}

/**
 * Bind a `DefaultSystemPromptBuilder` factory into the
 * container under the `TOKENS.SystemPromptBuilder` key.
 *
 * The factory closure is lazy \u2014 every time the system
 * prompt is built (once per turn) it reads the *current*
 * `sessionRef.current` and `autonomyModeRef.current`. This
 * matches the pre-refactor inline behavior exactly.
 */
export function bindSystemPromptBuilder(deps: BindSystemPromptBuilderDeps): void {
  deps.container.bind(
    deps.systemPromptBuilderToken,
    () =>
      new DefaultSystemPromptBuilder({
        // `as never` because the local structural type
        // placeholders above intentionally avoid importing
        // core's `Container` / `MemoryStore` / `ModeStore` /
        // `SkillLoader` types. The runtime values come from
        // main() and are guaranteed to satisfy core's
        // full-shape interfaces; the helper just needs the
        // passthrough.
        memoryStore: deps.memoryStore as never,
        // Thread the narrow domain-term adapter so the builder emits a
        // compact `[Project Jargon Dictionary]` block. `deps.domainGlossary`
        // is an optional closure over the resolved SAGE `memoryStore`
        // that returns only entries tagged `domain-term`; when omitted
        // (e.g. in tests or subagent prompts) the builder emits no block.
        domainGlossary: deps.domainGlossary as never,
        // SAGE's turn middleware is the single memory-injection channel.
        // Disable the builder's static "# Relevant Memory" section so memories
        // are injected once, per-turn, relevance-scored — not duplicated here.
        injectMemory: false,
        skillLoader: deps.skillsEnabled ? (deps.skillLoader as never) : undefined,
        skillMode: deps.skillMode,
        skillEagerMaxChars: deps.skillEagerMaxChars,
        modeStore: deps.modeStore as never,
        modeId: deps.modeId,
        modePrompt: deps.modePrompt,
        modelCapabilities: deps.modelCapabilities,
        tokenSavingMode: deps.tokenSavingMode,
        instructionPaths: {
          globalDir: deps.paths.globalInstructions,
          projectDir: deps.paths.inProjectInstructions,
          systemVariant: deps.systemPromptVariant,
        },
        planPath: () =>
          deps.sessionRef.current
            ? sessionScopedPath(
                deps.paths.projectSessions,
                deps.sessionRef.current.id,
                '.plan.json',
              )
            : undefined,
        contributors: [
          // Injects the ETERNAL AUTONOMY block when the
          // user has activated a long-running autonomy
          // engine. Without this, the per-iteration
          // directive is the only place the model sees the
          // rules \u2014 compaction can drop it and the model
          // forgets it's in autonomy mode.
          makeAutonomyPromptContributor({
            goalPath: deps.paths.projectGoal,
            // The CONVERSATION's mode first. `autonomyModeRef` is one ref for
            // the whole process — right for the CLI and the TUI, and with four
            // WebUI tabs it is whichever tab last switched, so reading it
            // alone put the eternal-autonomy block into the prompt of every
            // conversation the moment one of them went eternal.
            enabled: (ctx) => {
              const scoped = ctx.autonomy;
              if (typeof scoped === 'string') {
                return scoped === 'eternal' || scoped === 'eternal-parallel';
              }
              return (
                deps.autonomyModeRef.current === 'eternal' ||
                deps.autonomyModeRef.current === 'eternal-parallel'
              );
            },
          }),
          // Consumes the WrongTrace observability helpers: when the daemon
          // is reachable, the leader prompt carries a compact atlas digest +
          // friction summary block. Fail-open and deadline-bounded (<1s), so
          // an absent/slow daemon never stalls the boot prompt.
          createWrongTracePromptContributor({
            tokenSavingMode: deps.tokenSavingMode,
          }),
        ],
      }),
  );
}
