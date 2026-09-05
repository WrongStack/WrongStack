import type { FileEventRecord } from '../types/file-event-record.js';
import type { SessionWriter } from '../types/session.js';
import type { SideEffect } from '../types/side-effect.js';

export interface FileTrackerState {
  readFiles: Set<string>;
  writtenFiles: Set<string>;
  fileMtimes: Map<string, number>;
  fileHashes: Map<string, string>;
  sideEffects: SideEffect[];
  fileEvents: FileEventRecord[];
}

export function trimSet(set: Set<string>, max: number): void {
  while (set.size > max) {
    const oldest = set.values().next().value;
    if (oldest === undefined) break;
    set.delete(oldest);
  }
}

export function trimMap(map: Map<string, unknown>, max: number): void {
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

export function trimTrackedFiles(
  state: {
    readFiles: Set<string>;
    writtenFiles: Set<string>;
    fileMtimes: Map<string, number>;
    fileHashes: Map<string, string>;
  },
  maxTrackedFiles: number,
): void {
  trimSet(state.readFiles, maxTrackedFiles);
  trimSet(state.writtenFiles, maxTrackedFiles);
  trimMap(state.fileMtimes, maxTrackedFiles);
  trimMap(state.fileHashes, maxTrackedFiles);
}

export function recordFileObservation(
  state: {
    readFiles: Set<string>;
    writtenFiles: Set<string>;
    fileMtimes: Map<string, number>;
    fileHashes: Map<string, string>;
  },
  session: SessionWriter,
  absPath: string,
  mtimeMs: number,
  source: 'user' | 'write' = 'user',
  contentHash?: string,
  maxTrackedFiles: number = 5_000,
): void {
  if (contentHash !== undefined) {
    state.fileHashes.set(absPath, contentHash);
  } else {
    const prevMtime = state.fileMtimes.get(absPath);
    if (prevMtime !== mtimeMs) state.fileHashes.delete(absPath);
  }
  state.fileMtimes.set(absPath, mtimeMs);
  if (contentHash !== undefined) {
    session.recordFileObservation?.({
      path: absPath,
      hash: contentHash,
      mtimeMs,
      source,
    });
  }
  if (source === 'write') {
    state.writtenFiles.add(absPath);
  } else {
    state.readFiles.add(absPath);
  }
  trimTrackedFiles(state, maxTrackedFiles);
}

export function recordSideEffectEntry(
  sideEffects: SideEffect[],
  sessionWriter: SessionWriter,
  sideEffect: SideEffect,
  maxSideEffects: number = 500,
): void {
  sideEffects.push(sideEffect);
  if (sideEffects.length > maxSideEffects) {
    sideEffects.splice(0, sideEffects.length - maxSideEffects);
  }
  sessionWriter
    .append({
      type: 'side_effect',
      ts: sideEffect.ts,
      toolUseId: sideEffect.toolUseId,
      toolName: sideEffect.toolName,
      input: sideEffect.input,
      outcome: sideEffect.outcome,
      risk: sideEffect.risk,
    })
    .catch(() => {
      /* best-effort — never block tool execution */
    });
}

export interface RecordFileEventContext {
  eventSessionId: () => string;
  agentId: string;
  agentName: string;
  provider: unknown;
  model: string;
  activeLogicalRequestId?: string | undefined;
  activePromptManifestId?: string | undefined;
  currentKanbanTaskId?: string | undefined;
  currentKanbanBoardId?: string | undefined;
  activeRunSessionWriter?: SessionWriter | undefined;
  session: SessionWriter;
}

export function recordFileEventEntry(
  fileEvents: FileEventRecord[],
  ctx: RecordFileEventContext,
  input: {
    operation: 'create' | 'read' | 'update' | 'delete' | 'rename';
    filePath: string;
    absPath: string;
    toolName: string;
    toolUseId: string;
    durationMs?: number | undefined;
    fileSize?: number | undefined;
    lines?: number | undefined;
    bytes?: number | undefined;
  },
  maxFileEvents: number = 1000,
): void {
  const scope = ctx.currentKanbanTaskId ? 'task' : 'session';
  const ts = new Date().toISOString();
  const record: FileEventRecord = {
    operation: input.operation,
    filePath: input.filePath,
    absPath: input.absPath,
    sessionId: ctx.eventSessionId(),
    agentId: ctx.agentId,
    agentName: ctx.agentName,
    provider:
      typeof ctx.provider === 'object' && ctx.provider !== null
        ? ((ctx.provider as { id?: string }).id ?? String(ctx.provider))
        : String(ctx.provider),
    model: ctx.model,
    ...(ctx.activeLogicalRequestId ? { logicalRequestId: ctx.activeLogicalRequestId } : {}),
    ...(ctx.activePromptManifestId ? { promptManifestId: ctx.activePromptManifestId } : {}),
    provenanceConfidence:
      ctx.activeLogicalRequestId && ctx.activePromptManifestId ? 'explicit' : 'unknown',
    toolName: input.toolName,
    toolUseId: input.toolUseId,
    scope,
    taskId: ctx.currentKanbanTaskId,
    boardId: ctx.currentKanbanBoardId,
    timestamp: ts,
    durationMs: input.durationMs,
    fileSize: input.fileSize,
    lines: input.lines,
    bytes: input.bytes,
  };

  fileEvents.push(record);
  if (fileEvents.length > maxFileEvents) {
    fileEvents.splice(0, fileEvents.length - maxFileEvents);
  }

  const sessionWriter = ctx.activeRunSessionWriter ?? ctx.session;
  sessionWriter
    .append({
      type: 'file_event',
      ts,
      operation: input.operation,
      filePath: input.filePath,
      absPath: input.absPath,
      sessionId: record.sessionId,
      agentId: ctx.agentId,
      agentName: ctx.agentName,
      provider: record.provider,
      model: record.model,
      ...(record.logicalRequestId ? { logicalRequestId: record.logicalRequestId } : {}),
      ...(record.promptManifestId ? { promptManifestId: record.promptManifestId } : {}),
      provenanceConfidence: record.provenanceConfidence,
      toolName: input.toolName,
      toolUseId: input.toolUseId,
      scope,
      taskId: ctx.currentKanbanTaskId,
      boardId: ctx.currentKanbanBoardId,
      durationMs: input.durationMs,
      fileSize: input.fileSize,
      lines: input.lines,
      bytes: input.bytes,
    })
    .catch(() => {
      /* best-effort — never block tool execution */
    });
}
