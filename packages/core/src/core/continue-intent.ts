/**
 * Continue-intent detection + continuation resolution.
 *
 * ## Problem
 *
 * Users frequently type a bare "continue" (or "devam", "go on", "keep going")
 * to nudge the agent forward without supplying any new instruction. On its own
 * that word carries no information about *what* to continue — the model has to
 * re-derive "what was next" from history, which drifts as the context window is
 * compacted. Left unanchored, a run of "continue … continue … continue" turns
 * into an ever-vaguer manual loop: the model repeats work, declares completion
 * prematurely, or wanders.
 *
 * ## Approach
 *
 * A bare "continue" is not new information — it points at an *existing* goal.
 * So instead of asking the model to remember a hidden per-message marker, we
 * resolve the continuation against the state we already keep:
 *
 *   1. **Open todos** — the strongest, most durable anchor. Survives context
 *      compaction (todos are re-injected each turn) and goal.json persistence.
 *      "continue" = resume the next open todo.
 *   2. **Parsed `<nextsteps>` suggestions** — the menu surfaced after the last
 *      completed turn (already extracted and stored by the surface's
 *      suggestion store). "continue" = do suggestion #1.
 *   3. **Open continuation** — no explicit task is queued, but the user still
 *      wants work to proceed. We inject an instruction that tells the model to
 *      pick the single most valuable next step itself and carry it out — while
 *      explicitly forbidding fabricated busywork. This is what keeps "continue"
 *      from ever dead-ending.
 *
 * This module is pure and surface-agnostic: detection takes the raw string,
 * resolution takes already-collected data (todos + parsed suggestion strings).
 * The REPL and TUI wire it in at the point where a user message becomes an
 * agent run, *before* prompt refinement — a bare "continue" has nothing
 * meaningful to refine, and refining it would only add latency and drift.
 *
 * The three triggers of the same continuation machinery — the user typing
 * "continue", the model emitting the `[continue]` marker (see
 * {@link parseContinueDirective}), and an autonomy tick — all ultimately want
 * the same thing: advance the plan. This module is the manual-trigger path.
 */

import { hasOpenTodos } from '../utils/todos-format.js';
import type { TodoItem } from './context.js';

// ── Detection ────────────────────────────────────────────────────────────────

/**
 * Normalized phrases that mean "just keep going" on their own. Matched by
 * exact equality after {@link normalizeContinueInput}, which is deliberately
 * strict: a message is a bare-continue only when it is *nothing but* one of
 * these phrases (plus optional trailing politeness / punctuation). This makes
 * false positives structurally impossible — "continue with the auth refactor"
 * normalizes to a longer string that is not in the set, so it falls through to
 * normal handling.
 *
 * Coverage skews to the two languages this project's users type in (English,
 * Turkish) with a handful of common Latin-script others. Add sparingly — every
 * entry is a phrase we promise carries no other meaning in an agent prompt.
 */
const CONTINUE_PHRASES: ReadonlySet<string> = new Set([
  // ── English ──
  'continue',
  'cont',
  'continue continue',
  'continue working',
  'keep going',
  'keep it going',
  'keep going on',
  'keep working',
  'keep on',
  'carry on',
  'go on',
  'goon',
  'go ahead',
  'proceed',
  'proceed further',
  'onward',
  'onwards',
  'next',
  'next step',
  'more',
  'resume',
  'and continue',
  'yes continue',
  'ok continue',
  // ── Turkish ──
  'devam',
  'devam et',
  'devam et bakalim',
  'devam edelim',
  'devam edin',
  'devam etsene',
  'devam etsenize',
  'devam ediyoruz',
  'devam et lutfen',
  'surdur',
  'devam etsen',
  'devam et hadi',
  'hadi devam',
  'bir tur daha',
  'bir tur daha at',
  'bir tur daha bakalim',
  'bir tur daha atalim',
  'bir tur daha at bakalim',
  // ── Other Latin-script (light coverage) ──
  'weiter', // de
  'mach weiter', // de
  'continuar', // es/pt
  'continua', // es/it/pt
  'continuer', // fr
  'continue por favor', // pt/es
]);

