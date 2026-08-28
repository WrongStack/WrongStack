import type { TodoItem } from '@wrongstack/core/agent';
import {
  createAutoProceedLoopGuard,
  createContinuationAttemptTracker,
  generateAdvancementPrompt,
  MAX_ADVANCEMENT_ATTEMPTS,
  matchTodoIdFromPrompt,
} from '@wrongstack/tools/auto-proceed-loop-guard';
import { useCallback, useEffect, useRef } from 'react';
import { useLocalPrefs } from './local-prefs.js';
import { useActiveSessionId } from './session-lanes.js';
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

/**
 * Auto-submit bookkeeping for ONE session.
 *
 * This lives outside React so the streak survives component unmount/remount —
 * but it must also survive a TAB SWITCH. It used to be five module-level
 * variables that the session-change effect ZEROED, which meant the cap and the
 * repetition guard were both defeated by clicking another tab and back:
 * `autoProceedMaxIterations` never fired, and a prompt loop that the guard had
 * already halted started over. One record per session fixes both, and keeps
 * four concurrent tabs from sharing a counter in the first place.
 */
interface SessionStreakState {
  streak: number;
  capWarned: boolean;
  loopHalted: boolean;
  loopGuard: ReturnType<typeof createAutoProceedLoopGuard>;
  continuationTracker: ReturnType<typeof createContinuationAttemptTracker>;
}

/** Before a session exists. Adopted by the first real session it binds to. */
const UNBOUND_STREAK_KEY = '__unbound__';

/**
 * Four tabs, but a long-lived page cycles through many sessions; bound the map
 * so a day of resumes cannot grow it without limit. Insertion order is
 * eviction order, and the four open tabs are re-created on demand.
 */
const MAX_TRACKED_STREAK_SESSIONS = 8;

const streakBySession = new Map<string, SessionStreakState>();

function blankStreakState(): SessionStreakState {
  return {
    streak: 0,
    capWarned: false,
    loopHalted: false,
    loopGuard: createAutoProceedLoopGuard(),
    continuationTracker: createContinuationAttemptTracker(),
  };
}

function streakStateFor(sessionId: string | null): SessionStreakState {
  const key = sessionId ?? UNBOUND_STREAK_KEY;
  const existing = streakBySession.get(key);
  if (existing) return existing;
  if (streakBySession.size >= MAX_TRACKED_STREAK_SESSIONS) {
    const oldest = streakBySession.keys().next().value;
    if (oldest !== undefined) streakBySession.delete(oldest);
  }
  const fresh = blankStreakState();
  streakBySession.set(key, fresh);
  return fresh;
}

/** Drop a closed tab's bookkeeping. */
export function disposeStreakState(sessionId: string): void {
  streakBySession.delete(sessionId);
}

