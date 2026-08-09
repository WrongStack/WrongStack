import { color, estimateRequestTokensCalibrated } from '@wrongstack/core/utils';
import {
  type AutoProceedLoopGuard,
  GROUNDED_NO_PROGRESS_STEER,
} from '@wrongstack/tools/auto-proceed-loop-guard';
import type { ReplOptions } from './repl-options.js';
import { parseSuggestionsFromOutput } from './repl-suggestions.js';
import { setAutoSuggestions, setSuggestions } from './services/suggestion-store.js';

/**
 * Run the full auto-proceed cycle: countdown, feed suggestion to agent,
 * parse new suggestions from the response.  Returns normally when the
 * agent turn completes, throws on abort (Ctrl+C).
 *
 * The caller must set `activeCtrl` before calling and clear it after.
 */
export async function runAutoProceed(
  opts: ReplOptions,
  suggestion: string,
  delayMs: number,
  ctrl: AbortController,
  loopGuard: AutoProceedLoopGuard,
  /**
   * True when `suggestion` was synthesized from the durable todo board rather
   * than parsed from model output. Grounded prompts go through the guard's
   * steer-then-halt path: the first identical re-feed appends an explicit
   * "the board has not moved — update it" note instead of halting, and the
   * halt only fires if the board stays frozen after that steer.
   */
  grounded = false,
): Promise<boolean> {
  const truncated = suggestion.length > 80 ? `${suggestion.slice(0, 77)}…` : suggestion;
  console.log(
    JSON.stringify({
      level: 'info',
      event: 'auto_proceed_started',
      suggestion: truncated,
      delayMs,
    }),
  );
  try {
    // ── Productive cooldown: compact context while we wait ─────────
    const proceed = await autoProceedCooldown(opts, delayMs, suggestion, ctrl.signal);
    if (!proceed) {
      // Countdown was cancelled (host callback or abort signal) — do NOT
      // feed the suggestion. Resolving here without running keeps the
      // "cancel" semantics honest instead of fast-forwarding the run.
      console.log(
        JSON.stringify({
          level: 'info',
          event: 'auto_proceed_cancelled',
          suggestion: truncated,
        }),
      );
      return false;
    }
    if ((opts.getAutonomy?.() ?? 'off') !== 'auto') {
      console.log(
        JSON.stringify({
          level: 'info',
          event: 'auto_proceed_cancelled',
          suggestion: truncated,
          reason: 'autonomy_not_auto',
        }),
      );
      return false;
    }

    // Record at the authoritative submission boundary: cancelled countdowns
    // and autonomy changes above never count as feeds because no prompt left
    // the client. A repeated prompt halts before `agent.run()`.
    const repetition = grounded
      ? loopGuard.recordGrounded(suggestion)
      : loopGuard.record(suggestion);
    if (repetition.shouldHalt) {
      setSuggestions([]);
      setAutoSuggestions([]);
      opts.onSuggestionsParsed?.(null);
      opts.renderer.writeWarning(
        `Auto-proceed halted: the same prompt was fed ${repetition.runLength} times in a row. ` +
          `Autonomy mode is still on, but no automatic next step will run until you provide input. ` +
          `Type anything to continue (resets the guard). ` +
          `Last seen prompt: "${suggestion.length > 100 ? `${suggestion.slice(0, 97)}…` : suggestion}"`,
      );
      return false;
    }

    // ── Feed the suggestion as if it were runText ──────────────────
    const steered = 'action' in repetition && repetition.action === 'steer';
    if (steered) {
      opts.renderer.writeWarning(
        'Todo board unchanged since the last automatic turn — steering the agent to update the board before continuing.',
      );
    }
    const runBlocks = [
      {
        type: 'text' as const,
        text: steered ? `${suggestion}\n\n${GROUNDED_NO_PROGRESS_STEER}` : suggestion,
      },
    ];
    const runResult = await opts.agent.run(runBlocks, { signal: ctrl.signal });
    console.log(
      JSON.stringify({
        level: 'info',
        event: 'auto_proceed_completed',
        suggestion: truncated,
        status: runResult.status,
        iterations: runResult.iterations,
      }),
    );
    opts.onAgentIterationComplete?.(
      estimateRequestTokensCalibrated(
        opts.agent.ctx.messages,
        opts.agent.ctx.systemPrompt,
        opts.agent.ctx.tools ?? [],
      ).total,
    );
    // Parse suggestions from the auto-triggered turn. The live todo list
    // is passed through so we suppress <nextsteps> while the in-flight
    // todo loop is still in progress — finishing the open todos comes
    // before offering new prompt options.
    if (runResult.status === 'done' && opts.onSuggestionsParsed) {
      const parsed = runResult.finalText
        ? parseSuggestionsFromOutput(runResult.finalText, opts.agent.ctx.todos)
        : null;
      opts.onSuggestionsParsed(parsed);
    }
    return true;
  } finally {
    // activeCtrl cleanup is handled by the caller
  }
}
/**
 * Productive cooldown between auto-proceed iterations.
 * Instead of a dead countdown, runs context compaction in the background
 * and only waits the full delay if compaction finishes early
 * (so the user gets a responsive Ctrl+C while still compacting).
 *
 * When delayMs is 0, skips straight to feeding the suggestion.
 *
 * Resolves `true` when the countdown ran to completion (proceed with the
 * suggestion) and `false` when it was cancelled — either by the abort
 * signal or by `onCountdownTick` returning true. A final `onCountdownTick(0)`
 * fires on every exit path so display consumers can clear their chip.
 */
