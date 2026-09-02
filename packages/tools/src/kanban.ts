import type { Tool } from '@wrongstack/core/types';
import { stripLifecycleIssues } from '@wrongstack/kanban';
import { handleKanbanBoardAction } from './kanban-board-actions.js';
import { handleKanbanContractAction } from './kanban-contract-actions.js';
import { handleKanbanDecompositionAction } from './kanban-decomposition-actions.js';
import { handleKanbanDetailAction } from './kanban-detail-actions.js';
import { handleKanbanLifecycleAction } from './kanban-lifecycle-actions.js';
import { createKanbanPresenceWrapper } from './kanban-presence.js';
import { serializeKanbanOutput } from './kanban-serializer.js';
import { fail } from './kanban-tool-results.js';
import {
  KANBAN_INPUT_SCHEMA,
  KANBAN_TOOL_DESCRIPTION,
  KANBAN_TOOL_USAGE_HINT,
} from './kanban-tool-schema.js';
import type { KanbanToolInput, KanbanToolOutput } from './kanban-tool-types.js';

type KanbanContext = Parameters<Tool<KanbanToolInput, KanbanToolOutput>['execute']>[1];

export const kanbanTool = {
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
    if (signal.aborted) return fail('Operation aborted.');

    const projectRoot = ctx.projectRoot;
    if (!projectRoot) return fail('No project root is available.');

    const withPresence = createKanbanPresenceWrapper(projectRoot, input, ctx);

    try {
      const result = await (async (): Promise<KanbanToolOutput> => {
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

        return fail(`Unknown kanban action: ${(input as { action: string }).action}`);
      })();
      return withPresence(result);
    } catch (err) {
      return fail(stripLifecycleIssues(err instanceof Error ? err.message : String(err)));
    }
  },
  serialize(output, input) {
    return serializeKanbanOutput(output, input);
  },
} satisfies Tool<KanbanToolInput, KanbanToolOutput>;