/** Per-session streak — reset when the page hard-reloads (acceptable tradeoff) */
export function useAutoSubmitStreak(): UseAutoSubmitStreak {
  const autoProceedMaxIterations = useLocalPrefs((s) => s.autoProceedMaxIterations);
  const autonomy = useLocalPrefs((s) => s.autonomy);
  const activeSessionId = useActiveSessionId();
  const sessionRecordId = useSessionStore((s) => s.session?.id ?? null);
  const sessionId = activeSessionId ?? sessionRecordId;

  /** This tab's own bookkeeping — never another tab's. */
  const state = streakStateFor(sessionId);

  // Refs mirror the record for render; the record is the source of truth.
  const streakRef = useRef(state.streak);
  const capWarnedRef = useRef(state.capWarned);
  const prevAutonomyRef = useRef(autonomy);
  const prevSessionIdRef = useRef(sessionId);

  useEffect(() => {
    streakRef.current = state.streak;
    capWarnedRef.current = state.capWarned;
  });

  // Switching tabs RE-POINTS at that session's history; it does not clear it.
  // Clearing here is what let a tab switch reset the cap and release a halted
  // prompt loop.
  useEffect(() => {
    if (prevSessionIdRef.current === sessionId) return;
    // Anything counted before a session existed belongs to the first real one,
    // mirroring how the chat lane adopts the pre-session transcript.
    if (prevSessionIdRef.current === null && sessionId) {
      const unbound = streakBySession.get(UNBOUND_STREAK_KEY);
      if (unbound && !streakBySession.has(sessionId)) {
        streakBySession.set(sessionId, unbound);
        streakBySession.delete(UNBOUND_STREAK_KEY);
      }
    }
    const next = streakStateFor(sessionId);
    streakRef.current = next.streak;
    capWarnedRef.current = next.capWarned;
    prevSessionIdRef.current = sessionId;
  }, [sessionId]);

  // When autonomy changes, evaluate BOTH transition branches BEFORE updating
  // `prevAutonomyRef.current`. React runs each `useEffect` independently, so
  // a separate "leaving auto" effect would observe `prevAutonomyRef.current`
  // already set to the current mode — making the leave branch unreachable.
  // Capturing the previous value here keeps both checks correct.
  useEffect(() => {
    const wasAuto = prevAutonomyRef.current === 'auto';
    const isAuto = autonomy === 'auto';

    // Entering 'auto' from another mode → reset the cap warning so the user
    // gets a fresh cap window. Streak is preserved (a mode switch is not a
    // manual input — the user just changed a setting).
    if (!wasAuto && isAuto) {
      state.capWarned = false;
      capWarnedRef.current = false;
    }

    // Leaving 'auto' to any other mode (off, suggest, eternal, eternal-parallel)
    // → release the loop guard entirely. Without this, a halt triggered while
    // in 'auto' persists after the user turns 'auto' off, and any later return
    // to 'auto' is silently stuck — `canAutoSubmit()` keeps returning false
    // even though the new mode wants auto-submits. Streak is also cleared:
    // the user is stepping out of the auto-submit loop, so it is no longer
    // meaningful. Cap warning is preserved so a quick off/on doesn't lose state.
    if (wasAuto && !isAuto) {
      state.streak = 0;
      streakRef.current = 0;
      state.loopHalted = false;
      state.loopGuard.reset();
      state.continuationTracker.reset();
    }

    prevAutonomyRef.current = autonomy;
  }, [autonomy, state]);

  const canAutoSubmit = useCallback((): boolean => {
    if (state.loopHalted) return false;
    if (autoProceedMaxIterations <= 0) return true; // 0 = unlimited
    return state.streak < autoProceedMaxIterations;
  }, [autoProceedMaxIterations, state]);

  const recordAutoSubmit = useCallback((): boolean => {
    const max = autoProceedMaxIterations;
    if (max > 0 && state.streak >= max) {
      // Cap already hit — shouldn't happen if canAutoSubmit was checked first,
      // but guard anyway.
      return false;
    }
    state.streak += 1;
    streakRef.current = state.streak;
    if (max > 0 && state.streak >= max) {
      state.capWarned = true;
      capWarnedRef.current = true;
    }
    return true;
  }, [autoProceedMaxIterations, state]);

  const recordPrompt = useCallback(
    (prompt: string): boolean => {
      if (state.loopHalted) return false;
      const signal = state.loopGuard.record(prompt);
      if (signal.shouldHalt) state.loopHalted = true;
      return !signal.shouldHalt;
    },
    [state],
  );

  const recordGroundedPrompt = useCallback(
    (
      prompt: string,
      todos: readonly TodoItem[],
    ): { canFeed: boolean; advancement?: string; halted?: boolean } => {
      if (state.loopHalted) return { canFeed: false, halted: true };
      const signal = state.loopGuard.recordGrounded(prompt);
      if (!signal.shouldHalt) {
        // No repetition yet — feed as-is (or with steer).
        return { canFeed: true };
      }
      // Repetition detected — try to advance to the next todo.
      const stalled = matchTodoIdFromPrompt(todos, prompt);
      if (stalled) {
        const attemptCount = state.continuationTracker.recordAttempt(stalled.id);
        state.continuationTracker.markSkipped(stalled.id);
        // Cap total advancement attempts to prevent infinite cycling.
        const totalAdvancements = Object.values(state.continuationTracker.snapshot()).reduce(
          (sum, e) => sum + e.attempts,
          0,
        );
        if (totalAdvancements <= MAX_ADVANCEMENT_ATTEMPTS) {
          const nextTodo = todos
            .filter((t) => t.status !== 'completed')
            .find((t) => t.id !== stalled.id && !state.continuationTracker.isSkipped(t.id));
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
            state.loopGuard.reset();
            return { canFeed: false, advancement };
          }
        }
      }
      state.loopHalted = true;
      return { canFeed: false, halted: true };
    },
    [state],
  );

  const reset = useCallback(() => {
    state.streak = 0;
    streakRef.current = 0;
    state.capWarned = false;
    capWarnedRef.current = false;
    state.loopHalted = false;
    state.loopGuard.reset();
    state.continuationTracker.reset();
  }, [state]);

  const resetCapWarned = useCallback(() => {
    state.capWarned = false;
    capWarnedRef.current = false;
  }, [state]);

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
