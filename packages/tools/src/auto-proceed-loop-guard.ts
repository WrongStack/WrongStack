/**
 * Auto-proceed loop guard.
 *
 * ## Problem
 *
 * The REPL and TUI both implement an "auto" autonomy mode that, after every
 * completed agent turn, feeds the next suggestion (or top auto="true" item)
 * back as a fresh prompt. When the agent emits the same `<nextsteps>` block
 * on every reply — which happens whenever the model's output is stable but
 * autonomy treats the next step as "still actionable" — the loop self-feeds
 * the same instruction 2–3 times in a row before the longer
 * `autoProceedMaxIterations` cap (default 50) trips.
 *
 * The user reports the visible symptom: the same response, including the same
 * `<nextsteps>` block, repeats. Manual input from the user is the only thing
 * that breaks out. They suspect the next-steps mechanism is the source.
 *
 * The 50-iteration cap is intentionally loose — it is a runaway safety net,
 * not a UX signal. By the time it trips, the user has already watched the
 * same response 50 times.
 *
 * ## Approach
 *
 * A small, pure, browser-safe stateful helper that records the last few
 * prompts fed through the auto-proceed / auto-submit path. It normalizes
 * prompts (whitespace, casing) so trivial rewordings are not collapsed, but
 * identical re-feeds are. When the same normalized prompt is fed
 * `repeatThreshold` (default 2) times in a row, the guard returns
 * `{ shouldHalt: true }`.
 *
 * Callers are expected to:
 *   1. Call `record(prompt)` immediately before each auto-feed.
 *   2. If `shouldHalt` is true, clear the suggestion + auto-suggestion store,
 *      cancel any pending countdown, and surface a "we detected a loop"
 *      message asking the user what's happening. Do NOT feed the prompt.
 *   3. Call `reset()` whenever the user types anything manually (REPL manual
 *      input or any user-driven submit) so the next auto-feed starts clean.
 *
 * The default `repeatThreshold` is 2 — i.e. the second consecutive identical
 * feed (the first re-feed of an already-seen prompt) halts the loop. That
 * matches the user's report ("receiving the same prompt 2-3 times in a row
 * causes the system to enter a loop"). Setting it to 2 catches the loop on
 * the first identical re-feed rather than after the 50-iteration runaway cap trips.
 *
 * The window size is intentionally small (default 3). The loop we care about
 * is the immediate repetition — a longer history would misfire on legitimate
 * "do X, then do Y, then do X" sequences the model occasionally returns to.
 *
 * This module is BROWSER-SAFE — no Node-only imports — so it can be imported
 * from Vite-bundled WebUI as well as Node-based CLI/TUI.
 */

/**
 * Normalize a prompt for repetition comparison. Whitespace is collapsed and
 * trimmed; case is folded to lowercase. Nothing semantic is removed, so two
 * prompts that differ in any meaningful way (extra word, different code,
 * different file path) compare as distinct. Two prompts that differ only by
 * leading/trailing whitespace and casing are treated as identical.
 */
export function normalizeForRepetition(prompt: string): string {
  return prompt.replace(/\s+/g, ' ').trim().toLowerCase();
}

export interface LoopGuardOptions {
  /**
   * How many consecutive identical prompts (after normalization) trigger a
   * halt. Default 2 — i.e. the second consecutive identical feed (the first
   * re-feed of an already-seen prompt) halts the loop. Clamped to >= 2.
   */
  repeatThreshold?: number;
  /**
   * How many of the most recent feeds to retain for comparison. The window
   * is searched from newest to oldest; the guard cares about the run of
   * identical entries ending at the most recent one, not about identical
   * entries anywhere in history. Default 3.
   */
  windowSize?: number;
}

export interface RepetitionSignal {
  /** The normalized prompt that just got recorded. */
  normalized: string;
  /**
   * Number of consecutive identical feeds ending at the most recent feed,
   * including this one. Always >= 1.
   */
  runLength: number;
  /**
   * True when the run length has crossed `repeatThreshold`. Callers must
   * stop feeding and surface a user prompt instead.
   */
  shouldHalt: boolean;
}

/**
 * Steer text appended (once) to a grounded todo continuation when the board
 * has not moved between two consecutive automatic turns. Grounded prompts are
 * synthesized from durable todo state, so an identical re-feed means the whole
 * previous turn produced zero board movement — usually the model worked but
 * forgot to update the board. One explicit steer fixes that far more often
 * than halting; the halt only fires if the board stays frozen AFTER the steer.
 */
export const GROUNDED_NO_PROGRESS_STEER = [
  'NOTE: The todo board has not changed since the previous automatic continuation — this exact instruction is being repeated.',
  'Before anything else, bring the board up to date so the loop stays grounded:',
  '- mark work that is actually finished as completed,',
  '- split the current item into smaller concrete sub-items if it needs more than one turn,',
  '- remove or reword items that no longer apply.',
  'Then continue the work. If you are blocked, state exactly what is blocking you instead of repeating the same turn.',
].join('\n');

