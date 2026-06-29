import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { sessionScopedPath, toErrorMessage } from '@wrongstack/core/utils';
import {
  // createSessionEventBridge,
  // resolveAuditLevel,
  type AbandonedSession,
  attachTodosCheckpoint,
  Context,
  DEFAULT_SESSION_PRUNE_DAYS,
  DefaultAttachmentStore,
  expectDefined,
  loadDirectorState,
  loadPlan,
  loadTodosCheckpoint,
  QueueStore,
  RecoveryLock,
  type SessionStore,
  type SessionWriter,
  type WstackPaths,
} from '@wrongstack/core';
export interface SessionResult {
  session: SessionWriter;
  sessionRef: { current?: SessionWriter | undefined };
  /** 32-char hex trace ID for correlating storage events with agent iterations. */
  traceId: string;
  context: Context;
  restoredMessages: import('@wrongstack/core').Message[];
  attachments: DefaultAttachmentStore;
  recoveryLock: RecoveryLock;
  queueStore: QueueStore;
  planPath: string;
  detachTodosCheckpoint: () => void;
  /** Director state checkpoint from the prior run — null if this is not a resume. */
  priorFleetState?: import('@wrongstack/core').DirectorStateSnapshot | undefined;
  /** Tool execution records from the prior session (tool_call_end JSONL events). */
  restoredToolCalls: Array<{
    name: string;
    id: string;
    durationMs: number;
    ok: boolean;
    outputBytes?: number | undefined;
    outputTokens?: number | undefined;
    outputLines?: number | undefined;
  }>;
}

