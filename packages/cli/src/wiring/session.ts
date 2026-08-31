import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import { Context } from '@wrongstack/core/agent';
import {
  restoreSessionSubagentPolicy,
  seedSessionSubagentPolicy,
} from '@wrongstack/core/coordination';
import { ProviderCacheLedger } from '@wrongstack/core/infrastructure';
import {
  attachTodosCheckpoint,
  cleanOrphanLocks,
  DefaultAttachmentStore,
  loadDirectorState,
  loadPlan,
  loadTodosCheckpoint,
  QueueStore,
} from '@wrongstack/core/storage';
import {
  DEFAULT_SESSION_PRUNE_DAYS,
  type SessionStore,
  type SessionWriter,
} from '@wrongstack/core/types';
import { projectLastRequestTokens } from '@wrongstack/core/types/session-timeline';
import {
  expectDefined,
  sessionScopedPath,
  toErrorMessage,
  type WstackPaths,
} from '@wrongstack/core/utils';
import {
  attachSessionKanbanMirror,
  hydrateSessionKanban,
  sessionKanbanDegradation,
} from '@wrongstack/tools/session-kanban';
import { announceRecoverableSession, pickResumeCandidate } from './resume-candidate.js';
export interface SessionResult {
  session: SessionWriter;
  sessionRef: { current?: SessionWriter | undefined };
  /** 32-char hex trace ID for correlating storage events with agent iterations. */
  traceId: string;
  context: Context;
  restoredMessages: import('@wrongstack/core/types').Message[];
  attachments: DefaultAttachmentStore;
  queueStore: QueueStore;
  planPath: string;
  detachTodosCheckpoint: () => void | Promise<void>;
  /** Flush the current todo checkpoint and bind persistence to another session before its todos load. */
  rebindTodosCheckpoint: (sessionId: string, sessionsDir?: string) => Promise<void>;
  /** Director state checkpoint from the prior run — null if this is not a resume. */
  priorFleetState?: import('@wrongstack/core/storage').DirectorStateSnapshot | undefined;
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
  /**
   * Raw JSONL event stream from the prior session. Empty when not resuming.
   * Feeds the canonical resume renderer so boot `--resume` shows tool I/O and
   * interleaved audit markers (mode/compaction/checkpoint/skill/…) — matching
   * the in-session resume picker instead of meta-only tool chips.
   */
  restoredEvents: import('@wrongstack/core/types').SessionEvent[];
  /**
   * Model/provider recorded in the resumed session. Undefined when not
   * resuming. The boot path applies these via switchProviderAndModel once the
   * provider runtime is wired, so `wstack --resume <id>` continues on the
   * session's own model — parity with the in-session resume picker
   * (tui-session-resume.ts). Falls back gracefully to the current default when
   * the recorded provider is no longer available.
   */
  resumedModel?: string | undefined;
  resumedProvider?: string | undefined;
}

