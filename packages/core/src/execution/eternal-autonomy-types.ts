import type { Agent } from '../core/agent.js';
import type { EventBus } from '../kernel/events.js';
import type { Logger } from '../types/logger.js';
import type { Compactor } from '../types/compactor.js';
import type { BrainArbiter } from '../coordination/brain.js';
import type { JournalEntry } from '../storage/goal-store.js';

export interface EternalAutonomyOptions {
  agent: Agent;
  projectRoot: string;
  /**
   * Per-iteration agent timeout. Defaults to 5 minutes. A single hung
   * provider call should not freeze the whole eternal loop.
   */
  iterationTimeoutMs?: number | undefined;
  /**
   * Maximum number of internal agent.run iterations the engine grants per
   * eternal-loop tick. The engine sets `autonomousContinue: true` so the
   * agent can run multi-step tasks end-to-end within one tick instead of
   * bouncing back to the engine after every single tool call. Default 500.
   * Previous 50 was far too low — agents hit the limit and restart constantly.
   */
  iterationMaxAgentSteps?: number | undefined;
  /**
   * Minimum sleep between iterations. Defaults to 1 s — enough for
   * SIGINT handlers to fire mid-loop without pegging a core when the
   * provider is being rate-limited.
   */
  cycleGapMs?: number | undefined;
  /**
   * Cool-down sleep when an iteration ends without a decision (no todos,
   * clean git tree, brainstorm found nothing actionable). Defaults to
   * 5 s so a starved eternal loop idles instead of hot-spinning on the
   * decide path. Tests pass 0 to keep no-task scenarios fast.
   */
  noTaskCoolDownMs?: number | undefined;
  /**
   * Maximum consecutive failures before the source rotation forces a
   * brainstorm cycle. Default 3. Acts as a soft-recovery, not a stop.
   */
  failureBudget?: number | undefined;
  /**
   * Per-todo failed-attempt ceiling. When the engine picks the same todo
   * and the iteration fails this many times in total, the todo is taken
   * out of rotation (engine prefers other sources) until it changes
   * status. Default 3. Prevents the loop from spinning forever on one
   * stuck task.
   */
  todoMaxAttempts?: number | undefined;
  /**
   * Consecutive brainstorm-DONE responses required to consider the goal
   * complete and stop the engine. When the LLM's brainstorm step keeps
   * answering `DONE`, the engine treats that as "no more work" and, after
   * this many in a row, marks the goal as completed instead of sleeping
   * forever. Default 3.
   */
  brainstormDoneStopThreshold?: number | undefined;
  /** Side-channel notifications (logging, UI updates). */
  onIteration?: (((entry: JournalEntry) => void)) | undefined;
  onError?: (err: Error | undefined, iteration: number) => void;
  /**
   * Per-iteration phase notifications for live UI updates (TUI status bar,
   * etc.). Fires at each major stage transition: idle → decide → execute →
   * reflect → (sleep | paused | stopped). Fire-and-forget — the engine
   * does not await the callback.
   */
  onStage?: (((stage: IterationStage) => void)) | undefined;
  /**
   * Optional injected git status reader — production code uses git, tests
   * stub this out so they don't shell out.
   */
  gitStatusReader?: ((() => Promise<string>)) | undefined;
  /**
   * Optional clock — tests stub for deterministic timestamps.
   */
  now?: ((() => Date)) | undefined;
  /** Logger for structured warnings/errors. Falls back to console.error when omitted. */
  logger?: Logger | undefined;
  /**
   * Optional compactor. When provided, the engine runs compaction every
   * `compactEveryNIterations` iterations to keep the agent's message
   * history under control during multi-day eternal loops. Without
   * compaction, an infinite loop will eventually overflow the provider's
   * context window and start failing.
   */
  compactor?: Compactor | undefined;
  /** How many iterations between compaction calls. Default 25. */
  compactEveryNIterations?: number | undefined;
  /**
   * Aggressive compaction threshold. When ctx token usage exceeds this
   * fraction of `maxContextTokens`, compaction runs in aggressive mode
   * regardless of the iteration cadence. 0.85 by default.
   */
  aggressiveCompactRatio?: number | undefined;
  /**
   * Model's max context window in tokens. When set, the engine watches
   * `currentRequestTokens()` against this and triggers aggressive compact
   * before the next iteration would overflow. Omit to disable threshold
   * checks (iteration cadence still applies).
   */
  maxContextTokens?: number | undefined;
  /**
   * Base delay (ms) for the first transient-error backoff. Subsequent
   * transient failures double this, capped at `transientBackoffMaxMs`.
   * Default 2_000.
   *
   * "Transient" means the underlying error is recoverable per
   * `WrongStackError.recoverable` (ProviderError sets this for 429/529/5xx
   * /network errors). Permanent errors (auth/invalid request) skip the
   * backoff and count toward `failureBudget` like before — backing off
   * on a permanent failure is wasted time.
   */
  transientBackoffBaseMs?: number | undefined;
  /** Ceiling for the exponential backoff. Default 60_000 (60 s). */
  transientBackoffMaxMs?: number | undefined;
  /** Called when the eternal loop stops for any reason (manual stop, goal complete, etc.). */
  onEternalStop?: ((() => void)) | undefined;
  /**
   * Optional brain arbiter for autonomous decision-making. When wired,
   * the engine consults the brain instead of auto-stopping on:
   * - Brainstorm DONE threshold reached
   * - Consecutive failures exceeding failure budget
   * - Goal completion verification
   * Without a brain, the engine uses its built-in heuristics.
   */
  brain?: BrainArbiter | undefined;
  /** Optional EventBus for emitting storage.* observability events from goal I/O. */
  events?: EventBus | undefined;
}

export type EternalEngineState = 'idle' | 'running' | 'stopped';

/**
 * Per-iteration phase emitted via `onStage` so UIs can render the
 * engine's live location in the sense-decide-execute-reflect loop.
 */
export type IterationStage =
  | { phase: 'idle' }
  | { phase: 'decide'; reason: string }
  | { phase: 'execute'; task: string }
  | { phase: 'reflect'; status: 'success' | 'failure' | 'aborted' | 'skipped'; note?: string | undefined }
  | { phase: 'sleep'; ms: number }
  | { phase: 'paused' }
  | { phase: 'stopped' }
  | { phase: 'error'; message: string };
