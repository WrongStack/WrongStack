import {
  createAutoProceedLoopGuard,
  createContinuationAttemptTracker,
  generateAdvancementPrompt,
  matchTodoIdFromPrompt,
  MAX_ADVANCEMENT_ATTEMPTS,
} from '@wrongstack/tools/auto-proceed-loop-guard';
import type { TodoItem } from '@wrongstack/core/agent';
import { useCallback, useEffect, useRef } from 'react';
import { useLocalPrefs } from './local-prefs.js';
import { useSessionStore } from './session-store.js';

/**
 * Auto-submit streak tracking for YOLO+auto mode.
 *
 * Tracks how many consecutive automatic next-step submissions have occurred
 * since the last manual user input. When the streak hits autoProceedMaxIterations,
 * auto-submit pauses and a warning is shown — the autonomy mode stays on; only
 * the automatic submission is paused until the user types something.
 *
 * Reset on:
 *  - Manual user input (any submit via ChatInput)
 *  - Autonomy mode change
 *
 * Increment on:
 *  - Every successful auto-submit (countdown fires and suggestion is sent)
 */

interface UseAutoSubmitStreak {
  /** Current streak count */
  streak: number;
  /** Whether the cap warning has been shown */
  capWarned: boolean;
  /**
   * Check if auto-submit is allowed right now (streak < cap).
   * Call this BEFORE showing the countdown — returns false when the cap
   * is already at the limit, so the countdown should not start.
   */
  canAutoSubmit: () => boolean;
  /**
   * Record a successful auto-submit. Increments the streak.
   * Returns true if submitted, false if capped (caller should show warning).
   */
  recordAutoSubmit: () => boolean;
  /**
   * Record an automatic prompt immediately before sending it.
   * Returns false when the prompt repeats and the caller must halt.
   */
  recordPrompt: (prompt: string) => boolean;
  /**
   * Record a grounded (todo-sourced) auto-submit prompt. When the loop
   * guard detects repetition, instead of halting it attempts to advance
   * to the next open todo with varied wording. Returns:
   *   - `{ canFeed: true }` — feed the same prompt as-is
   *   - `{ canFeed: false, advancement: string }` — feed the advancement prompt
   *   - `{ canFeed: false, halted: true }` — no more todos to advance to
   */
  recordGroundedPrompt: (
    prompt: string,
    todos: readonly TodoItem[],
  ) => { canFeed: boolean; advancement?: string; halted?: boolean };
  /** Reset the streak and repetition history on every manual user submit. */
  reset: () => void;
  /** Reset the cap-warning flag — call when autonomy mode changes */
  resetCapWarned: () => void;
}

// Module-level state so the streak persists across component unmounts/remounts.
// This is NOT a React state — it's a mutable counter shared by all hook instances.
let _streak = 0;
let _capWarned = false;
let _loopHalted = false;
const _loopGuard = createAutoProceedLoopGuard();
const _continuationTracker = createContinuationAttemptTracker();

