import type { TextBlock } from '@wrongstack/contracts/types/blocks';
import type { NextStepsMode } from '@wrongstack/contracts/types/config/autonomy';
import { NEXT_STEPS_COMPLETE_MARKER } from '../utils/next-steps.js';
import { formatTodoForModel, hasKanbanBoundTodos } from '../utils/todos-format.js';
import type { Context } from './context.js';
import { readPendingNextSteps } from './next-steps-slot.js';
import { SYSTEM_BLOCK_SOURCE } from './system-prompt-blocks.js';

const MAX_TODO_SNAPSHOT_ITEMS = 10;
const MAX_TODO_SNAPSHOT_CONTENT = 180;

const leaderPolicyByEpoch = new WeakMap<readonly TextBlock[], boolean>();

/**
 * Whether the frozen system prompt already carries the leader's after-task
 * rules (`leader-after-task.md`: required/optional modes, item rules, the todo
 * gate, the `nextsteps` tool route). The host builder includes it for every
 * leader in every mode; embedders with their own prompt may not. Cached per
 * prompt epoch.
 */
export function hasLeaderNextStepsPolicy(systemPrompt: readonly TextBlock[]): boolean {
  const cached = leaderPolicyByEpoch.get(systemPrompt);
  if (cached !== undefined) return cached;
  const found = systemPrompt.some(
    (block) => SYSTEM_BLOCK_SOURCE.get(block) === 'leader-after-task',
  );
  leaderPolicyByEpoch.set(systemPrompt, found);
  return found;
}

/**
 * Build the leader-only, per-request decision gate for `<nextsteps>`.
 *
 * The base system prompt is intentionally frozen for provider caching, while
 * todos change during tool execution. Keeping this block volatile makes the
 * final-response contract follow the live todo state on every iteration.
 *
 * `policyInPrompt`: the cached system prompt already states the rules, so the
 * gate carries only the live state and the branch it selects. Re-sending the
 * rule text here cost every request ~300 uncached tokens on breakpoint wires
 * and, on automatic-prefix wires, a permanent replayed copy per state change.
 */
export function buildLiveNextStepsGateBlock(
  ctx: Pick<Context, 'agentId' | 'todos'> &
    Partial<Pick<Context, 'meta'>> & { tools?: readonly { name: string }[] | undefined },
  mode: NextStepsMode = 'optional',
  policyInPrompt = false,
): TextBlock | undefined {
  if (ctx.agentId !== 'leader') return undefined;

  const todos = Array.isArray(ctx.todos) ? ctx.todos : [];
  const openTodos = todos.filter(
    (todo) => todo.status === 'pending' || todo.status === 'in_progress',
  );

  if (openTodos.length === 0) {
    // The tool has already satisfied the suggestion contract. Repeating the
    // required/optional branch here makes the next request ask for work that
    // succeeded, inviting identical tool calls until the loop guard fires.
    const pending = ctx.meta && readPendingNextSteps({ meta: ctx.meta });
    if (pending) {
      return {
        type: 'text',
        text: [
          '[nextsteps_gate]',
          `Authoritative live state for this request: open todos = 0; ${pending.length} nextsteps suggestions already recorded for this turn.`,
          'The next-steps requirement is satisfied. When the current work is complete, write your final response; the runtime will append the recorded suggestions automatically.',
          'Do not call `nextsteps` again unless you need to replace the recorded list. You do not need to repeat the <nextsteps> block in your final response.',
          '[/nextsteps_gate]',
        ].join('\n'),
      };
    }
    if (policyInPrompt) return buildCompactNoTodoGate(mode);
    // The opt-in `nextsteps` tool is a second way to satisfy branch 2. Mention
    // it only when it is actually registered, so a request without the tool
    // never carries a line pointing at something the model cannot call.
    const toolRoute = ctx.tools?.some((t) => t.name === 'nextsteps')
      ? [
          'Calling the `nextsteps` tool with the same items is an equal way to deliver the <nextsteps> block; if you both call it and write the block, the block wins.',
        ]
      : [];
    if (mode === 'required') return buildRequiredNextStepsGateBlock(toolRoute);
    // Omission is listed first and named the default on purpose: a "MUST pick
    // a branch" contract with the suggest branch first read as an obligation,
    // and in auto autonomy every padded suggestion is executed unattended.
    return {
      type: 'text',
      text: [
        '[nextsteps_gate]',
        'Authoritative live state for this request: open todos = 0.',
        '<nextsteps> is optional. On the final response:',
        "1. Default: if the user's request is complete, omit <nextsteps> and end the turn. This is the normal, correct ending. No special closing sentence is required; the outcome and relevant evidence are enough.",
        '2. Only if a concrete follow-on action exists that the user would plausibly want next, include a balanced <nextsteps> block containing 1-4 exact prompt messages that can be submitted back to you through the current TUI or WebUI input.',
        'Every item must ask the agent to perform work. Never put a human-only chore or an instruction addressed to the user inside <nextsteps>; natural-language agent-directed imperatives are valid and need not be shell commands.',
        "The recipient is the LLM, not the user. Each item is the next user prompt, submitted verbatim: name its target, action, and useful verification or output in the user's language. Omit manual chores, approval requests, and questions for the user.",
        ...toolRoute,
        'In auto autonomy a suggestion is executed without the user. Never emit <nextsteps> just to keep the run going; when the work is done, omit it and let the run end.',
        'Do not invent filler suggestions or defer unfinished authorized work into a suggestion.',
        '[/nextsteps_gate]',
      ].join('\n'),
    };
  }

  const todoSnapshot = openTodos.slice(0, MAX_TODO_SNAPSHOT_ITEMS).map((todo) => {
    const normalized = todo.content.replace(/\s+/g, ' ').trim();
    const content =
      normalized.length > MAX_TODO_SNAPSHOT_CONTENT
        ? `${normalized.slice(0, MAX_TODO_SNAPSHOT_CONTENT - 1)}…`
        : normalized;
    // Carry the Kanban binding: this snapshot is the model's live view of the
    // list, and a row stripped of its ids cannot be echoed back intact.
    return formatTodoForModel({ ...todo, content });
  });
  const omitted = openTodos.length - todoSnapshot.length;
  if (omitted > 0) todoSnapshot.push(`- …and ${omitted} more open todo(s)`);
  const todoReconciliation = ctx.tools?.some((tool) => tool.name === 'todo')
    ? [
        'Before ending the turn, you MUST call the `todo` tool with the complete current list to reconcile actual progress: finished items completed, exactly one actively worked item in_progress, and untouched items pending. A prose claim that work is done does not update the Todo/Kanban state.',
        ...(hasKanbanBoundTodos(openTodos)
          ? [
              'Rows below carry a <kanban board/task> binding. Pass those exact ids back as `kanbanBoardId`/`kanbanTaskId` on every row you resend; a row that arrives without its binding is not applied to its card.',
            ]
          : []),
      ]
    : [];

  return {
    type: 'text',
    text: [
      '[nextsteps_gate]',
      `Authoritative live state for this request: open todos = ${openTodos.length}.`,
      'You MUST omit <nextsteps> entirely while these todos remain open. Continue or finish the tracked work; do not propose unrelated follow-on work.',
      ...todoReconciliation,
      'Open todo snapshot:',
      ...todoSnapshot,
      '[/nextsteps_gate]',
    ].join('\n'),
  };
}

