export interface HostSpawnOptions {
  provider?: string | undefined;
  model?: string | undefined;
  fallbackModels?: string[] | undefined;
  tools?: string[] | undefined;
  name?: string | undefined;
  allowedCapabilities?: readonly string[] | undefined;
  shadowIntervalMs?: number | undefined;
  /**
   * Opt into model-driven completion (mirrors the Chimera reviewer policy).
   *
   * At the leader's session end, `finalizeExecutionCleanup` calls
   * `director.requestFinish()`, which notifies ONLY the subagents that set
   * this. An opted-in worker receives an in-band `subagent.finish_requested`
   * between tool batches and is granted a grace window to finish and deliver
   * its result during the drain that precedes `director.terminateAll()`.
   *
   * Without it the subagent is skipped by that notification and then hard-
   * aborted by the terminal sweep — its work is lost mid-flight. Required for
   * background auditors whose deliverable is a mailbox report rather than a
   * value the leader is still awaiting.
   */
  gracefulFinish?: boolean | { graceMs?: number | undefined } | undefined;
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
