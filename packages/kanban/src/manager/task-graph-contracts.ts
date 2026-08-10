export interface CreateKanbanBoardFromTaskGraphOptions {
  title?: string | undefined;
  description?: string | undefined;
  tags?: string[] | undefined;
  generatedBy?: string | undefined;
  sourceSystem?: string | undefined;
  phaseId?: string | undefined;
  includeCompletedTasks?: boolean | undefined;
}

export interface SyncKanbanBoardFromTaskGraphOptions extends CreateKanbanBoardFromTaskGraphOptions {
  archiveMissingTasks?: boolean | undefined;
  preserveManualDependencies?: boolean | undefined;
  /** Trusted migration/cancellation path only; ordinary sync may only retain or expand scope. */
  allowRequirementScopeShrink?: boolean | undefined;
}
