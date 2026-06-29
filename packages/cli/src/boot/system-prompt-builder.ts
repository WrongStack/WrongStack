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

import {
  DefaultSystemPromptBuilder,
  makeAutonomyPromptContributor,
  sessionScopedPath,
  type TokenSavingTier,
} from '@wrongstack/core';
import type { AutonomyMode } from '../slash-commands/autonomy.js';

export interface MutableRef<T> {
  current: T | undefined;
}

/**
 * Paths the SystemPromptBuilder needs from `wpaths`.
 * Kept as a structural subset so the helper doesn't depend
 * on the full WstackPaths shape (which is huge and subject
 * to change).
 */
export interface SystemPromptBuilderPaths {
  projectGoal: string;
  projectSessions: string;
  globalInstructions?: string | undefined;
  inProjectInstructions?: string | undefined;
}

/**
 * Local `path.join`-shaped helper. We don't import `node:path`
 * directly so the unit test doesn't have to mock node modules.
 */
export interface PathJoiner {
  join(a: string, b: string): string;
}

export interface BindSystemPromptBuilderDeps {
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
  /** `config.features.tokenSavingMode` — forwarded so prompt guidance matches tool tiering. */
  tokenSavingMode?: TokenSavingTier | boolean | undefined;
  paths: SystemPromptBuilderPaths;
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
        skillLoader: deps.skillsEnabled ? (deps.skillLoader as never) : undefined,
        modeStore: deps.modeStore as never,
        modeId: deps.modeId,
        modePrompt: deps.modePrompt,
        modelCapabilities: deps.modelCapabilities,
        tokenSavingMode: deps.tokenSavingMode,
        instructionPaths: {
          globalDir: deps.paths.globalInstructions,
          projectDir: deps.paths.inProjectInstructions,
        },
        planPath: () =>
          deps.sessionRef.current
            ? sessionScopedPath(deps.paths.projectSessions, deps.sessionRef.current.id, '.plan.json')
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
            enabled: () =>
              deps.autonomyModeRef.current === 'eternal' ||
              deps.autonomyModeRef.current === 'eternal-parallel',
          }),
        ],
      }),
  );
}
