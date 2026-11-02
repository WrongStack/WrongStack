/**
 * A todo row, in its own leaf module so the conversation state can name it
 * without importing the agent context (which imports the conversation state
 * back). `context.ts` re-exports it unchanged.
 */

/** A single todo row projected to the model and the UI. */
export interface TodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string | undefined;
  /** When promoted from a plan item, stores the plan item's id. */
  promotedFromPlan?: string | undefined;
  /** When promoted from a task, stores the task's id. */
  promotedFromTask?: string | undefined;
  /** Durable Kanban owner when the todo row is a UI projection of a real card. */
  kanbanBoardId?: string | undefined;
  /** Durable Kanban card represented by this todo row. */
  kanbanTaskId?: string | undefined;
  /** Titles of the unfinished work this row waits on (board-derived). */
  blockedBy?: string[] | undefined;
}