/** Module-level streak — reset when the page hard-reloads (acceptable tradeoff) */
export function useAutoSubmitStreak(): UseAutoSubmitStreak {
  const autoProceedMaxIterations = useLocalPrefs((s) => s.autoProceedMaxIterations);
  const autonomy = useLocalPrefs((s) => s.autonomy);
  const sessionId = useSessionStore((s) => s.session?.id ?? null);

  // Use refs for the mutable values that don't need to trigger re-renders
  const streakRef = useRef(_streak);
  const capWarnedRef = useRef(_capWarned);
  // Track session/mode switches so shared module state never crosses a
  // backend session boundary.
  const prevAutonomyRef = useRef(autonomy);
  const prevSessionIdRef = useRef(sessionId);

  // Sync from module level on first render
  useEffect(() => {
    streakRef.current = _streak;
    capWarnedRef.current = _capWarned;
  });

  // A new backend session starts a fresh automatic-submission history.
  useEffect(() => {
    if (prevSessionIdRef.current !== sessionId) {
      _streak = 0;
      streakRef.current = 0;
      _capWarned = false;
      capWarnedRef.current = false;
      _loopHalted = false;
      _loopGuard.reset();
      _continuationTracker.reset();
      prevSessionIdRef.current = sessionId;
    }
  }, [sessionId]);

  // When autonomy switches TO 'auto' from something else, reset the cap warning
  // so the user gets a fresh cap window. The streak itself is preserved since
  // a mode switch is not a manual input — the user just changed a setting.
  useEffect(() => {
    if (prevAutonomyRef.current !== 'auto' && autonomy === 'auto') {
      _capWarned = false;
      capWarnedRef.current = false;
    }
    prevAutonomyRef.current = autonomy;
  }, [autonomy]);

  const canAutoSubmit = useCallback((): boolean => {
    if (_loopHalted) return false;
    if (autoProceedMaxIterations <= 0) return true; // 0 = unlimited
    return streakRef.current < autoProceedMaxIterations;
  }, [autoProceedMaxIterations]);

  const recordAutoSubmit = useCallback((): boolean => {
    const max = autoProceedMaxIterations;
    if (max > 0 && streakRef.current >= max) {
      // Cap already hit — shouldn't happen if canAutoSubmit was checked first,
      // but guard anyway.
      return false;
    }
    _streak = ++streakRef.current;
    if (max > 0 && _streak >= max) {
      _capWarned = true;
      capWarnedRef.current = true;
    }
    return true;
  }, [autoProceedMaxIterations]);

  const recordPrompt = useCallback((prompt: string): boolean => {
    if (_loopHalted) return false;
    const signal = _loopGuard.record(prompt);
    if (signal.shouldHalt) _loopHalted = true;
    return !signal.shouldHalt;
  }, []);

  const recordGroundedPrompt = useCallback(
    (
      prompt: string,
      todos: readonly TodoItem[],
    ): { canFeed: boolean; advancement?: string; halted?: boolean } => {
      if (_loopHalted) return { canFeed: false, halted: true };
      const signal = _loopGuard.recordGrounded(prompt);
      if (!signal.shouldHalt) {
        // No repetition yet — feed as-is (or with steer).
        return { canFeed: true };
      }
      // Repetition detected — try to advance to the next todo.
      const stalled = matchTodoIdFromPrompt(todos, prompt);
      if (stalled) {
        const attemptCount = _continuationTracker.recordAttempt(stalled.id);
        _continuationTracker.markSkipped(stalled.id);
        // Cap total advancement attempts to prevent infinite cycling.
        const totalAdvancements = Object.values(_continuationTracker.snapshot()).reduce(
          (sum, e) => sum + e.attempts,
          0,
        );
        if (totalAdvancements <= MAX_ADVANCEMENT_ATTEMPTS) {
          const nextTodo = todos
            .filter((t) => t.status !== 'completed')
            .find((t) => t.id !== stalled.id && !_continuationTracker.isSkipped(t.id));
          if (nextTodo) {
            // ── Guaranteed marking ─────────────────────────────
            // Directly demote the stalled todo off "in_progress"
            // so the next resolveContinuation call does NOT
            // re-select it. The todos array is the caller's live
            // reference, so the change is immediate.
            const stalledTodo = todos.find((t) => t.id === stalled.id);
            if (stalledTodo) {
              stalledTodo.status = 'pending';
            }
            const advancement = generateAdvancementPrompt(
              { id: stalled.id, content: stalled.content },
              nextTodo,
              attemptCount,
              todos,
            );
            _loopGuard.reset();
            return { canFeed: false, advancement };
          }
        }
      }
      _loopHalted = true;
      return { canFeed: false, halted: true };
    },
    [],
  );

  const reset = useCallback(() => {
    _streak = 0;
    streakRef.current = 0;
    _capWarned = false;
    capWarnedRef.current = false;
    _loopHalted = false;
    _loopGuard.reset();
    _continuationTracker.reset();
  }, []);

  const resetCapWarned = useCallback(() => {
    _capWarned = false;
    capWarnedRef.current = false;
  }, []);

  return {
    streak: streakRef.current,
    capWarned: capWarnedRef.current,
    canAutoSubmit,
    recordAutoSubmit,
    recordPrompt,
    recordGroundedPrompt,
    reset,
    resetCapWarned,
  };
}
