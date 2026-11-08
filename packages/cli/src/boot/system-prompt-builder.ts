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

import type { TokenSavingTier } from '@wrongstack/contracts/types';
import { DefaultSystemPromptBuilder, type SystemInstructionVariant } from '@wrongstack/core/agent';
import { createHostSystemPromptSections } from '@wrongstack/runtime/system-prompt-contributors';
import type { AutonomyMode } from '../services/autonomy-mode.js';

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
  /** `config.systemPrompt.variant` — selects system.md, system-lite.md, system-pro.md, system-scout.md, or system-quick.md. */
  systemPromptVariant?: SystemInstructionVariant | undefined;
  /** `config.systemPrompt.includeGlobalAgents` — when false, `~/.wrongstack/AGENTS.md` is left out of the prompt. */
  includeGlobalAgents?: boolean | undefined;
  /** `config.systemPrompt.includeProjectAgents` — when false, the project's root `AGENTS.md` is left out. */
  includeProjectAgents?: boolean | undefined;
  /** `--append-system-prompt[-file]` text; appended to the host prompt only. */
  appendedInstructions?: string | undefined;
  paths: SystemPromptBuilderPaths;
  /** Project root, for the Atlas brief. Omit to leave the brief out entirely. */
  projectRoot?: string | undefined;
  /** `config.indexing.atlas` — gates and budgets the session-start brief. */
  atlas?:
    | { injectOnSessionStart?: boolean | undefined; briefMaxTokens?: number | undefined }
    | undefined;
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
        appendedInstructions: deps.appendedInstructions,
        // Toggle off = leave the user-scope AGENTS.md out entirely; the
        // builder treats `false` as "no file", `undefined` keeps the default.
        userInstructionsFile: deps.includeGlobalAgents === false ? false : undefined,
        projectInstructions: deps.includeProjectAgents !== false,
        instructionPaths: {
          globalDir: deps.paths.globalInstructions,
          projectDir: deps.paths.inProjectInstructions,
          systemVariant: deps.systemPromptVariant,
        },
        // Plan, contributors and glossary: the host-owned sections, shared
        // with the standalone engine behind WebUI/desktop so both surfaces
        // compose the same prompt from the same state.
        ...createHostSystemPromptSections({
          goalPath: deps.paths.projectGoal,
          projectSessionsDir: deps.paths.projectSessions,
          getSessionId: () => deps.sessionRef.current?.id,
          getProcessAutonomy: () => deps.autonomyModeRef.current,
          tokenSavingMode: deps.tokenSavingMode,
          projectRoot: deps.projectRoot,
          atlas: deps.atlas,
          domainGlossary: deps.domainGlossary,
        }),
      }),
  );
}
