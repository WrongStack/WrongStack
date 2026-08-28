import { resolveContinuation, type TodoItem } from '@wrongstack/core/agent';
import type { ContentBlock } from '@wrongstack/core/types';
import {
  createAutoProceedLoopGuard,
  createContinuationAttemptTracker,
  GROUNDED_NO_PROGRESS_STEER,
  generateAdvancementPrompt,
  MAX_ADVANCEMENT_ATTEMPTS,
  matchTodoIdFromPrompt,
} from '@wrongstack/tools/auto-proceed-loop-guard';
import { todoTool } from '@wrongstack/tools/todo';
import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import type { Action } from '../app-action-type.js';
import type { AppProps } from '../app-props.js';
import type { State } from '../app-state.js';

interface NextStepsAutoSubmitOptions {
  state: State;
  autonomyLive: string;
  agent: AppProps['agent'];
  getAutonomy: AppProps['getAutonomy'];
  getSettings: AppProps['getSettings'];
  getSuggestions: AppProps['getSuggestions'];
  getAutoSuggestions: AppProps['getAutoSuggestions'];
  getYolo: AppProps['getYolo'];
  setSuggestions: AppProps['setSuggestions'];
  autonomyNextPrompt: AppProps['autonomyNextPrompt'];
  dispatch: Dispatch<Action>;
  clearDraft: () => void;
  runBlocksRef: MutableRefObject<(blocks: ContentBlock[]) => Promise<void>>;
}

interface AutoProceedCandidateInput {
  todos?: readonly TodoItem[] | undefined;
  suggestions?: readonly string[] | undefined;
  autoSuggestions?: readonly string[] | undefined;
  yolo?: boolean | undefined;
  autonomyNextPrompt?: string | undefined;
}

interface AutoProceedCandidate {
  source: 'todo' | 'suggestion' | 'auto-suggestion';
  prompt: string;
  label: string;
  todoId?: string | undefined;
}

