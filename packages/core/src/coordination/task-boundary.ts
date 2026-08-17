/**
 * Hard task-boundary contract for leader → subagent assignment tools.
 *
 * `delegate` and `assign_task` reject any assignment that does not carry an
 * explicit in-bounds `scope` and at least one concrete out-of-scope non-goal.
 * Prompt-only guidance ("state the scope and non-goals") degrades under
 * pressure: a rushed leader writes "fix it", the worker guesses the edges, and
 * the drift only surfaces at review time — the most expensive place to find
 * it. Forcing the boundary into structured fields makes the edges
 * machine-checkable at assignment time and lets the tool return a teaching
 * error that names exactly what is missing, so the leader self-corrects on
 * the next call instead of shipping a vague brief.
 *
 * The parsed boundary is composed into `TaskSpec.description` as a clearly
 * delimited block. That is deliberate: the description is the canonical brief
 * every runner, transcript, handoff continuation, and roll-up already
 * consumes, so the boundary travels with the task everywhere without new
 * plumbing (and `buildHandoffTask`'s "Original task:" carry-over preserves it
 * into fresh workers for free).
 */

import type { JSONSchema } from '../types/tool.js';

export interface TaskBoundary {
  /** What the work covers — the in-bounds statement. */
  scope: string;
  /** Explicit non-goals: things the worker must NOT do. */
  outOfScope: string[];
}

/**
 * Values that technically fill a field while stating nothing. A non-goal list
 * of ["none"] or a scope of "n/a" passes empty-string validation but defeats
 * the entire contract, so they are rejected with a teaching error.
 */
const PLACEHOLDER_VALUES = new Set([
  'n/a',
  'na',
  'none',
  'nothing',
  'tbd',
  'todo',
  'unknown',
  'unspecified',
  '-',
  '—',
  '.',
  'as above',
  'same as above',
  'see above',
  'see task',
  'same as task',
]);

const isPlaceholder = (value: string): boolean =>
  PLACEHOLDER_VALUES.has(value.trim().toLowerCase());

/**
 * Light floors against one-word filler, not quality gates. A scope needs to
 * be at least a short phrase ("run the e2e suite"); a non-goal needs to name
 * something ("no DB changes").
 */
const MIN_SCOPE_CHARS = 8;
const MIN_NON_GOAL_CHARS = 3;

export type TaskBoundaryParseResult =
  | { ok: true; boundary: TaskBoundary }
  | { ok: false; error: string; hint: string };

/**
 * Validate and normalize the `scope` / `outOfScope` pair from a tool input.
 * Returns the cleaned boundary, or an error + hint pair worded so the calling
 * leader can fix the call in one retry.
 */
export function parseTaskBoundary(raw: {
  scope?: unknown;
  outOfScope?: unknown;
}): TaskBoundaryParseResult {
  const scope = typeof raw.scope === 'string' ? raw.scope.trim() : '';
  if (scope.length < MIN_SCOPE_CHARS) {
    return {
      ok: false,
      error: `\`scope\` is missing or too vague — state in one concrete sentence what work this task covers (files, components, or commands in-bounds).`,
      hint: 'Example — scope: "Audit packages/core/src/parser/*.ts for unhandled token errors and report findings."',
    };
  }

  if (!Array.isArray(raw.outOfScope) || raw.outOfScope.length === 0) {
    return {
      ok: false,
      error:
        '`outOfScope` must be an array with at least one explicit non-goal — things the worker must NOT do.',
      hint: 'Example — outOfScope: ["Do not modify files outside packages/core", "Do not fix the bugs you find, only report them"].',
    };
  }
  const concrete = raw.outOfScope
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length >= MIN_NON_GOAL_CHARS && !isPlaceholder(item));
  if (concrete.length === 0) {
    return {
      ok: false,
      error:
        'Every `outOfScope` entry was a placeholder ("none", "n/a", …). Name at least one concrete non-goal: files or areas not to touch, changes not to make, features not to add.',
      hint: 'There is always an edge worth stating — "read-only, no edits", "no dependency changes", "do not touch other packages". If truly nothing comes to mind, the task is not decomposed enough yet.',
    };
  }

  return { ok: true, boundary: { scope, outOfScope: concrete } };
}

/**
 * Render the boundary as the block appended to `TaskSpec.description`. The
 * heading is loud on purpose: the worker treats these lines as hard edges,
 * and review-time drift checks quote them verbatim.
 */
export function renderTaskBoundaryBlock(boundary: TaskBoundary): string {
  return [
    '── TASK BOUNDARY (hard contract — these lines define your edges) ──',
    `Scope (what this task covers):\n${boundary.scope}`,
    `Out of scope (explicit non-goals — do NOT do any of these):\n${boundary.outOfScope
      .map((item) => `- ${item}`)
      .join('\n')}`,
  ].join('\n');
}

/**
 * Compose the leader's objective with its boundary into the canonical brief
 * delivered to the runner. The objective stays verbatim and first; the
 * boundary block follows so handoffs, transcripts, and roll-ups that quote
 * the description carry the edges with them.
 */
export function composeBoundedTaskDescription(objective: string, boundary: TaskBoundary): string {
  return `${objective.trim()}\n\n${renderTaskBoundaryBlock(boundary)}`;
}

/**
 * Shared schema property definitions so `delegate` and `assign_task` state
 * the identical contract. Declaring the fields here (rather than inline per
 * tool) keeps the required-field teaching text single-sourced.
 */
export const taskBoundarySchemaProperties: Record<string, JSONSchema> = {
  scope: {
    type: 'string',
    description:
      'REQUIRED. One concrete sentence stating what work this task covers — the in-bounds. The call is rejected without it.',
  },
  outOfScope: {
    type: 'array',
    items: { type: 'string', minLength: 1 },
    description:
      'REQUIRED. At least one explicit non-goal the worker must NOT do (files/areas not to touch, changes not to make, features not to add). Placeholders like "none" are rejected.',
  },
};
