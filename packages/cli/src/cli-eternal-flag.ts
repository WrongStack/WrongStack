/**
 * One-shot launch into eternal autonomy via the `--eternal "<mission>"`
 * CLI flag. Writes the mission as the active goal, forces YOLO on
 * (consistent with `/autonomy eternal`), instantiates + primes the
 * `EternalAutonomyEngine`, and flips `autonomyMode='eternal'` so the
 * REPL's main loop drives the engine instead of reading user input.
 *
 * The user can still `/autonomy stop` or Ctrl+C to exit the loop normally.
 *
 * Extracted from `cli/index.ts` to make the contract — "given a flag
 * string and the wired container, launch an eternal loop" — testable
 * without spinning up the entire CLI. Returns `true` if a launch
 * happened, `false` if the flag was empty.
 */

import type { Agent } from '@wrongstack/core/agent';
import { EternalAutonomyEngine } from '@wrongstack/core/execution';
import type { JournalEntry } from '@wrongstack/core/goal';
import type { Token } from '@wrongstack/core/kernel';
import { TOKENS } from '@wrongstack/core/kernel';
import type { Compactor, Config, Logger } from '@wrongstack/core/types';
import { color } from '@wrongstack/core/utils';
import type { TerminalRenderer } from './renderer.js';
import type { AutonomyMode } from './services/autonomy-mode.js';
import { patchConfig } from './utils.js';

/**
 * The container type is structural because `@wrongstack/runtime`'s `Container`
 * is not part of the public re-export surface, and pulling the full type
 * in from `core/kernel/container` would create an awkward cross-package
 * import. The container's structural contract (`.resolve(token)`) is the
 * only thing this helper actually needs; runtime callers pass a real
 * `Container` and the cast inside the helper handles the rest.
 */
type ContainerLike = { resolve: <T>(token: Token<T>) => T };

interface EternalFlagDeps {
  /** The `--eternal` flag value (already trimmed). Empty string = no-op. */
  eternalFlag: string;
  projectRoot: string;
  agent: Agent;
  container: ContainerLike;
  renderer: TerminalRenderer;
  /**
   * Broadcast hook for engine iteration events. Typed as `unknown` rather
   * than `unknown` so callers can pass a JournalEntry-typed function
   * without contravariance noise (the engine forwards whatever it
   * produces; the caller chooses the right shape for its listener).
   */
  broadcastEternalIteration: (iter: JournalEntry) => void;
  /** Resolved max context tokens (0 = unknown; engine decides its own cap). */
  effectiveMaxContext: number;
  // Mutable references the caller owns. We update them in place and the
  // outer scope observes the change after we resolve.
  configRef: { current: Config };
  autonomyModeRef: { current: AutonomyMode };
  /**
   * Optional sink for the constructed engine. The CLI's `index.ts` does
   * not currently consume the engine outside the helper, so most callers
   * can leave this off. The flag exists so a test (or a future feature
   * that needs to keep the engine alive past the helper's return) can
   * observe the engine the helper produced without re-deriving it.
   */
  eternalEngineRef?: {
    current: EternalAutonomyEngine | undefined;
  };
  /** Logger for structured engine events. Falls back to console.error when omitted. */
  logger?: Logger | undefined;
}

export async function launchEternalFromFlag(deps: EternalFlagDeps): Promise<boolean> {
  const { eternalFlag } = deps;
  if (eternalFlag.length === 0) return false;

  const { saveGoal, emptyGoal, goalFilePath, loadGoal } = await import('@wrongstack/core/goal');
  const goalPath = goalFilePath(deps.projectRoot);
  const prior = await loadGoal(
    goalPath,
    undefined,
    deps.logger ? (msg) => deps.logger!.warn(msg) : undefined,
  );
  // Preserve journal across flag-driven re-launches so the user can run
  // `wstack --eternal "<x>"`, ctrl-c, then `wstack --eternal "<y>"` and
  // still see the prior iteration history under /goal journal.
  const next = prior
    ? {
        ...prior,
        goal: eternalFlag,
        setAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
      }
    : emptyGoal(eternalFlag);
  await saveGoal(goalPath, next);
  // Force YOLO on, matching the /autonomy eternal path. Explicit deny rules
  // still win, but YOLO itself does not ask for approval.
  const policy = deps.container.resolve(TOKENS.PermissionPolicy);
  policy.setYolo?.(true);
  deps.configRef.current = patchConfig(deps.configRef.current, { yolo: true });
  const compactor = deps.container.resolve(TOKENS.Compactor) as Compactor;
  // Brain decision support is optional — the CLI binds TOKENS.BrainArbiter
  // before this launch path runs, but bare test containers may not.
  let brain: import('@wrongstack/core/coordination').BrainArbiter | undefined;
  try {
    brain = deps.container.resolve(TOKENS.BrainArbiter);
  } catch {
    brain = undefined;
  }
  const engine = new EternalAutonomyEngine({
    agent: deps.agent,
    projectRoot: deps.projectRoot,
    compactor,
    maxContextTokens: deps.effectiveMaxContext > 0 ? deps.effectiveMaxContext : undefined,
    onIteration: deps.broadcastEternalIteration,
    brain,
    logger: deps.logger,
  });
  await engine.prime();
  if (deps.eternalEngineRef) deps.eternalEngineRef.current = engine;
  deps.autonomyModeRef.current = 'eternal';
  deps.renderer.write(
    color.red('Eternal mode launching from --eternal flag.') +
      color.dim(` Goal: ${eternalFlag.slice(0, 80)}${eternalFlag.length > 80 ? '…' : ''}`) +
      '\n',
  );
  return true;
}
