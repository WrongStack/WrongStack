export interface HostSpawnOptions {
  provider?: string | undefined;
  model?: string | undefined;
  fallbackModels?: string[] | undefined;
  tools?: string[] | undefined;
  name?: string | undefined;
  allowedCapabilities?: readonly string[] | undefined;
  shadowIntervalMs?: number | undefined;
  /**
   * Conversation on whose behalf this spawn happens.
   *
   * The coordinator captures it once and the worker keeps it for life, so
   * every event, mail and roster row it produces lands in the tab that asked.
   * Omitted means the host's own session — correct for the CLI and the TUI,
   * and the boot tab (not the caller) once several tabs share the process.
   */
  originSessionId?: string | undefined;
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
