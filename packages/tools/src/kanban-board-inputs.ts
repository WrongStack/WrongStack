import { invalidInput } from './kanban-tool-results.js';
import type { KanbanToolInput } from './kanban-tool-types.js';

/**
 * The completion gate, as reachable from the `kanban` TOOL.
 *
 * WS-023: `gateEnforcement` is a model-settable enum and `'off'` was one of
 * its values, so the agent whose work the gate checks could create or update a
 * board with the gate disabled — self-attestation with an extra step. An agent
 * may still TIGHTEN its own gate; it may not switch it off.
 *
 * `'off'` remains available to a human through board config and to internal
 * non-LLM callers, which is where that decision belongs. Enforced here as well
 * as in the tool schema because a published schema is a contract, not a
 * control — WS-026 found `tools/call` forwarding arguments without checking
 * one at all.
 *
 * `'off'` is REJECTED, not silently dropped: dropping it let the call report
 * success while doing something other than what was asked.
 */
function agentSettableGate(
  enforcement: KanbanToolInput['gateEnforcement'],
): { completionGate: { enforcement: 'strict' | 'soft' } } | Record<string, never> {
  if (enforcement === undefined) return {};
  if (enforcement !== 'strict' && enforcement !== 'soft') {
    let label: string;
    try {
      label = String(enforcement);
    } catch {
      label = '<unprintable>';
    }
    throw invalidInput(
      `gateEnforcement "${label}" is not settable from the kanban tool; only "strict" or "soft" (switching the completion gate off is a human decision made through board config).`,
      'gateEnforcement',
    );
  }
  return { completionGate: { enforcement } };
}

export function boardCreateInput(input: KanbanToolInput, title: string) {
  return {
    title,
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.tags !== undefined ? { tags: input.tags } : {}),
    ...(input.generatedBy !== undefined ? { generatedBy: input.generatedBy } : {}),
    ...(input.atomicityMode !== undefined
      ? {
          atomicity: {
            mode: input.atomicityMode,
            decomposition: input.atomicityDecomposition ?? 'propose',
          },
        }
      : {}),
    ...agentSettableGate(input.gateEnforcement),
  };
}

export function boardUpdatePatch(input: KanbanToolInput) {
  return {
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.tags !== undefined ? { tags: input.tags } : {}),
    ...(input.atomicityMode !== undefined
      ? {
          atomicity: {
            mode: input.atomicityMode,
            decomposition: input.atomicityDecomposition ?? 'propose',
          },
        }
      : {}),
    ...agentSettableGate(input.gateEnforcement),
  };
}

export function duplicateBoardOptions(input: KanbanToolInput) {
  return {
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.generatedBy !== undefined ? { generatedBy: input.generatedBy } : {}),
    ...(input.includeTasks !== undefined ? { includeTasks: input.includeTasks } : {}),
    ...(input.includeCompletedTasks !== undefined
      ? { includeCompletedTasks: input.includeCompletedTasks }
      : {}),
    ...(input.preserveAssignment !== undefined
      ? { preserveAssignment: input.preserveAssignment }
      : {}),
  };
}
