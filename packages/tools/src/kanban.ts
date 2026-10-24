import type { Tool } from '@wrongstack/contracts/types';
import { handleKanbanBoardAction } from './kanban-board-actions.js';
import { handleKanbanContractAction } from './kanban-contract-actions.js';
import { handleKanbanDecompositionAction } from './kanban-decomposition-actions.js';
import { handleKanbanDetailAction } from './kanban-detail-actions.js';
import { handleKanbanLifecycleAction } from './kanban-lifecycle-actions.js';
import { guardKanbanManagement, rememberManagementRead } from './kanban-management-guard.js';
import { createKanbanPresenceWrapper } from './kanban-presence.js';
import { serializeKanbanOutput } from './kanban-serializer.js';
import { invalidInput, KanbanToolError, toKanbanToolError } from './kanban-tool-results.js';
import {
  KANBAN_INPUT_SCHEMA,
  KANBAN_TOOL_DESCRIPTION,
  KANBAN_TOOL_USAGE_HINT,
} from './kanban-tool-schema.js';
import type { KanbanToolInput, KanbanToolOutput } from './kanban-tool-types.js';

export type KanbanContext = Parameters<Tool<KanbanToolInput, KanbanToolOutput>['execute']>[1];
export {
  isKanbanToolFailure,
  KanbanInputError,
  KanbanToolError,
  type KanbanToolErrorCode,
  type KanbanToolFailure,
} from './kanban-tool-results.js';
export type { KanbanAction, KanbanToolInput, KanbanToolOutput } from './kanban-tool-types.js';
export { KANBAN_READ_ONLY_ACTIONS } from './kanban-tool-types.js';

/**
 * Agent-facing Kanban tool.
 *
 * Error contract: operational failures THROW (the executor only marks a call
 * failed when execute() throws). Invalid input throws `KanbanInputError`
 * (a `ToolValidationError`); not-found / refused / conflict / unavailable /
 * aborted throw `KanbanToolError` with `kanbanCode`, `retryable` and, for a
 * lifecycle refusal, the structured `issues`. Unrecognised errors (TypeError
 * etc.) propagate unchanged. Data outcomes — a completion-gate verdict,
 * `claimed: false`, `recoveredTasks: []`, `imported: 0` — are returned, and
 * every returned result has `ok: true`.
 */
export const kanbanTool: Tool<KanbanToolInput, KanbanToolOutput> = {
  name: 'kanban',
  category: 'Project',
  description: KANBAN_TOOL_DESCRIPTION,
  usageHint: KANBAN_TOOL_USAGE_HINT,
  permission: 'confirm',
  subjectKey: 'action',
  mutating: true,
  capabilities: ['fs.write'],
  icon: 'task',
  timeoutMs: 30_000,
  inputSchema: KANBAN_INPUT_SCHEMA,
  async execute(input: KanbanToolInput, ctx: KanbanContext, _opts?: { signal: AbortSignal }) {
    const signal = _opts?.signal ?? ctx.signal ?? new AbortController().signal;
    if (signal.aborted) {
      throw new KanbanToolError('ABORTED', 'Operation aborted before any Kanban work ran.');
    }

    if (
      !input ||
      typeof input !== 'object' ||
      typeof input.action !== 'string' ||
      !input.action.trim()
    ) {
      throw invalidInput('kanban: action is required and must be a non-empty string.', 'action');
    }

    const normalizedInput: KanbanToolInput = {
      ...input,
      action: input.action.trim() as KanbanToolInput['action'],
    };

    const projectRoot = ctx.projectRoot;
    if (!projectRoot) {
      throw new KanbanToolError('UNAVAILABLE', 'No project root is available.', {
        retryable: false,
      });
    }

    const withPresence = createKanbanPresenceWrapper(projectRoot, normalizedInput, ctx);

    let result: KanbanToolOutput;
    try {
      await guardKanbanManagement(normalizedInput, ctx);
      result = await dispatchKanbanAction(projectRoot, normalizedInput, ctx);
    } catch (err) {
      throw toKanbanToolError(err);
    }

    // An abort that lands AFTER the handler returned cannot undo the work: the
    // mutation (if any) is committed, so report what happened. Only skip the
    // best-effort presence write.
    const finalResult = signal.aborted ? result : await withPresence(result);
    rememberManagementRead(ctx, finalResult.board);
    return finalResult;
  },
  serialize(output, input) {
    return serializeKanbanOutput(output, input);
  },
} satisfies Tool<KanbanToolInput, KanbanToolOutput>;

async function dispatchKanbanAction(
  projectRoot: string,
  input: KanbanToolInput,
  ctx: KanbanContext,
): Promise<KanbanToolOutput> {
  const decompositionResult = await handleKanbanDecompositionAction(projectRoot, input, ctx);
  if (decompositionResult !== undefined) return decompositionResult;

  const boardResult = await handleKanbanBoardAction(projectRoot, input, ctx);
  if (boardResult !== undefined) return boardResult;

  const lifecycleResult = await handleKanbanLifecycleAction(projectRoot, input, ctx);
  if (lifecycleResult !== undefined) return lifecycleResult;

  const contractResult = await handleKanbanContractAction(
    projectRoot,
    input,
    input.author ?? input.agentId,
    ctx.eventSessionId?.() ?? ctx.session?.id ?? 'default-session',
  );
  if (contractResult !== undefined) return contractResult;

  const detailResult = await handleKanbanDetailAction(projectRoot, input, ctx);
  if (detailResult !== undefined) return detailResult;

  throw invalidInput(`Unknown kanban action: ${(input as { action: string }).action}`, 'action');
}
