export const WORKFLOW_STATES = [
  'draft',
  'scoped',
  'planned',
  'authorized',
  'executing',
  'proposed_complete',
  'verifying',
  'reviewing',
  'ready_to_merge',
  'completed',
  'blocked',
  'replan_requested',
  'rolling_back',
  'rolled_back',
  'rollback_failed',
  'failed',
  'cancelled',
] as const;

export type WorkflowState = (typeof WORKFLOW_STATES)[number];

const TERMINAL_STATES = new Set<WorkflowState>([
  'completed',
  'rolled_back',
  'rollback_failed',
  'failed',
  'cancelled',
]);

export function isTerminalWorkflowState(state: WorkflowState): boolean {
  return TERMINAL_STATES.has(state);
}

export function isSuccessfulWorkflowState(state: WorkflowState): boolean {
  return state === 'completed';
}