export interface SessionClaimHandle {
  rollback(): Promise<void>;
  /** Convert the pre-hydration reservation into the live writer lease. */
  activate(): Promise<void>;
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
  systemPrompt: import('@wrongstack/core/types').TextBlock[];
  provider: import('@wrongstack/core/types').Provider;
  tokenCounter: import('@wrongstack/core/types').TokenCounter;
  renderer: { writeInfo(msg: string): void; writeError(msg: string): void };
  flags: Record<string, unknown>;
  /**
   * Atomically reserve an explicitly resumed session in the cross-process
   * SessionRegistry. Returns a rollback used when loading the session fails.
   */
  claimSession?:
    | ((sessionId: string) => Promise<SessionClaimHandle | (() => Promise<void>)>)
    | undefined;
  /** Optional EventBus for emitting storage.* events from todo/queue/task stores. */
  events?: import('@wrongstack/core/kernel').EventBus;
  /** Logger for structured storage warnings. */
  logger?: import('@wrongstack/core/types').Logger | undefined;
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
    claimSession,
    // Optional EventBus for storage observability
    events: eventsBus,
    logger: loggerParam,
  } = params;

  // Prune sessions older than the shared retention window on every interactive start.
  // Best-effort: failures here should not block the user.
  sessionStore
    .prune(DEFAULT_SESSION_PRUNE_DAYS)
    .then((count) => {
      if (count > 0) renderer.writeInfo(`Pruned ${count} old session${count === 1 ? '' : 's'}.`);
    })
    .catch((err) => console.debug(`[session] prune failed: ${err}`));

  // Sweep stale locks and orphaned worktrees left behind by previous crashes.
  if (projectRoot) {
    cleanOrphanLocks(projectRoot)
      .then((cleaned: import('@wrongstack/core/storage').OrphanLockCleanResult) => {
        if (cleaned.cleanedGitLocks.length > 0 || cleaned.cleanedWorktrees.length > 0) {
          renderer.writeInfo(
            `Cleaned up ${cleaned.cleanedGitLocks.length} stale lock(s) and ${cleaned.cleanedWorktrees.length} orphaned worktree lock(s).`,
          );
        }
      })
      .catch((err: unknown) => console.debug(`[session] cleanOrphanLocks failed: ${err}`));
  }

  let resumeId = typeof flags['resume'] === 'string' ? (flags['resume'] as string) : undefined;
  // `--resume` with no id, and `--recover`, are resolved here rather than by
  // the caller: both mean "pick a session for me", and the pick needs the
  // store and the live-session registry that only this phase holds.
  //
  //   --resume            -> the most recent session, closed or not
  //   --recover           -> the most recent session with NO trailing
  //                          `session_end` (crash, kill, closed lid)
  //
  // Both skip sessions another process is currently writing to; resuming one
  // of those would open a second writer on the same journal. `--no-recovery`
  // suppresses `--recover` so old launch scripts that pass both still start
  // fresh. A pick that finds nothing is not an error — the boot continues
  // with a new session, which is what the user would have got anyway.
  if (!resumeId) {
    const wantsLatest = flags['resume'] === true;
    const wantsRecover = flags['recover'] === true && flags['no-recovery'] !== true;
    if (wantsLatest || wantsRecover) {
      const picked = await pickResumeCandidate({
        sessionsDir: wpaths.projectSessions,
        globalRoot: wpaths.globalRoot,
        sessionStore,
        unclosedOnly: !wantsLatest,
      }).catch((err: unknown) => {
        console.debug(`[session] resume candidate lookup failed: ${toErrorMessage(err)}`);
        return undefined;
      });
      if (picked) {
        resumeId = picked;
      } else {
        renderer.writeInfo(
          wantsLatest
            ? 'No previous session to resume — starting a new one.'
            : 'No unclosed session to recover — starting a new one.',
        );
      }
    }
  }

  // Nothing to resume, but something to say: if the LAST thing this project
  // did was a session that never closed its log, tell the user it is still
  // there. Silence is what made a crash look like an ordinary fresh start —
  // the conversation was on disk the whole time and nothing ever mentioned it.
  //
  // A hint, not a prompt: it must not block a boot, and a stale hung session
  // from last week is not worth interrupting for, so only a recent one speaks
  // up. Fire-and-forget, exactly like the prune above.
  if (!resumeId && flags['no-recovery'] !== true) {
    void announceRecoverableSession({
      sessionsDir: wpaths.projectSessions,
      globalRoot: wpaths.globalRoot,
      onHint: (message) => renderer.writeInfo(message),
    }).catch(() => undefined);
  }

  let session: SessionWriter | undefined;
  let restoredMessages: import('@wrongstack/core/types').Message[] = [];
  let restoredToolCalls: SessionResult['restoredToolCalls'] = [];
  let restoredEvents: SessionResult['restoredEvents'] = [];
  let restoredSubagentsAllowed: boolean | undefined;
  let resumedModel: string | undefined;
  let resumedProvider: string | undefined;
  if (resumeId) {
    let claimHandle: SessionClaimHandle | undefined;
    try {
      if (sessionStore.resolveId) resumeId = await sessionStore.resolveId(resumeId);
      const claimed = await claimSession?.(resumeId);
      if (typeof claimed === 'function') {
        claimHandle = { rollback: claimed, activate: async () => {} };
      } else {
        claimHandle = claimed;
      }
      const resumed = await sessionStore.resume(resumeId);
      session = resumed.writer;
      await claimHandle?.activate();
      restoredMessages = resumed.data.messages;
      // Sessions written before tool_call_end events existed (or alternate
      // store impls) may not carry toolCallEnds — missing must not turn a
      // perfectly resumable session into RESUME_FAILED.
      restoredToolCalls = resumed.data.toolCallEnds ?? [];
      restoredEvents = resumed.data.events ?? [];
      restoredSubagentsAllowed = resumed.data.subagentsAllowed;
      // Prefer the resumed session's own model/provider on boot (applied later,
      // once the provider runtime + switch callback exist).
      resumedModel = resumed.data.metadata.model;
      resumedProvider = resumed.data.metadata.provider;
      if (resumed.data.usage) {
        tokenCounter.account(resumed.data.usage, resumedModel, resumedProvider);
      }
      renderer.writeInfo(
        `Resumed session ${resumed.data.metadata.id} — ${restoredMessages.length} messages, ${restoredToolCalls.length} tool executions, ${resumed.data.usage.input + resumed.data.usage.output} tokens used previously.`,
      );
    } catch (err) {
      await claimHandle?.rollback().catch(() => undefined);
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
  // The LAST request's prompt, not the session's running total. This used to
  // read `SessionData.usage.input` — the sum of every request the session ever
  // made — so booting `--resume` on a long conversation opened the statusline
  // at several times the window size. The journal's last `llm_response` is the
  // only per-request measurement on disk; the cumulative figure stays where it
  // belongs, in `tokenCounter.account` above.
  const resumedRequestTokens = projectLastRequestTokens(restoredEvents);
  if (resumedRequestTokens !== undefined) {
    context.lastRequestTokens = resumedRequestTokens;
  }
  // Inject package-author-tracker options so the install tool can record authorship.
  context.meta['packageTrackerOpts'] = {
    storageDir: wpaths.projectDir,
    projectRoot,
  };
  // Per-provider prompt-cache ledger — powers the /context per-provider cache
  // breakdown once a session spans more than one provider (fallback / model
  // switch). Subscribes to token.accounted; harmless when single-provider.
  // disposed via the detachTodosCheckpoint chain on session shutdown.
  let cacheLedger: ProviderCacheLedger | undefined;
  if (eventsBus) {
    cacheLedger = new ProviderCacheLedger(eventsBus);
    context.meta['providerCacheLedger'] = cacheLedger;
  }
  if (restoredMessages.length > 0) {
    // This snapshot is also the migration boundary for legacy transcripts:
    // after it, incremental message_* events can be authoritative without
    // discarding messages written before the exact journal existed.
    context.state.replaceMessages(restoredMessages);
    await context.flushConversationJournal();
  }
  if (restoredEvents.length > 0 || restoredSubagentsAllowed !== undefined) {
    restoreSessionSubagentPolicy(context, restoredEvents, restoredSubagentsAllowed);
  } else seedSessionSubagentPolicy(context);

  const queueStore = new QueueStore({
    dir: sessionDir,
    ...(eventsBus ? { events: eventsBus } : {}),
    ...(traceId ? { traceId } : {}),
    ...(loggerParam ? { logger: loggerParam } : {}),
  });

  const todosCheckpointPath = sessionScopedPath(wpaths.projectSessions, sessionId, '.todos.json');
  if (resumeId) {
    try {
      const restoredTodos = await loadTodosCheckpoint(
        todosCheckpointPath,
        eventsBus,
        traceId,
        sessionId,
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
  const checkpointWarning = loggerParam ? (msg: string) => loggerParam.warn(msg) : undefined;
  let checkpointSessionId = sessionId;
  let checkpointSessionsDir = wpaths.projectSessions;
  const attachCheckpoint = (targetSessionId: string, sessionsDir: string) =>
    attachTodosCheckpoint(
      context.state,
      sessionScopedPath(sessionsDir, targetSessionId, '.todos.json'),
      targetSessionId,
      eventsBus,
      traceId,
      checkpointWarning,
    );
  let detachTodosCheckpointOnly = attachCheckpoint(sessionId, checkpointSessionsDir);
  let checkpointAttached = true;
  const detachCurrentCheckpoint = async (): Promise<void> => {
    if (!checkpointAttached) return;
    checkpointAttached = false;
    await detachTodosCheckpointOnly();
  };
  let checkpointRebindTail = Promise.resolve();
  const rebindTodosCheckpoint = (
    nextSessionId: string,
    sessionsDir = wpaths.projectSessions,
  ): Promise<void> => {
    const transition = checkpointRebindTail.then(async () => {
      if (
        checkpointAttached &&
        nextSessionId === checkpointSessionId &&
        sessionsDir === checkpointSessionsDir
      ) {
        return;
      }
      await detachCurrentCheckpoint();
      checkpointSessionId = nextSessionId;
      checkpointSessionsDir = sessionsDir;
      detachTodosCheckpointOnly = attachCheckpoint(nextSessionId, sessionsDir);
      checkpointAttached = true;
    });
    checkpointRebindTail = transition.catch(() => undefined);
    return transition;
  };

  const planPath = sessionScopedPath(wpaths.projectSessions, sessionId, '.plan.json');
  context.state.setMeta('plan.path', planPath);

  const taskPath = sessionScopedPath(wpaths.projectSessions, sessionId, '.tasks.json');
  context.state.setMeta('task.path', taskPath);

  // A session is born with its Kanban board. The binding observes every todo
  // replacement and both plan/task sidecars, including mutations made from
  // slash commands, WebUI, TUI, plugins, and tools.
  await hydrateSessionKanban(context);
  // Never fatal — see `hydrateSessionKanban`. Say so once instead of letting
  // the board silently not sync, and name the command that explains why.
  const kanbanDown = sessionKanbanDegradation();
  if (kanbanDown) {
    // Through the renderer, not raw stderr: surfaces that capture CLI output
    // (ACP, WebUI) must see this the way they see every other notice.
    renderer.writeInfo(
      `Kanban board sync unavailable — continuing without it (${kanbanDown}). ` +
        'Run `wstack doctor --daemons` for detail.',
    );
  }
  const detachSessionKanbanMirror = attachSessionKanbanMirror(context);
  const detachTodosCheckpoint = async () => {
    detachSessionKanbanMirror();
    cacheLedger?.dispose();
    await checkpointRebindTail;
    await detachCurrentCheckpoint();
  };

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
        const spawnPart =
          typeof dirState.maxSpawns === 'number' && Number.isFinite(dirState.maxSpawns)
            ? `, spawns ${dirState.spawnCount}/${dirState.maxSpawns} (checkpoint ceiling; live profile may differ)`
            : `, spawns used ${dirState.spawnCount}`;
        renderer.writeInfo(
          `Prior fleet state: ${dirState.subagents.length} subagent${dirState.subagents.length === 1 ? '' : 's'}, tasks ${summary || '(none)'}${spawnPart}.`,
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
    queueStore,
    planPath,
    detachTodosCheckpoint,
    rebindTodosCheckpoint,
    priorFleetState: dirState ?? undefined,
    restoredToolCalls,
    restoredEvents,
    resumedModel,
    resumedProvider,
  };
}

// Future (Phase 1+): when emitting richer audit events, resolve via:
// const auditLevel = resolveAuditLevel(fullConfig);
// const bridge = createSessionEventBridge(sessionWriter, auditLevel);
// Prefer passing the bridge instead of raw writer for new audit writes.