/**
 * Trailing politeness / filler tokens stripped before matching, so
 * "continue please" and "devam et lütfen" resolve to their base phrase.
 * (Turkish diacritics are folded to ASCII first, so "lütfen" → "lutfen".)
 */
const POLITENESS_SUFFIXES: readonly string[] = [
  'please',
  'pls',
  'plz',
  'lutfen',
  'thanks',
  'thank you',
  'thx',
  'ty',
];

/** Fold the handful of Turkish diacritics we care about to ASCII. */
function foldDiacritics(s: string): string {
  return s
    .replace(/ü/g, 'u')
    .replace(/ö/g, 'o')
    .replace(/ç/g, 'c')
    .replace(/ş/g, 's')
    .replace(/ğ/g, 'g')
    .replace(/ı/g, 'i')
    .replace(/İ/g, 'i')
    .replace(/â/g, 'a')
    .replace(/î/g, 'i')
    .replace(/û/g, 'u');
}

/**
 * Normalize a raw user message for bare-continue matching:
 * lowercase → fold diacritics → strip wrapping quotes/backticks → strip
 * surrounding punctuation → collapse internal whitespace → drop one trailing
 * politeness token. Returns the normalized string (possibly empty).
 */
function normalizeContinueInput(raw: string): string {
  let s = raw.trim().toLowerCase();
  s = foldDiacritics(s);
  // Strip a single layer of wrapping quotes/backticks.
  s = s.replace(/^["'`]+/, '').replace(/["'`]+$/, '');
  // Strip leading/trailing punctuation and whitespace runs.
  s = s.replace(/^[\s.!?,;:…]+/, '').replace(/[\s.!?,;:…]+$/, '');
  // Collapse internal whitespace.
  s = s.replace(/\s+/g, ' ').trim();
  // Drop one trailing politeness token (e.g. "continue please" → "continue").
  for (const suffix of POLITENESS_SUFFIXES) {
    if (s === suffix) break; // a bare "please" is not a continue
    if (s.endsWith(` ${suffix}`)) {
      s = s.slice(0, s.length - suffix.length - 1).trim();
      break;
    }
  }
  return s;
}

/** Longest phrase in the set, in words — a cheap upper bound for the guard. */
const MAX_CONTINUE_WORDS = 4;

/**
 * True when `raw` is a bare "continue"-style nudge and nothing else.
 *
 * Strict by construction: the message must normalize to exactly one of
 * {@link CONTINUE_PHRASES}. Anything with additional substance ("continue but
 * skip tests", "go on to the next file and commit") normalizes to a string
 * outside the set and returns false, so it is handled as an ordinary message.
 */
export function detectContinueIntent(raw: string): boolean {
  if (!raw) return false;
  // Fast length guard — bare-continue phrases are short. Avoids normalizing
  // large pastes.
  if (raw.length > 40) return false;
  const normalized = normalizeContinueInput(raw);
  if (!normalized) return false;
  if (normalized.split(' ').length > MAX_CONTINUE_WORDS) return false;
  return CONTINUE_PHRASES.has(normalized);
}

// ── Resolution ───────────────────────────────────────────────────────────────

/**
 * Where the resolved continuation came from:
 *   - `todo`       — resumed the next open todo (strongest anchor)
 *   - `suggestion` — took the top parsed `<nextsteps>` suggestion
 *   - `open`       — no explicit task queued; model self-determines the step
 */
export type ContinuationSource = 'todo' | 'suggestion' | 'open';

export interface ContinuationInput {
  /** Live todo list (`ctx.todos`). */
  todos?: readonly TodoItem[] | undefined;
  /** Already-parsed `<nextsteps>` suggestion strings from the surface store. */
  suggestions?: readonly string[] | undefined;
}

export interface ResolvedContinuation {
  source: ContinuationSource;
  /** Stable todo id when the continuation is grounded in the live work list. */
  todoId?: string | undefined;
  /**
   * The concrete instruction injected as the next user turn in place of the
   * bare "continue". Written for the model, not the human.
   */
  text: string;
  /**
   * Short one-line label for the surface to echo (dim) so the human sees what
   * "continue" resolved to without the full injected paragraph.
   */
  label: string;
}

/** Truncate a string to `max` chars with an ellipsis, for labels. */
function ellipsize(s: string, max = 72): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * Resolve what a bare "continue" should do, given the current run state.
 *
 * The ladder — first match wins:
 *   1. an open todo (in-progress preferred, else the first pending),
 *   2. the top stored suggestion,
 *   3. an open continuation that never dead-ends.
 *
 * Always returns a usable {@link ResolvedContinuation}; the `open` branch is
 * the guaranteed fallback so "continue" keeps work moving even with no todos
 * and no suggestions.
 */
export function resolveContinuation(input: ContinuationInput): ResolvedContinuation {
  const todos = Array.isArray(input.todos) ? input.todos : [];
  const suggestions = (Array.isArray(input.suggestions) ? input.suggestions : []).filter(
    (s): s is string => typeof s === 'string' && s.trim().length > 0,
  );

  // 1 ── Open todos: the durable anchor.
  if (hasOpenTodos(todos)) {
    const inProgress = todos.find((t) => t.status === 'in_progress');
    const next = inProgress ?? todos.find((t) => t.status === 'pending');
    if (next) {
      const total = todos.length;
      const done = todos.filter((t) => t.status === 'completed').length;
      const item =
        next.status === 'in_progress' && next.activeForm ? next.activeForm : next.content;
      // Embed the full board snapshot (not just the next item). Two reasons:
      //   - the model gets the complete plan state every continuation instead
      //     of a single line, so multi-turn work stays grounded;
      //   - the continuation text changes whenever ANY board state changes,
      //     so the auto-proceed repetition guard only sees identical prompts
      //     when the board is genuinely frozen across whole turns — real
      //     progress (items completed, added, re-ordered, re-statused) never
      //     trips it.
      // Cap displayed rows so the prompt doesn't balloon. 20 rows keeps the
      // board readable for both small and large todo lists without crowding
      // the continuation prompt with hundreds of items.
      const BOARD_MAX_ROWS = 20;
      const board = todos.slice(0, BOARD_MAX_ROWS).map((t) => {
        const mark = t.status === 'completed' ? '[x]' : t.status === 'in_progress' ? '[~]' : '[ ]';
        // Flatten newlines so multi-line todo content doesn't break the
        // board's structured layout — each row is exactly one line.
        const flatContent = t.content.replace(/\n|\r/g, ' ');
        return `  ${mark} ${flatContent}`;
      });
      if (todos.length > BOARD_MAX_ROWS) {
        board.push(`  … ${todos.length - BOARD_MAX_ROWS} more`);
      }
      const text = [
        'Continue with the plan. Resume work on the next open todo:',
        '',
        `  ${item}`,
        '',
        `Current todo board (${done}/${total} todos complete.):`,
        ...board,
        '',
        'If this item is already done, mark it complete and move to the next open todo. Keep the board honest as you work — mark finished items completed and split items that need more than one turn. When every todo is complete, stop and give a short summary — do not invent new work.',
      ].join('\n');
      return {
        source: 'todo',
        todoId: next.id,
        text,
        label: `▶ Continue → todo: ${ellipsize(item)}`,
      };
    }
  }

  // 2 ── Top parsed suggestion.
  const top = suggestions[0];
  if (top) {
    const text = [
      'Continue. Proceed with this next step:',
      '',
      `  ${top}`,
      '',
      'Carry it out now. When it is done, briefly report the result.',
    ].join('\n');
    return { source: 'suggestion', text, label: `▶ Continue → ${ellipsize(top)}` };
  }

  // 3 ── Open continuation: no queued task, but keep working.
  const text = [
    'Continue working.',
    '',
    'There is no explicit pending task queued, so decide the single most valuable next step yourself based on our conversation so far and the current state of the project, then carry it out.',
    '',
    'Prefer finishing, verifying, or hardening work already in progress over starting something unrelated. If the work is genuinely complete and nothing sensible remains, say so plainly in one or two sentences and propose a direction — do not fabricate busywork.',
  ].join('\n');
  return { source: 'open', text, label: '▶ Continue → (no pending task — choosing next step)' };
}