export async function setupSession(params: {
  config: {
    model: string;
    provider: string;
    features?: { allowOutsideProjectRoot?: boolean | undefined };
    tools?: { restrictToProjectRoot?: boolean | undefined } | undefined;
  };
  wpaths: WstackPaths;
  projectRoot: string;
  cwd: string;
  sessionStore: SessionStore;
  systemPrompt: import('@wrongstack/core').TextBlock[];
  provider: import('@wrongstack/core').Provider;
  tokenCounter: import('@wrongstack/core').TokenCounter;
  renderer: { writeInfo(msg: string): void; writeError(msg: string): void };
  flags: Record<string, unknown>;
  onRecovery: (
    abandoned: AbandonedSession,
    autoRecover: boolean,
  ) => Promise<'resume' | 'delete' | 'skip'>;
  /** Optional EventBus for emitting storage.* events from todo/queue/task stores. */
  events?: import('@wrongstack/core').EventBus;
}): Promise<SessionResult> {
  const {
    config,
    wpaths,
    projectRoot,
    cwd,
    sessionStore,
    systemPrompt,
    provider,
    tokenCounter,
    renderer,
    flags,
    onRecovery,
    // Optional EventBus for storage observability
    events: eventsBus,
  } = params;

  // Prune sessions older than the shared retention window on every interactive start.
  // Best-effort: failures here should not block the user.
  sessionStore
    .prune(DEFAULT_SESSION_PRUNE_DAYS)
    .then((count) => {
      if (count > 0) renderer.writeInfo(`Pruned ${count} old session${count === 1 ? '' : 's'}.`);
    })
    .catch((err) => console.debug(`[session] prune failed: ${err}`));

  let resumeId = typeof flags['resume'] === 'string' ? (flags['resume'] as string) : undefined;

  const recoveryLock = new RecoveryLock({ dir: wpaths.projectSessions, sessionStore });
  if (!resumeId && !flags['no-recovery']) {
    const abandoned = await recoveryLock.checkAbandoned();
    if (abandoned && abandoned.messageCount > 0) {
      const choice = await onRecovery(abandoned, !!flags['recover']);
      if (choice === 'resume') resumeId = abandoned.sessionId;
      else if (choice === 'delete') {
        await sessionStore
          .delete(abandoned.sessionId)
          .catch(() => undefined); /* best-effort: orphaned session will be cleaned by pruning */
        await recoveryLock.clear();
      } else await recoveryLock.clear();
    } else if (abandoned) {
      await sessionStore
        .delete(abandoned.sessionId)
        .catch(() => undefined); /* best-effort: orphaned session will be cleaned by pruning */
      await recoveryLock.clear();
    }
  }

  let session: SessionWriter | undefined;
  let restoredMessages: import('@wrongstack/core').Message[] = [];
  let restoredToolCalls: SessionResult['restoredToolCalls'] = [];
  if (resumeId) {
    try {
      const resumed = await sessionStore.resume(resumeId);
      session = resumed.writer;
      restoredMessages = resumed.data.messages;
      // Sessions written before tool_call_end events existed (or alternate
      // store impls) may not carry toolCallEnds — missing must not turn a
      // perfectly resumable session into RESUME_FAILED.
      restoredToolCalls = resumed.data.toolCallEnds ?? [];
      renderer.writeInfo(
        `Resumed session ${resumed.data.metadata.id} — ${restoredMessages.length} messages, ${restoredToolCalls.length} tool executions, ${resumed.data.usage.input + resumed.data.usage.output} tokens used previously.`,
      );
    } catch (err) {
      renderer.writeError(`Resume failed: ${toErrorMessage(err)}`);
      throw Object.assign(new Error('RESUME_FAILED'), { exitCode: 2 });
    }
  } else {
    session = await sessionStore.create({
      id: '',
      title: '',
      model: config.model,
      provider: config.provider,
    });
  }

  const sessionRef: { current?: SessionWriter | undefined } = { current: session };
  const sessionId = expectDefined(session?.id, 'active session id');
  const sessionDir = sessionScopedPath(wpaths.projectSessions, sessionId, '');
  await recoveryLock.write(sessionId).catch((err) => {
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'recovery_lock_write_failed',
        error: String(err),
        sessionId,
      }),
    );
  });

  const attachments = new DefaultAttachmentStore({
    spoolDir: path.join(sessionDir, 'attachments'),
  });

  const ctxSignal = new AbortController().signal;
  // Generate a session-level trace ID for correlating storage events (flush,
  // close, index writes) with agent iterations in observability pipelines.
  const traceId = randomBytes(16).toString('hex');
  const context = new Context({
    systemPrompt,
    provider,
    session: expectDefined(session),
    signal: ctxSignal,
    tokenCounter,
    cwd,
    projectRoot,
    // Filesystem-access scope: derived from features.allowOutsideProjectRoot,
    // falling back to the old tools.restrictToProjectRoot config key (inverted:
    // restrict=false in old config → allow=true in new). Togglable live via
    // `/settings` ("Allow outside project").
    allowOutsideProjectRoot:
      config.features?.allowOutsideProjectRoot ?? !(config.tools?.restrictToProjectRoot ?? false),
    model: config.model,
    agentId: 'leader',
    agentName: 'Leader Agent',
    traceId,
  });
  // Inject package-author-tracker options so the install tool can record authorship.
  context.meta['packageTrackerOpts'] = {
    storageDir: wpaths.projectDir,
    projectRoot,
  };
  if (restoredMessages.length > 0) context.state.replaceMessages(restoredMessages);

  const queueStore = new QueueStore({
    dir: sessionDir,
    ...(eventsBus ? { events: eventsBus } : {}),
    ...(traceId ? { traceId } : {}),
  });

  const todosCheckpointPath = sessionScopedPath(wpaths.projectSessions, sessionId, '.todos.json');
  if (resumeId) {
    try {
      const restoredTodos = await loadTodosCheckpoint(
        todosCheckpointPath,
        eventsBus,
        traceId,
      );
      if (restoredTodos && restoredTodos.length > 0) {
        context.state.replaceTodos(restoredTodos);
        renderer.writeInfo(
          `Restored ${restoredTodos.length} todo${restoredTodos.length === 1 ? '' : 's'} from previous run.`,
        );
      }
    } catch {
      /* best-effort */
    }
  }
  const detachTodosCheckpoint = attachTodosCheckpoint(
    context.state,
    todosCheckpointPath,
    sessionId,
    eventsBus,
    traceId,
  );

  const planPath = sessionScopedPath(wpaths.projectSessions, sessionId, '.plan.json');
  context.state.setMeta('plan.path', planPath);

  const taskPath = sessionScopedPath(wpaths.projectSessions, sessionId, '.tasks.json');
  context.state.setMeta('task.path', taskPath);

  let dirState;
  if (resumeId) {
    try {
      const fleetRoot = sessionDir;
      dirState = await loadDirectorState(path.join(fleetRoot, 'director-state.json'));
      if (dirState) {
        const tCounts: Record<string, number> = {};
        for (const t of dirState.tasks) tCounts[t.status] = (tCounts[t.status] ?? 0) + 1;
        const summary = Object.entries(tCounts)
          .map(([k, v]) => `${v} ${k}`)
          .join(', ');
        renderer.writeInfo(
          `Prior fleet state: ${dirState.subagents.length} subagent${dirState.subagents.length === 1 ? '' : 's'}, tasks ${summary || '(none)'}.`,
        );
      }
    } catch {
      /* ignore */
    }
    try {
      const plan = await loadPlan(planPath);
      if (plan && plan.items.length > 0) {
        const open = plan.items.filter((p) => p.status !== 'done').length;
        const done = plan.items.length - open;
        renderer.writeInfo(
          `Plan: ${plan.items.length} item${plan.items.length === 1 ? '' : 's'} (${open} open, ${done} done). Use /plan to review.`,
        );
      }
    } catch {
      /* ignore */
    }
  }

  return {
    session: expectDefined(session),
    sessionRef,
    traceId,
    context,
    restoredMessages,
    attachments,
    recoveryLock,
    queueStore,
    planPath,
    detachTodosCheckpoint,
    priorFleetState: dirState ?? undefined,
    restoredToolCalls,
  };
}

// Future (Phase 1+): when emitting richer audit events, resolve via:
// const auditLevel = resolveAuditLevel(fullConfig);
// const bridge = createSessionEventBridge(sessionWriter, auditLevel);
// Prefer passing the bridge instead of raw writer for new audit writes.