/**
 * Live state + selected branch only; the rules themselves are in the cached
 * "After-task suggestions" section of the system prompt.
 */
function buildCompactNoTodoGate(mode: NextStepsMode): TextBlock {
  const branch =
    mode === 'required'
      ? `Next-steps mode = required. Apply the Required-mode rules from "After-task suggestions": end with a balanced <nextsteps> block or ${NEXT_STEPS_COMPLETE_MARKER} on its own line.`
      : 'Next-steps mode = optional. Apply the Optional-mode rules from "After-task suggestions": the default ending is no <nextsteps> block; never emit one just to keep the run going.';
  return {
    type: 'text',
    text: [
      '[nextsteps_gate]',
      'Authoritative live state for this request: open todos = 0.',
      branch,
      '[/nextsteps_gate]',
    ].join('\n'),
  };
}

/**
 * `autonomy.nextSteps: 'required'` with no open todos: every finished turn
 * ends with suggestions or the completion marker. A turn that ends with
 * neither is asked once more by `maybeRequireNextSteps`.
 */
function buildRequiredNextStepsGateBlock(toolRoute: readonly string[]): TextBlock {
  return {
    type: 'text',
    text: [
      '[nextsteps_gate]',
      'Authoritative live state for this request: open todos = 0. Next-steps mode = required (set by the user).',
      'Every final response MUST end with exactly one of:',
      "1. A balanced <nextsteps> block containing 1-4 exact prompt messages for the most useful remaining work toward the user's goal. Each item is submitted back to you verbatim through the current TUI or WebUI input, and in auto autonomy it runs without the user.",
      'Every item must ask the agent to perform work. Never put a human-only chore or an instruction addressed to the user inside <nextsteps>; natural-language agent-directed imperatives are valid and need not be shell commands.',
      "The recipient is the LLM, not the user. Each item is the next user prompt, submitted verbatim: name its target, action, and useful verification or output in the user's language. Omit manual chores, approval requests, and questions for the user.",
      ...toolRoute,
      `2. The marker ${NEXT_STEPS_COMPLETE_MARKER} on its own line, only when the user's goal is fully achieved and verified and no meaningful work remains.`,
      'Prefer continuing real, verifiable work over declaring completion early, but never invent filler work to avoid the marker: when the goal is achieved, the marker is the correct ending.',
      '[/nextsteps_gate]',
    ].join('\n'),
  };
}
