/**
 * Turn-scoped slot for `<nextsteps>` suggestions produced by the `nextsteps`
 * tool, plus the renderer that turns them back into the canonical XML block.
 *
 * ## Why a slot and not a direct channel to the UI
 *
 * Every suggestion surface — the TUI history renderer, the WebUI and SimpleUI
 * chat stores, the CLI REPL suggestion store, and the session replay/rehydrate
 * paths — reads `<nextsteps>` out of the assistant's *message text* via
 * `parseNextSteps` in `@wrongstack/tools/next-steps`. Handing the tool its own
 * transport would mean teaching all of them a second source of truth, and any
 * one of them lagging behind would silently drop suggestions.
 *
 * Instead the tool parks its steps here, and `maybeAppendPendingNextSteps`
 * appends the rendered block to the turn-ending provider response before that
 * response is emitted, persisted, or folded into `finalText`. Downstream code
 * cannot tell the difference between a block the model typed and one the tool
 * produced, which is exactly the point.
 *
 * ## Why this module duplicates the tag knowledge
 *
 * `core` sits below `tools` in the package DAG (enforced by
 * `package-boundaries.test.ts`), so it cannot import the parser. The overlap is
 * deliberately kept to the tag name and the item line shape; the round-trip
 * test in `tests/next-steps-slot.test.ts` feeds this renderer's output through
 * the real parser so the two cannot drift apart unnoticed.
 */

import { isTextBlock } from '../types/blocks.js';
import type { Response } from '../types/provider.js';
import { hasOpenTodos } from '../utils/todos-format.js';
import type { Context } from './context.js';

/** A single suggestion parked by the `nextsteps` tool. */
export interface PendingNextStep {
  text: string;
  /** Opt-in unattended execution. Honored only on the first item. */
  auto?: boolean | undefined;
}

/**
 * `ctx.meta` key holding the pending steps. Namespaced like the other meta
 * slots (`plan.path`, `task.path`) so it cannot collide with plugin metadata.
 */
const SLOT_KEY = 'nextsteps.pending';

/**
 * Upper bound on parked steps. The parser accepts up to 6, but the leader
 * prompt's contract is 1–4, so the slot enforces the tighter number and the
 * tool's schema mirrors it.
 */
export const MAX_PENDING_NEXT_STEPS = 4;

/** Matches an already-present `<nextsteps>` opening tag, attributes and all. */
const NEXT_STEPS_TAG_RE = /<nextsteps\b[^>]*>/i;

// ── Slot access ────────────────────────────────────────────────────────────

/**
 * Park the steps for this turn, replacing anything already there.
 *
 * Replace (rather than append) matches `todo`'s whole-list semantics: a second
 * call in the same turn is the model changing its mind, not adding to a list.
 */
export function writePendingNextSteps(
  ctx: Pick<Context, 'meta'>,
  steps: readonly PendingNextStep[],
): void {
  const cleaned: PendingNextStep[] = [];
  for (const step of steps) {
    const text = typeof step?.text === 'string' ? step.text.replace(/\s+/g, ' ').trim() : '';
    if (!text) continue;
    // Only the first accepted item may opt into unattended execution — the
    // same rule the parser applies to `auto="true"` (next-steps.ts).
    cleaned.push(step.auto === true && cleaned.length === 0 ? { text, auto: true } : { text });
    if (cleaned.length >= MAX_PENDING_NEXT_STEPS) break;
  }
  if (cleaned.length === 0) {
    clearPendingNextSteps(ctx);
    return;
  }
  ctx.meta[SLOT_KEY] = cleaned;
}

/** Read the parked steps, or undefined when the slot is empty or malformed. */
export function readPendingNextSteps(ctx: Pick<Context, 'meta'>): PendingNextStep[] | undefined {
  const raw = ctx.meta[SLOT_KEY];
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const steps = raw.filter(
    (s): s is PendingNextStep =>
      typeof (s as PendingNextStep | undefined)?.text === 'string' &&
      (s as PendingNextStep).text.length > 0,
  );
  return steps.length > 0 ? steps : undefined;
}

