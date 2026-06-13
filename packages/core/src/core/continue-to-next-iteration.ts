/**
 * L1-E: Autonomous continue — model-driven self-iteration continuation.
 *
 * In autonomous mode the model can signal "keep going without waiting for
 * user input" by either:
 *
 *  1. **Tool call** — call `continue_to_next_iteration()` with no args.
 *     The tool returns `{ continue: true }` and sets
 *     `ctx.meta._autonomousContinue = true`. The agent loop detects this
 *     flag and re-runs the iteration instead of returning.
 *
 *  2. **Text marker** — include one of the below markers on its own line
 *     in the final text output (no tool call required):
 *
 *     - `[continue]`          — same as calling the tool; next iteration
 *     - `[next step]`        — synonym for `[continue]`
 *     - `[proceed]`          — synonym for `[continue]`
 *     - `[done]`             — stop iterating; return to caller
 *
 *     The parser matches `^\s*(?:\[continue\]|\[next step\]|\[proceed\]|\[done\])\s*$`
 *     so the marker must occupy its own line (possibly indented).
 *
 * Text markers are checked in `processResponse()` BEFORE the loop exit
 * condition, so the model can emit `[continue]` as part of its final text
 * block and the loop re-runs seamlessly.
 *
 * The `_autonomousContinue` flag lives in `ctx.meta` — it is cleared at
 * the start of each iteration so a stale flag from a prior run cannot
 * cause spurious continuation.
 *
 * @example
 * ```typescript
 * // Enable autonomous continuation on the Agent
 * const agent = new Agent({
 *   // ... other options
 *   autonomousContinue: true,   // enable text-marker parsing
 * });
 *
 * // The model can now end a response with:
 * //   [continue]
 * // and the agent will immediately start the next iteration without
 * // returning to the caller.
 * ```
 */
import type { Context } from './context.js';
import type { JSONSchema } from '../types/tool.js';
import type { Tool } from '../types/tool.js';

/**
 * Directive emitted by the model to control the autonomous loop.
 *
 * `continue`  — halt the current agent.run() and signal to the outer
 *                runner (e.g. AutonomousRunner) that it should re-invoke
 *                agent.run() immediately with a fresh continuation prompt.
 *
 * `stop`      — halt and signal the outer runner to NOT continue.
 *                The agent.run() returns `{ status: 'done' }` as normal.
 *
 * `none`      — no directive present; outer runner uses its own
 *                `doneCondition` to decide.
 */
export type ContinueDirective = 'continue' | 'stop' | 'none';

/**
 * Parse a `ContinueDirective` from raw assistant text.
 *
 * Matches markers on their own line (with optional leading/trailing
 * whitespace). Case-insensitive. Returns `'none'` when no marker found.
 *
 * The marker must be on its own line to avoid false positives — e.g.
 * "remember to use [continue] in your next email" does NOT trigger it.
 */
export function parseContinueDirective(text: string): ContinueDirective {
  // Strict: marker must be the only significant content on its line.
  // This regex uses a look-ahead to ensure the line contains nothing
  // meaningful besides the marker itself.
  const LINE_MARKERS =
    /^\s*\[(continue|next step|proceed|done)\]\s*$/gim;

  // M3: in practice the directive lives at the very end of the response —
  // models append `[continue]` or `[done]` as the last line. Scanning the
  // whole `text` string runs the regex's state machine across every char
  // even when no marker exists. For a 4 KB response the regex engine
  // walks ~4 KB of input. Restricting to the last ~2 KB cuts the scan
  // work by ~50% on typical long responses, with no functional change:
  // a marker anywhere in the last 2 KB will still be detected, and a
  // marker *before* that range is by definition not the directive
  // (the model is supposed to end its response with the marker).
  const tail =
    text.length <= DIRECTIVE_SCAN_WINDOW
      ? text
      : text.slice(text.length - DIRECTIVE_SCAN_WINDOW);

  let match: RegExpExecArray | null;
  let lastDirective: ContinueDirective = 'none';

  // biome-ignore lint/suspicious/noAssignInExpressions: while-loop condition requires assignment
  while ((match = LINE_MARKERS.exec(tail)) !== null) {
    const value = (match[1] ?? '').toLowerCase();
    if (value === 'continue' || value === 'next step' || value === 'proceed') {
      lastDirective = 'continue';
    } else if (value === 'done') {
      lastDirective = 'stop';
    }
    // Keep scanning — if multiple markers appear, rightmost wins
    // (e.g. model emits "[continue]\n[dONE]" accidentally; stop takes priority)
  }

  return lastDirective;
}

/**
 * How many characters from the end of the response to scan for
 * `[continue]` / `[done]` markers. Models are trained to put the
 * directive on its own line at the very end, so a tail-restricted
 * scan misses nothing in practice.
 */
const DIRECTIVE_SCAN_WINDOW = 2_048;

/** Meta key used to communicate the directive from tool → agent loop. */
const META_KEY = '_autonomousContinue';

/**
 * Set the autonomous continue flag in the context.
 * Called by `makeContinueToNextIterationTool` when the model invokes it.
 */
export function setAutonomousContinue(ctx: Context): void {
  ctx.meta[META_KEY] = true;
}

/**
 * Clear the autonomous continue flag at the start of each iteration.
 * Called from `Agent.run()` before the loop body.
 */
export function clearAutonomousContinue(ctx: Context): void {
  delete ctx.meta[META_KEY];
}

/**
 * Read and clear the autonomous continue flag in one call.
 * Returns `true` if the flag was set; `false` otherwise.
 */
export function consumeAutonomousContinue(ctx: Context): boolean {
  const val = ctx.meta[META_KEY] === true;
  delete ctx.meta[META_KEY];
  return val;
}

/**
 * Built-in tool that lets the model explicitly request the next iteration.
 *
 * When called, the agent loop detects the flag and re-runs instead of
 * returning to the caller. This is the explicit counterpart to the
 * `[continue]` text marker.
 *
 * The tool has no side effects and returns `{ continue: true }`.
 */
export function makeContinueToNextIterationTool(): Tool {
  const inputSchema: JSONSchema = {
    type: 'object',
    properties: {},
    required: [],
    description:
      'Signal that the agent should continue to the next iteration immediately, without waiting for user input. Use this when you have completed a step and want to proceed automatically to the next step in your plan.',
  };

  return {
    name: 'continue_to_next_iteration',
    description:
      'Continue to the next iteration without returning to the user. Call this when you have finished a step and want to keep working autonomously.',
    permission: 'auto',
    mutating: false,
    inputSchema,
    async execute(_input: unknown, ctx: Context) {
      setAutonomousContinue(ctx);
      return { continue: true };
    },
  };
}
