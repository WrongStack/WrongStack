export interface HostSpawnOptions {
  provider?: string | undefined;
  model?: string | undefined;
  fallbackModels?: string[] | undefined;
  tools?: string[] | undefined;
  name?: string | undefined;
  allowedCapabilities?: readonly string[] | undefined;
  shadowIntervalMs?: number | undefined;
  /**
   * Free-form task context propagated into the spawned `TaskSpec.context`.
   * Used by `/kanban task dispatch` (and the WebUI relay) to carry
   * `{ kanban: { boardId, taskId } }` so the tool-runtime boundary gate
   * (`evaluateToolKanbanBoundary`) can resolve the live policy instead
   * of failing open.
   */
  context?:
    | {
        kanban?: { boardId?: string; taskId?: string; projectRoot?: string };
      }
    | undefined;
}

export type HostSpawnAndWaitOptions = Omit<HostSpawnOptions, 'shadowIntervalMs'>;