/**
 * Empty the slot. Called at the start of every `run()` so a block produced for
 * one prompt can never attach itself to the answer for the next one, and again
 * after a successful append so it cannot repeat within the same run.
 */
export function clearPendingNextSteps(ctx: Pick<Context, 'meta'>): void {
  delete ctx.meta[SLOT_KEY];
}

// ── Rendering ──────────────────────────────────────────────────────────────

/** True when the text already carries a `<nextsteps>` block the model wrote. */
export function hasNextStepsTag(text: string): boolean {
  return NEXT_STEPS_TAG_RE.test(text);
}

/**
 * Render parked steps as the canonical block.
 *
 * The output must satisfy `parseNextSteps` exactly: an opening tag with no
 * attributes, one `N. text` line per item, `auto="true"` only ever on item 1,
 * and a balanced closing tag.
 */
export function renderNextStepsBlock(steps: readonly PendingNextStep[]): string {
  const lines = steps.map((step, i) => {
    const auto = i === 0 && step.auto === true ? ' auto="true"' : '';
    return `${i + 1}. ${step.text}${auto}`;
  });
  return `<nextsteps>\n${lines.join('\n')}\n</nextsteps>`;
}

// ── Response append ────────────────────────────────────────────────────────

/**
 * Whether a stop reason ends the turn.
 *
 * Mirrors `isFinalTurnStopReason` in `@wrongstack/tools/next-steps`, which
 * `core` cannot import (package DAG). Kept in lockstep by
 * `tests/next-steps-slot.test.ts`.
 */
function endsTurn(stopReason: string | undefined): boolean {
  return stopReason !== 'tool_use' && stopReason !== 'tool_call';
}

/**
 * Append the parked `<nextsteps>` block to the turn-ending response.
 *
 * Returns `res` untouched unless every gate passes:
 *
 * - **leader only** — subagent output is parsed or rolled up by its parent, so
 *   a suggestion block there is noise that leaks into specs and plans. Same
 *   check as `buildLiveNextStepsGateBlock`.
 * - **turn-ending stop reason** — mid-turn prose must not surface suggestions;
 *   every surface gates on this already.
 * - **not aborted** — an interrupted turn has no answer to follow up on.
 * - **no open todos** — finishing tracked work outranks proposing new work.
 *   Enforced here rather than per-surface so the gate has one home.
 * - **no block already in the text** — if the model also typed one, its own
 *   wording is the fresher intent and wins.
 *
 * The block is *appended* to the last text block, never prepended: the WebUI
 * only accepts a canonical-response update when it extends the text it already
 * streamed (`session-handlers.ts`), so a prefix would be silently dropped.
 */
export function maybeAppendPendingNextSteps(
  ctx: Pick<Context, 'meta' | 'agentId' | 'todos' | 'signal'>,
  res: Response,
): Response {
  if (ctx.agentId !== 'leader') return res;
  if (!endsTurn(res.stopReason)) return res;
  if (ctx.signal.aborted) return res;

  const steps = readPendingNextSteps(ctx);
  if (!steps) return res;
  if (hasOpenTodos(ctx.todos)) {
    // The suggestions are stale the moment tracked work is still open. Drop
    // them rather than holding them for a later iteration.
    clearPendingNextSteps(ctx);
    return res;
  }

  const lastTextIndex = res.content.findLastIndex(isTextBlock);
  if (lastTextIndex >= 0) {
    const block = res.content[lastTextIndex];
    if (block && isTextBlock(block) && hasNextStepsTag(block.text)) {
      clearPendingNextSteps(ctx);
      return res;
    }
  }

  const rendered = renderNextStepsBlock(steps);
  const content = [...res.content];
  const target = lastTextIndex >= 0 ? content[lastTextIndex] : undefined;
  if (target && isTextBlock(target)) {
    const separator = target.text.trim() ? '\n\n' : '';
    content[lastTextIndex] = { ...target, text: `${target.text}${separator}${rendered}` };
  } else {
    // A turn that ended with no prose at all (tool-only response that still
    // stopped). Carry the block on its own text block so it is not lost.
    content.push({ type: 'text', text: rendered });
  }

  clearPendingNextSteps(ctx);
  return { ...res, content };
}