async function commitTodoTransition(
  agent: AppProps['agent'],
  todos: TodoItem[],
): Promise<string | null> {
  if (!agent?.ctx?.state) return null;
  try {
    await todoTool.execute({ todos }, agent.ctx, { signal: AbortSignal.timeout(30_000) });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Resolve one grounded automatic turn without mutating either suggestion store. */
export function selectAutoProceedCandidate({
  todos,
  suggestions = [],
  autoSuggestions = [],
  yolo = false,
  autonomyNextPrompt,
}: AutoProceedCandidateInput): AutoProceedCandidate | null {
  const todo = resolveContinuation({ todos, suggestions: [] });
  if (todo.source === 'todo') {
    return { source: 'todo', prompt: todo.text, label: todo.label, todoId: todo.todoId };
  }

  const automatic = yolo
    ? autoSuggestions.find((item) => item.trim().length > 0)?.trim()
    : undefined;
  if (automatic) {
    const prompt = autonomyNextPrompt
      ? autonomyNextPrompt.replace('{{suggestion}}', automatic)
      : automatic;
    return { source: 'auto-suggestion', prompt, label: automatic };
  }

  const suggestion = suggestions.find((item) => item.trim().length > 0)?.trim();
  return suggestion ? { source: 'suggestion', prompt: suggestion, label: suggestion } : null;
}

/** Owns grounded next-step countdowns and automatic-turn loop guards. */
export function useNextStepsAutoSubmit({
  state,
  autonomyLive,
  agent,
  getAutonomy,
  getSettings,
  getSuggestions,
  getAutoSuggestions,
  getYolo,
  setSuggestions,
  autonomyNextPrompt,
  dispatch,
  clearDraft,
  runBlocksRef,
}: NextStepsAutoSubmitOptions): {
  nextStepsAutoSubmitCountdown: number | null;
  nextStepsAutoSubmitLabel: string | null;
  setNextStepsAutoSubmitCountdown: Dispatch<SetStateAction<number | null>>;
  setNextStepsAutoSubmitLabel: Dispatch<SetStateAction<string | null>>;
  nextStepsAutoSubmitSuggestionRef: MutableRefObject<string | null>;
  nextStepsAutoSubmitTimerRef: MutableRefObject<ReturnType<typeof setInterval> | undefined>;
  autoSubmitStreakRef: MutableRefObject<number>;
  autoSubmitCapWarnedRef: MutableRefObject<boolean>;
  autoSubmitLoopGuardRef: MutableRefObject<ReturnType<typeof createAutoProceedLoopGuard>>;
  cancelNextStepsCountdown: () => void;
} {
  const [nextStepsAutoSubmitCountdown, setNextStepsAutoSubmitCountdown] = useState<number | null>(
    null,
  );
  const [nextStepsAutoSubmitLabel, setNextStepsAutoSubmitLabel] = useState<string | null>(null);
  const nextStepsAutoSubmitSuggestionRef = useRef<string | null>(null);
  // Where the armed prompt came from. Todo-sourced prompts are GROUNDED
  // (synthesized from the durable board, not echoed model output), so their
  // repetition goes through the guard's steer-then-halt path instead of
  // halting on the first identical re-feed.
  const nextStepsAutoSubmitSourceRef = useRef<AutoProceedCandidate['source'] | null>(null);
  const nextStepsAutoSubmitTodoIdRef = useRef<string | null>(null);
  // Snapshot of the todo list taken when the candidate was selected, so the
  // countdown handler can re-evaluate todos if the grounded prompt stalls.
  const nextStepsAutoSubmitTodosRef = useRef<readonly TodoItem[]>([]);
  const nextStepsAutoSubmitTimerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  // ── Next-steps auto-submit countdown ─────────────────────────────────
  // When autonomy is 'auto' and suggestions are available, start a countdown
  // on line 3 of the status bar. When it expires, auto-submit the first
  // suggestion. Autonomy is the USER'S setting — this loop never flips it
  // off. Runaway protection is the consecutive-turn cap instead
  // (settings `autoProceedMaxIterations`, same knob the REPL honors):
  // at the cap the loop pauses and waits for input; manual input re-arms it.
  //
  // Declared HERE (not with the countdown useState further down) because
  // `nextStepsRecheck` sits in the effect's deps array, which is evaluated
  // at render time — declaring it after the effect would TDZ-throw.
  // Consecutive auto-submitted turns since the last MANUAL input.
  const autoSubmitStreakRef = useRef(0);
  const autoSubmitCapWarnedRef = useRef(false);
  // Repetition guard: catches the specific loop where the model emits the
  // same `<nextsteps>` block on every reply and the TUI auto-submit re-feeds
  // it back. The streak cap above is the generic runaway net; this guard
  // catches the targeted case the user reported. Reset on every manual input.
  const autoSubmitLoopGuardRef = useRef(createAutoProceedLoopGuard());
  // Continuation-attempt tracker: records how many times each todo has been
  // re-continued across turns. When a grounded prompt stalls and we advance
  // to a different todo, this tracker provides the attempt count for the
  // stalled todo so the advancement prompt can report "attempt N" with
  // varied wording — avoiding identical re-feeds to the loop guard.
  const continuationAttemptTrackerRef = useRef(createContinuationAttemptTracker());
  // Bumped on a slow poll while idle+auto with no suggestions, so the
  // auto-submit effect re-checks for suggestions that arrived out-of-band.
  const [nextStepsRecheck, setNextStepsRecheck] = useState(0);
  // A mode change is always a user action (the system never flips autonomy)
  // — re-arm the cap on any switch. Deliberately NOT tied to state.status:
  // every automatic turn passes through 'running', and resetting there
  // would defeat the cap entirely.
  useEffect(() => {
    autoSubmitStreakRef.current = 0;
    autoSubmitCapWarnedRef.current = false;
    autoSubmitLoopGuardRef.current.reset();
    continuationAttemptTrackerRef.current.reset();
  }, [autonomyLive]);
  useEffect(() => {
    const liveAutonomy = getAutonomy?.() ?? autonomyLive;
    // Only run when idle and in auto mode
    if (state.status !== 'idle' || liveAutonomy !== 'auto') {
      clearInterval(nextStepsAutoSubmitTimerRef.current);
      nextStepsAutoSubmitTimerRef.current = undefined;
      setNextStepsAutoSubmitCountdown(null);
      setNextStepsAutoSubmitLabel(null);
      nextStepsAutoSubmitSuggestionRef.current = null;
      nextStepsAutoSubmitSourceRef.current = null;
      nextStepsAutoSubmitTodoIdRef.current = null;
      return;
    }

    // Don't start while enhance panel or a bare-continue confirm panel is active
    if (
      state.enhance != null ||
      state.enhanceBusy ||
      state.topicCheckBusy ||
      state.refineCountdown != null ||
      state.refineFailure != null ||
      state.continueConfirm != null ||
      state.clearConfirm != null ||
      state.slashConfirm != null ||
      state.escConfirm != null ||
      state.sendModePicker != null ||
      state.confirmQueue.length > 0 ||
      state.shellCommandWarning != null ||
      state.brainPrompt != null
    ) {
      return;
    }

    // Don't start if already counting down
    if (nextStepsAutoSubmitTimerRef.current != null) {
      return;
    }

    const suggestions = getSuggestions?.() ?? [];
    const isYolo = getYolo?.() ?? false;
    // Filter out todos that the continuation tracker has marked skipped
    // (stalled during a prior advancement cycle). resolveContinuation
    // otherwise re-selects the highest-priority open todo regardless of skip
    // state — after the loop guard is reset during advancement, this would
    // re-arm the same stalled todo and re-create the repetition the feature
    // targets. Reading isSkipped here makes the tracker effective on the
    // selection path, not just the advancement path.
    const allTodos = agent?.ctx?.todos ?? [];
    const todos = allTodos.filter((t) => !continuationAttemptTrackerRef.current.isSkipped(t.id));
    const candidate = selectAutoProceedCandidate({
      todos,
      suggestions,
      autoSuggestions: isYolo ? (getAutoSuggestions?.() ?? []) : [],
      yolo: isYolo,
      autonomyNextPrompt,
    });
    // Snapshot the FULL todo list (including skipped items) so the countdown
    // handler can re-evaluate if a grounded prompt stalls and needs to advance
    // to the next item. The advancement path uses isSkipped to skip ahead.
    nextStepsAutoSubmitTodosRef.current = allTodos;
    if (!candidate) {
      // Continuations can arrive while idle without changing an effect
      // dependency. Poll slowly until there is grounded work to submit.
      const recheck = setTimeout(() => setNextStepsRecheck((t) => t + 1), 1_500);
      return () => clearTimeout(recheck);
    }

    // An open todo is the durable source of truth. Drop stale parsed
    // suggestions instead of persisting the synthesized todo prompt there.
    if (candidate.source === 'todo' && suggestions.length > 0) setSuggestions?.([]);

    const cfg = getSettings?.();

    // Consecutive-cap: pause (don't even show a countdown that won't fire)
    // once the streak hits the limit. 0 = unlimited (user's explicit choice).
    const maxAuto = cfg?.autoProceedMaxIterations ?? 50;
    if (maxAuto > 0 && autoSubmitStreakRef.current >= maxAuto) {
      if (!autoSubmitCapWarnedRef.current) {
        autoSubmitCapWarnedRef.current = true;
        dispatch({
          type: 'addEntry',
          entry: {
            kind: 'warn',
            text: `Auto-proceed paused after ${maxAuto} consecutive automatic turns — type anything to continue (autonomy stays on).`,
          },
        });
      }
      return;
    }

    // Use the same delay as auto-proceed countdown
    const delay = cfg?.delayMs ?? 45_000;

    nextStepsAutoSubmitSuggestionRef.current = candidate.prompt;
    nextStepsAutoSubmitSourceRef.current = candidate.source;
    nextStepsAutoSubmitTodoIdRef.current = candidate.todoId ?? null;
    const start = Date.now();
    setNextStepsAutoSubmitCountdown(Math.ceil(delay / 1000));
    setNextStepsAutoSubmitLabel(candidate.label);

    nextStepsAutoSubmitTimerRef.current = setInterval(async () => {
      const remaining = Math.max(0, Math.ceil((delay - (Date.now() - start)) / 1000));
      if (remaining <= 0) {
        clearInterval(nextStepsAutoSubmitTimerRef.current);
        nextStepsAutoSubmitTimerRef.current = undefined;
        setNextStepsAutoSubmitCountdown(null);
        setNextStepsAutoSubmitLabel(null);
        if ((getAutonomy?.() ?? autonomyLive) !== 'auto') {
          nextStepsAutoSubmitSuggestionRef.current = null;
          nextStepsAutoSubmitSourceRef.current = null;
          nextStepsAutoSubmitTodoIdRef.current = null;
          return;
        }
        // Auto-submit the suggestion
        const suggestion = nextStepsAutoSubmitSuggestionRef.current;
        const source = nextStepsAutoSubmitSourceRef.current;
        const todoId = nextStepsAutoSubmitTodoIdRef.current;
        nextStepsAutoSubmitSuggestionRef.current = null;
        nextStepsAutoSubmitSourceRef.current = null;
        nextStepsAutoSubmitTodoIdRef.current = null;
        if (suggestion) {
          // Starting grounded work is a real lifecycle transition. Route it
          // through ConversationState so TUI, WebUI, persistence, and the
          // session Kanban mirror all observe Running before the prompt is
          // submitted. Never mutate ctx.todos directly.
          if (source === 'todo' && todoId) {
            if (agent?.ctx?.state) {
              const liveTodos = agent.ctx.todos;
              const selected = liveTodos.find((todo) => todo.id === todoId);
              if (selected?.status === 'pending') {
                const transitionError = await commitTodoTransition(
                  agent,
                  liveTodos.map((todo) =>
                    todo.id === todoId
                      ? { ...todo, status: 'in_progress' as const }
                      : todo.status === 'in_progress'
                        ? { ...todo, status: 'pending' as const }
                        : todo,
                  ),
                );
                if (transitionError) {
                  dispatch({
                    type: 'addEntry',
                    entry: {
                      kind: 'error',
                      text: `Todo/Kanban transition failed: ${transitionError}`,
                    },
                  });
                  return;
                }
              }
            }
          }
          // ── Loop guard ──────────────────────────────────────────────────
          // The streak cap above is a generic runaway net. This guard
          // catches the specific loop the user reported: the model emits
          // the same `<nextsteps>` block on every reply and auto-submit
          // re-feeds it. When the guard halts, drop the visible suggestion
          // store so the next iteration cannot re-feed the same content,
          // write a history entry asking the user what's happening, and
          // stop the auto-submit countdown. Autonomy stays on; the user
          // can resume with a fresh prompt.
          //
          // (We clear only the visible `setSuggestions` store here; the
          // auto-suggestion store is repopulated by `onAutoSuggestionsParsed`
          // from the next model output, so a stale auto="true" item cannot
          // survive into the next turn.)
          //
          // Todo-sourced prompts: the guard steers once first. If the board
          // still hasn't moved after the steer, instead of halting we
          // advance to the next open todo (if one exists) with a varied
          // prompt that reports attempt count for the stalled item. This
          // avoids stopping the auto-proceed loop when there's still
          // unfinished work. Only when no more todos remain do we halt.
          //
          // Suggestion-sourced prompts keep strict halt-on-first-repeat:
          // those ARE model echoes.
          const repetition =
            source === 'todo'
              ? autoSubmitLoopGuardRef.current.recordGrounded(suggestion)
              : autoSubmitLoopGuardRef.current.record(suggestion);
          if (repetition.shouldHalt) {
            // Tracks whether we identified the stalled todo but could not
            // advance (all others done/skipped), vs. failing to match the
            // prompt to any todo at all. Used for an accurate halt message.
            let stalledMatchFailed = false;
            if (source === 'todo') {
              // ── Grounded stall: advance to next todo ───────────────
              // The board hasn't moved after the steer. Find the stalled
              // todo by matching against the captured snapshot, record
              // the attempt, and try the next open item with a fresh
              // (different) prompt.
              const todos = nextStepsAutoSubmitTodosRef.current;
              const stalled = matchTodoIdFromPrompt(todos, suggestion);
              if (stalled) {
                const attemptCount = continuationAttemptTrackerRef.current.recordAttempt(
                  stalled.id,
                );
                continuationAttemptTrackerRef.current.markSkipped(stalled.id);
                // Cap: if total advancement attempts across all todos
                // exceeds limit, halt so the board gets manual attention.
                const totalAdvancements = Object.values(
                  continuationAttemptTrackerRef.current.snapshot(),
                ).reduce((sum, e) => sum + e.attempts, 0);
                if (totalAdvancements <= MAX_ADVANCEMENT_ATTEMPTS) {
                  const nextTodo = todos
                    .filter((t) => t.status !== 'completed')
                    .find(
                      (t) =>
                        t.id !== stalled.id &&
                        !continuationAttemptTrackerRef.current.isSkipped(t.id),
                    );
                  if (nextTodo) {
                    // ── Guaranteed marking ───────────────────────────
                    // Advance through the canonical state API. This emits a
                    // todos_replaced event, checkpoints the list, broadcasts
                    // it to WebUI, and mirrors Running/Pending to Kanban.
                    const freshTodos = todos.map((todo) =>
                      todo.id === stalled.id
                        ? { ...todo, status: 'pending' as const }
                        : todo.id === nextTodo.id
                          ? { ...todo, status: 'in_progress' as const }
                          : todo.status === 'in_progress'
                            ? { ...todo, status: 'pending' as const }
                            : todo,
                    );
                    const transitionError = await commitTodoTransition(agent, freshTodos);
                    if (transitionError) {
                      dispatch({
                        type: 'addEntry',
                        entry: {
                          kind: 'error',
                          text: `Todo/Kanban transition failed: ${transitionError}`,
                        },
                      });
                      return;
                    }
                    nextStepsAutoSubmitTodosRef.current = freshTodos;

                    // Build a varied advancement prompt and feed it instead
                    // of halting. Pass actual todo content (stalled.content,
                    // not the full stalled prompt) so the generated label
                    // is readable.
                    const advancementPrompt =
                      generateAdvancementPrompt(
                        { id: stalled.id, content: stalled.content },
                        nextTodo,
                        attemptCount,
                        freshTodos,
                      ) +
                      // Steer the model to mark the stalled item off
                      // "in_progress" (already done below, but tell the
                      // agent what happened so it stays in sync).
                      '\n\n(I have demoted the stalled item from "in_progress" to "pending" so the auto-advance loop can move on. If it is actually done, mark it complete. Otherwise it is queued for a later pass.)';
                    autoSubmitStreakRef.current += 1;
                    void (async () => {
                      const trimmed = advancementPrompt.trim();
                      if (!trimmed) {
                        clearDraft();
                        return;
                      }
                      const blocks: ContentBlock[] = [{ type: 'text', text: trimmed }];
                      dispatch({ type: 'addEntry', entry: { kind: 'user', text: trimmed } });
                      try {
                        await runBlocksRef.current(blocks);
                      } finally {
                        clearDraft();
                      }
                    })();
                    // Reset loop guard so the next iteration compares
                    // against the fresh advancement prompt, not the old
                    // cycle. The tracker retains attempt history so
                    // repeated stalls on the same todo still escalate.
                    autoSubmitLoopGuardRef.current.reset();
                    return;
                  }
                }
              } else {
                // The prompt could not be matched to any todo on the board.
                stalledMatchFailed = true;
              }
            }
            // ── All paths exhausted: halt normally ──────────────────
            setSuggestions?.([]);
            const truncatedForMessage =
              suggestion.length > 100 ? `${suggestion.slice(0, 97)}…` : suggestion;
            const reason =
              source === 'todo'
                ? stalledMatchFailed
                  ? 'the stalled prompt could not be matched to any todo on the board'
                  : 'No more open todos to advance to'
                : `the same prompt was fed ${repetition.runLength} times in a row`;
            dispatch({
              type: 'addEntry',
              entry: {
                kind: 'warn',
                text:
                  `⚠️ Auto-submit halted: ${reason}. ` +
                  `Autonomy is still on; type anything to continue (resets the guard). ` +
                  `Last seen: "${truncatedForMessage}"`,
              },
            });
          } else {
            autoSubmitStreakRef.current += 1;
            const steered = 'action' in repetition && repetition.action === 'steer';
            const promptToFeed = steered
              ? `${suggestion}\n\n${GROUNDED_NO_PROGRESS_STEER}`
              : suggestion;
            // Trigger submit — input field is cleared after submission completes
            // (see clearDraft in finally block below). Do not pre-populate the
            // input with the suggestion text.
            void (async () => {
              const trimmed = promptToFeed.trim();
              if (!trimmed) {
                clearDraft();
                return;
              }
              // Build blocks for the suggestion
              const blocks: ContentBlock[] = [{ type: 'text', text: trimmed }];
              dispatch({ type: 'addEntry', entry: { kind: 'user', text: trimmed } });
              // Via ref: `runBlocks` is declared ~2000 lines below — naming it
              // in this effect's deps array evaluates it at render time and
              // throws a TDZ ReferenceError. The ref is only dereferenced when
              // the countdown fires, long after mount.
              try {
                await runBlocksRef.current(blocks);
              } finally {
                // Always clear the input field after submit, even on error.
                clearDraft();
              }
            })();
          }
        }
      } else {
        setNextStepsAutoSubmitCountdown(remaining);
      }
    }, 500);

    return () => {
      clearInterval(nextStepsAutoSubmitTimerRef.current);
      nextStepsAutoSubmitTimerRef.current = undefined;
      setNextStepsAutoSubmitCountdown(null);
      setNextStepsAutoSubmitLabel(null);
    };
  }, [
    state.status,
    autonomyLive,
    state.enhance,
    state.enhanceBusy,
    state.topicCheckBusy,
    state.refineCountdown,
    state.refineFailure,
    state.continueConfirm,
    state.clearConfirm,
    state.slashConfirm,
    state.escConfirm,
    state.sendModePicker,
    state.confirmQueue.length,
    state.shellCommandWarning,
    state.brainPrompt,
    nextStepsRecheck,
    getAutonomy,
    getSettings,
    getSuggestions,
    getAutoSuggestions,
    getYolo,
    autonomyNextPrompt,
    dispatch,
  ]);

  const cancelNextStepsCountdown = useCallback((): void => {
    if (nextStepsAutoSubmitTimerRef.current == null) return;
    clearInterval(nextStepsAutoSubmitTimerRef.current);
    nextStepsAutoSubmitTimerRef.current = undefined;
    setNextStepsAutoSubmitCountdown(null);
    setNextStepsAutoSubmitLabel(null);
    nextStepsAutoSubmitSuggestionRef.current = null;
    nextStepsAutoSubmitSourceRef.current = null;
    nextStepsAutoSubmitTodoIdRef.current = null;
  }, []);

  return {
    nextStepsAutoSubmitCountdown,
    nextStepsAutoSubmitLabel,
    setNextStepsAutoSubmitCountdown,
    setNextStepsAutoSubmitLabel,
    nextStepsAutoSubmitSuggestionRef,
    nextStepsAutoSubmitTimerRef,
    autoSubmitStreakRef,
    autoSubmitCapWarnedRef,
    autoSubmitLoopGuardRef,
    cancelNextStepsCountdown,
  };
}