export type GroundedRepetitionAction = 'feed' | 'steer' | 'halt';

export interface GroundedRepetitionSignal extends RepetitionSignal {
  /**
   * What the caller should do with this grounded (todo-sourced) prompt:
   *   - `feed`  — no repetition; feed the prompt as-is.
   *   - `steer` — first repetition; feed the prompt with
   *     {@link GROUNDED_NO_PROGRESS_STEER} appended instead of halting.
   *   - `halt`  — the board stayed frozen even after a steer; break the loop
   *     exactly like a `shouldHalt` from {@link AutoProceedLoopGuard.record}.
   */
  action: GroundedRepetitionAction;
}

export interface AutoProceedLoopGuard {
  /**
   * Record a prompt that is about to be auto-fed. Returns the repetition
   * signal for that prompt. When `shouldHalt` is true the caller MUST NOT
   * feed the prompt — it has been recorded for post-mortem inspection, but
   * the loop must be broken instead.
   */
  record(prompt: string): RepetitionSignal;
  /**
   * Record a GROUNDED prompt — one synthesized from durable state (the todo
   * board) rather than echoed from model output. Repetition of a grounded
   * prompt is a "no board progress" signal, not necessarily an echo loop, so
   * the first repetition asks the caller to steer (append
   * {@link GROUNDED_NO_PROGRESS_STEER} to the fed text) and only a repetition
   * that survives the steer halts. The steer state resets whenever a
   * different prompt is recorded (board moved) or on {@link reset}.
   */
  recordGrounded(prompt: string): GroundedRepetitionSignal;
  /**
   * Drop the history. Call this on any manual user input so a fresh run
   * starts with no memory of the prior cycle.
   */
  reset(): void;
  /**
   * Read-only view of the most recent normalized prompts (newest last).
   * Useful for diagnostics and for the message shown to the user when the
   * guard halts the loop.
   */
  history(): readonly string[];
  /**
   * How many entries the guard is currently retaining.
   */
  size(): number;
}

/**
 * Build a fresh loop guard. Defaults: `repeatThreshold = 2`, `windowSize = 3`.
 *
 * @example
 *   const guard = createAutoProceedLoopGuard();
 *   for (const prompt of candidates) {
 *     const signal = guard.record(prompt);
 *     if (signal.shouldHalt) {
 *       haltAutoProceedAndAskUser(signal);
 *       break;
 *     }
 *     feedPrompt(prompt);
 *   }
 */
export function createAutoProceedLoopGuard(options: LoopGuardOptions = {}): AutoProceedLoopGuard {
  // Validate options defensively. Non-finite values (NaN, Infinity) MUST
  // fall back to the documented default — a guard that silently disables
  // itself is worse than no guard at all. Specifically:
  //   - `repeatThreshold: NaN` would cause `Math.floor(NaN) = NaN`,
  //     `Math.max(2, NaN) = NaN`, and `runLength >= NaN` is always false,
  //     making the guard permanent no-op.
  //   - `windowSize: NaN` / `Infinity` would skip the trim branch entirely
  //     (`buffer.length > NaN` and `buffer.length > Infinity` are both
  //     false), so the buffer would grow without bound.
  const safeIntegerOption = (value: number | undefined, fallback: number): number => {
    if (value === undefined) return fallback;
    if (!Number.isFinite(value)) return fallback;
    return Math.floor(value);
  };
  const repeatThreshold = Math.max(2, safeIntegerOption(options.repeatThreshold, 2));
  const windowSize = Math.max(repeatThreshold, safeIntegerOption(options.windowSize, 3));
  let buffer: string[] = [];
  // Normalized grounded prompt we already steered for; a halt only fires for
  // a grounded prompt that repeats again AFTER its steer.
  let steeredFor: string | null = null;

  function record(prompt: string): RepetitionSignal {
    const normalized = normalizeForRepetition(prompt);
    buffer.push(normalized);
    if (buffer.length > windowSize) {
      buffer = buffer.slice(buffer.length - windowSize);
    }
    // Count the trailing run of identical normalized prompts.
    let runLength = 0;
    for (let i = buffer.length - 1; i >= 0; i--) {
      if (buffer[i] === normalized) runLength++;
      else break;
    }
    return {
      normalized,
      runLength,
      shouldHalt: runLength >= repeatThreshold,
    };
  }

  function recordGrounded(prompt: string): GroundedRepetitionSignal {
    const signal = record(prompt);
    if (!signal.shouldHalt) {
      // The board moved (different prompt) — clear any pending steer state.
      steeredFor = null;
      return { ...signal, shouldHalt: false, action: 'feed' };
    }
    if (steeredFor === signal.normalized) {
      return { ...signal, action: 'halt' };
    }
    steeredFor = signal.normalized;
    return { ...signal, shouldHalt: false, action: 'steer' };
  }

  function reset(): void {
    buffer = [];
    steeredFor = null;
  }

  function history(): readonly string[] {
    return buffer.slice();
  }

  function size(): number {
    return buffer.length;
  }

  return { record, recordGrounded, reset, history, size };
}