async function autoProceedCooldown(
  opts: ReplOptions,
  delayMs: number,
  suggestion: string,
  signal: AbortSignal,
): Promise<boolean> {
  if (delayMs <= 0) return true; // immediate — no wait at all

  const truncated = suggestion.length > 100 ? `${suggestion.slice(0, 97)}…` : suggestion;
  const sec = Math.ceil(delayMs / 1000);

  opts.renderer.write(`\n${color.cyan('⏳ Auto')}  ${color.dim('(Ctrl+C to cancel)')}\n`);
  opts.renderer.write(`${color.dim('  ▸')} ${color.dim(truncated)}\n`);

  // ── Run compaction during the cooldown ────────────────────────
  void runContextCompaction(opts, signal);

  const start = Date.now();
  let interval: ReturnType<typeof setInterval> | undefined;
  let lastTickedSecond = sec + 1; // Start one ahead so first tick fires immediately
  let onAbort: (() => void) | undefined;

  return new Promise<boolean>((resolve) => {
    onAbort = () => resolve(false);
    signal.addEventListener('abort', onAbort, { once: true });

    interval = setInterval(() => {
      if (signal.aborted) {
        resolve(false);
        return;
      }
      const elapsed = Date.now() - start;
      const remaining = Math.max(0, Math.ceil((delayMs - elapsed) / 1000));
      if (remaining <= 0) {
        opts.renderer.write(color.dim(`  ↳ ${truncated}\n`));
        resolve(true);
        return;
      }
      // Surface the tick to the host once per second; a `true` return
      // cancels the countdown (and the pending suggestion with it).
      if (opts.onCountdownTick && remaining !== lastTickedSecond) {
        lastTickedSecond = remaining;
        try {
          const shouldAbort = opts.onCountdownTick(remaining);
          if (shouldAbort === true) {
            opts.renderer.write(
              color.yellow('  ↳ Countdown cancelled — switching to manual mode\n'),
            );
            resolve(false);
            return;
          }
        } catch {
          // Host callback errors must not break the countdown
        }
      }
      if (remaining % 5 === 0 || remaining === sec) {
        opts.renderer.write(color.dim(`  ⏳ ${remaining}s…\n`));
      }
    }, 1000);
  }).finally(() => {
    if (interval) clearInterval(interval);
    if (onAbort) signal.removeEventListener('abort', onAbort);
    // Final 0-tick on every exit path — lets display consumers (TUI
    // status-bar chip) clear instead of freezing at the last value.
    try {
      opts.onCountdownTick?.(0);
    } catch {
      /* display-only */
    }
  });
}

/**
 * Run context compaction best-effort. Catches all errors silently so it
 * never interrupts the auto-proceed flow. Returns immediately if the
 * agent's context has no compactor wired up.
 */
async function runContextCompaction(opts: ReplOptions, _signal: AbortSignal): Promise<void> {
  try {
    const ctx = opts.agent.ctx as never as {
      messages?: Array<unknown>;
      compactor?: { compact(ctx: unknown, opts: { aggressive: boolean }): Promise<void> };
    };
    if (!ctx?.compactor) return;
    // Quick check: only compact if we've added meaningful message volume
    // since the last compaction (heuristic: >50 messages).
    if ((ctx.messages?.length ?? 0) < 50) return;
    await ctx.compactor.compact(ctx, { aggressive: false });
  } catch {
    // Best-effort — never let compaction break the auto loop
  }
}
