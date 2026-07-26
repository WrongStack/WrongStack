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
// ── Continuation-attempt tracker ───────────────────────────────────────
//
// Tracks per-todo how many times auto-submit has continued on it, so
// advancement prompts can vary wording and report "attempt N" rather than
// feeding an identical instruction. Resets on manual user input.

export interface ContinuationAttemptTracker {
  /** Record an attempt against a todo. Returns the new attempt count (≥ 1). */
  recordAttempt(todoId: string): number;
  /** How many times continuation has been attempted for this todo (0 = never). */
  getAttempts(todoId: string): number;
  /** Mark a todo as "skipped" — a later attempt tried advancing past it. */
  markSkipped(todoId: string): void;
  /** True when this todo has been skipped due to no board progress. */
  isSkipped(todoId: string): boolean;
  /** Reset every tracked todo (call on manual user input). */
  reset(): void;
  /** Read-only snapshot for diagnostic use. */
  snapshot(): Record<string, { attempts: number; skipped: boolean }>;
}

export function createContinuationAttemptTracker(): ContinuationAttemptTracker {
  const attempts = new Map<string, number>();
  const skipped = new Set<string>();

  return {
    recordAttempt(todoId: string): number {
      const count = (attempts.get(todoId) ?? 0) + 1;
      attempts.set(todoId, count);
      return count;
    },
    getAttempts(todoId: string): number {
      return attempts.get(todoId) ?? 0;
    },
    markSkipped(todoId: string): void {
      skipped.add(todoId);
    },
    isSkipped(todoId: string): boolean {
      return skipped.has(todoId);
    },
    reset(): void {
      attempts.clear();
      skipped.clear();
    },
    snapshot(): Record<string, { attempts: number; skipped: boolean }> {
      const result: Record<string, { attempts: number; skipped: boolean }> = {};
      const allIds = new Set([...attempts.keys(), ...skipped]);
      for (const id of allIds) {
        result[id] = { attempts: attempts.get(id) ?? 0, skipped: skipped.has(id) };
      }
      return result;
    },
  };
}

// ── Advancement prompt generator ────────────────────────────────────────
//
// When a grounded (todo-sourced) prompt stalls because the board hasn't
// moved, instead of halting we advance to the next open todo and generate
// a varied prompt that references the stalled item's attempt count. The
// wording rotates through a pool so identical todos produce different
// text across attempts.

const ADVANCE_PREAMBLES = [
  'Pivoting to the next open item — previous todo still pending after {attempts} attempt(s).',
  'Shifting focus to a different task while the previous item ({label}) remains open after {attempts} attempt(s).',
  'No board progress on the current item after {attempts} attempt(s). Continuing with the next todo.',
  'The previous item is still unresolved after {attempts} try(ies). Moving on down the list.',
  'Advancing to the next piece of work after {attempts} unproductive attempt(s) on the prior one.',
  'Taking a different angle — the stalled item ({label}) stays open after {attempts} attempt(s). Pressing ahead.',
  'The todo board shows no movement on the current task after {attempts} attempt(s). Switching gears.',
  'No change on the board from the last {attempts} continuation(s). Proceeding to the next open item.',
];

/**
 * Build a continuation-advancement prompt when the normal todo-sourced
 * prompt has stalled (no board progress). The text varies by attempt count
 * to avoid triggering the repetition guard.
 *
 * @param stalledTodo   The todo that didn't progress (used for its id/label).
 * @param nextTodo      The next open todo to advance to, or null if none left.
 * @param attemptCount  How many times stalledTodo has been retried.
 * @param todos         The full current todo list for board context.
 * @returns A varied advancement prompt for the next auto-feed.
 */
export function generateAdvancementPrompt(
  stalledTodo: { id: string; content: string },
  nextTodo: { id: string; content: string; status: string; activeForm?: string | undefined } | null,
  attemptCount: number,
  todos: readonly { id: string; content: string; status: string; activeForm?: string | undefined }[],
): string {
  const idx = Math.max(0, Math.min(attemptCount - 1, ADVANCE_PREAMBLES.length - 1));
  const preamble = ADVANCE_PREAMBLES[idx]!
    .replace(/\{attempts\}/g, () => String(attemptCount))
    .replace(/\{label\}/g, () => stalledTodo.content.slice(0, 72));

  if (!nextTodo) {
    return [
      preamble,
      '',
      'No more open items remain on the todo list. What has been accomplished and what should I do next?',
    ].join('\n');
  }

  const itemLabel =
    nextTodo.status === 'in_progress' && nextTodo.activeForm
      ? nextTodo.activeForm
      : nextTodo.content;

  const done = todos.filter((t) => t.status === 'completed').length;
  const total = todos.length;

  const lines: string[] = [preamble, '', `Proceed with: ${itemLabel}`];

  if (total > 0) {
    lines.push('', `Todo board (${done}/${total} done):`);
    lines.push(
      ...todos.slice(0, 20).map((t) => {
        const mark = t.status === 'completed' ? '[x]' : t.status === 'in_progress' ? '[~]' : '[ ]';
        const flat = t.content.replace(/\n|\r/g, ' ');
        return `  ${mark} ${flat}`;
      }),
    );
  }

  lines.push('', 'If this item is already done, mark it complete and move to the next open todo. Keep the board honest as you work.');

  return lines.join('\n');
}

// ── Stalled-todo matching ───────────────────────────────────────────────
//
// Shared helper used by both TUI and WebUI to identify which todo produced a
// stalled continuation prompt. Matches by content against the in_progress /
// pending todos in the board before falling back to the first open item.

export interface StalledTodoMatch {
  id: string;
  content: string;
}

/**
 * Identify the todo whose content appears in a stalled continuation prompt.
 * Scans the board for the in_progress item first (that's what
 * `resolveContinuation` picks), then falls back to any pending item whose
 * text appears in the prompt. Last resort: the first non-completed todo.
 *
 * Returns `null` when the board is empty or all items are completed.
 */
export function matchTodoIdFromPrompt(
  todos: readonly { id: string; content: string; status: string; activeForm?: string | undefined }[],
  prompt: string,
): StalledTodoMatch | null {
  if (todos.length === 0 || !prompt) return null;
  const lowerPrompt = prompt.toLowerCase();

  // 1. In-progress item — resolveContinuation promotes this first.
  const inProgress = todos.find((t) => t.status === 'in_progress');
  if (inProgress) {
    const label = (inProgress.activeForm ?? inProgress.content).toLowerCase();
    if (label.length > 5 && lowerPrompt.includes(label)) {
      return { id: inProgress.id, content: inProgress.activeForm ?? inProgress.content };
    }
  }

  // 2. Any pending item whose content appears in the prompt (board snapshot).
  for (const t of todos) {
    if (t.status === 'completed') continue;
    if (inProgress && t.id === inProgress.id) continue;
    const label = (t.activeForm ?? t.content).toLowerCase();
    if (label.length > 5 && lowerPrompt.includes(label)) {
      return { id: t.id, content: t.activeForm ?? t.content };
    }
  }

  // 3. Last resort — pick the first non-completed todo.
  const firstOpen = todos.find((t) => t.status !== 'completed');
  return firstOpen ? { id: firstOpen.id, content: firstOpen.activeForm ?? firstOpen.content } : null;
}

/**
 * Maximum total advancement attempts before we give up on the board and
 * halt. Otherwise a board where no agent turn makes progress cycles through
 * the same todos indefinitely. Reset on manual user input.
 */
export const MAX_ADVANCEMENT_ATTEMPTS = 9;

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
