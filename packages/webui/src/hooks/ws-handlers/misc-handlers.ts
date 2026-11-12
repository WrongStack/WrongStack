import { projectRefineResult } from '@wrongstack/core/execution/refine-decisions';
import { toast } from '@/components/Toaster';
import { reconcileFileTabsAfterEnvChange } from '@/hooks/ws-handlers/files-mailbox-handlers';
import { normalizedEqual } from '@/lib/core-browser-shim';
import { getWSClient } from '@/lib/ws-client';
import { chatFor, messageSessionId } from '@/lib/ws-client-utils';
import {
  useChimeraReportsStore,
  useCronStore,
  useFileStore,
  useGitChangesStore,
  useGitInfoStore,
  useGoalStateStore,
  useSessionStore,
  useUIStore,
  useVizStore,
} from '@/stores';
import {
  activeChatLane,
  chatLane,
  DEFAULT_LANE_ID,
  resolvePendingConfirm,
} from '@/stores/chat-lanes';
import { useLocalPrefs } from '@/stores/local-prefs';
import { useMemoryInjectorTraceStore } from '@/stores/memory-injector-store';
import { useMemoryLifecycleStore } from '@/stores/memory-lifecycle-store';
import { useSystemPromptStore } from '@/stores/system-prompt-store';
import type { WSServerMessage } from '@/types';
import type { GitImageDiff, WSSystemPromptInfo } from '@/types/server-message';
import { handleBrainAnswer, handleBrainEvent } from './brain-handlers.js';
import {
  handleGoalLifecycle,
  handleGoalList,
  handleGoalProgress,
  handleGoalRefining,
  handleGoalState,
  handleGoalStateError,
  handleGoalUpdated,
} from './goal-handlers.js';

export function handlePrefsUpdated(msg: WSServerMessage) {
  const p = msg.payload as Record<string, unknown>;
  const sessionId = messageSessionId(msg);
  // Session-scoped keys (autonomy, yolo, context strategy, reasoning…) are
  // filed against the tab they belong to. Applying every snapshot to one
  // global store is how tab 2 turning on YOLO flipped the switch tab 1 was
  // looking at — and, worse, dismissed tab 1's open confirm below.
  useLocalPrefs.getState().applyRemote(p as never, sessionId ?? undefined);

  if (p['yolo'] !== true) return;
  // Only the tab in front owns the visible confirm modal.
  if (sessionId && sessionId !== useLocalPrefs.getState().activeSessionId) return;
  const confirm = useUIStore.getState().confirmInfo;
  const destructive =
    confirm?.riskTier === 'destructive' || confirm?.decisionSource === 'yolo_destructive';
  if (confirm && !confirm.boundaryReason && !destructive) {
    // The server auto-approves everything pending when YOLO goes on; drop the
    // parked copy so it cannot re-open on the next tab switch.
    resolvePendingConfirm(confirm.id);
    useUIStore.getState().hideConfirm();
  }
}

export function handleSystemPromptInfo(msg: WSServerMessage) {
  const payload = msg.payload as WSSystemPromptInfo & { sessionId?: string };
  if (!payload || !Array.isArray(payload.variants)) return;
  // The variant is per tab; the catalogue is not. Record `current` against the
  // session that answered so the picker in tab 3 stops reporting tab 1's size.
  useSystemPromptStore.getState().setInfo(payload, payload.sessionId);
}

export function handleMemoryEvent(msg: WSServerMessage) {
  // Addressed, not gated. These traces describe ONE conversation's prompt and
  // each tab keeps its own; dropping a background tab's meant opening that tab
  // showed an empty injector panel for injections that had really happened.
  const memoryTrace = useMemoryInjectorTraceStore.for(messageSessionId(msg));
  const lifecycle = useMemoryLifecycleStore.for(messageSessionId(msg));
  const payload = msg.payload as Record<string, unknown> & { event: string };
  useVizStore.getState().pushEvent({
    id: `memory_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    kind: 'memory:event',
    timestamp: Date.now(),
    source: 'sage',
    target: 'leader',
    label: payload.event.replace(/^memory\./, ''),
    data: payload,
    color: '#a78bfa',
    flowGroup: 'memory',
  });
  if (payload.event === 'memory.injector_run') {
    memoryTrace
      .getState()
      .pushTrace(
        payload as unknown as import('@/stores/memory-injector-store').MemoryInjectorTrace,
      );
  }
  if (payload.event === 'memory.companion_review') {
    memoryTrace
      .getState()
      .pushCompanionReview(
        payload as unknown as import('@/stores/memory-injector-store').CompanionReview,
      );
  }
  if (payload.event === 'memory.context_snapshot') {
    memoryTrace
      .getState()
      .applyContextSnapshot(
        payload as unknown as import('@/stores/memory-injector-store').MemoryContextSnapshot,
      );
  }
  lifecycle.getState().pushEvent(payload);
  if (payload.event === 'memory.staled')
    toast.warn(`Memory became stale: ${String(payload['memoryId'] ?? '')}`);
  else if (payload.event === 'memory.contradicted')
    toast.warn(`Memory contradicted: ${String(payload['memoryId'] ?? '')}`);
  else if (payload.event === 'memory.hygiene_completed') toast.info('SAGE hygiene completed');
}

export function handleCollabEvent(msg: WSServerMessage) {
  const p = msg.payload as Record<string, unknown>;
  const label =
    typeof p.kind === 'string' ? p.kind : typeof p.event === 'string' ? p.event : 'collab.event';
  useVizStore.getState().pushEvent({
    id: `collab_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    kind: 'collab:event',
    timestamp: Date.now(),
    source: 'collab',
    target: typeof p.sessionId === 'string' ? p.sessionId : 'session',
    label,
    magnitude: 1,
    data: p,
    raw: msg.payload,
    color: 'hsl(200, 70%, 55%)',
    flowGroup: 'collab',
  });
  useVizStore.getState().setActive(true);
}

export function handleCollabInjectionGranted(msg: WSServerMessage) {
  handleCollabEvent(msg);
  const p = msg.payload as { phase?: string; toolName?: string } | undefined;
  if (p?.phase === 'consumed') {
    toast.success(`Tool injection applied${p.toolName ? ` to ${p.toolName}` : ''}`);
  } else {
    toast.info('Collab tool injection queued');
  }
}

export function handleEternalIteration(msg: WSServerMessage) {
  const payload = msg.payload as { entry?: Record<string, unknown> } | undefined;
  const entry = payload?.entry;
  if (!entry) return;
  const iteration = typeof entry.iteration === 'number' ? entry.iteration : 0;
  const task = typeof entry.task === 'string' ? entry.task : undefined;
  const status = typeof entry.status === 'string' ? entry.status : undefined;
  const timestamp = typeof entry.at === 'string' ? entry.at : new Date().toISOString();

  useGoalStateStore.getState().appendJournalEntry({
    iteration,
    task,
    status,
    timestamp,
  });
  useVizStore.getState().pushEvent({
    id: `eternal_${Date.now()}_${iteration}`,
    kind: 'eternal:iteration',
    timestamp: Date.now(),
    source: 'eternal',
    target: 'goal',
    label: task ? `L${iteration}: ${task}` : `Eternal iteration ${iteration}`,
    magnitude: typeof entry.costUsd === 'number' ? entry.costUsd : 1,
    data: entry,
    raw: msg.payload,
    color: status === 'failure' ? 'hsl(0, 80%, 55%)' : 'hsl(220, 80%, 60%)',
    flowGroup: 'eternal',
  });
  useVizStore.getState().setActive(true);
}

export function handleWorkingDirChanged(msg: WSServerMessage) {
  const p = msg.payload as { cwd: string; projectRoot: string };
  const sessionId = messageSessionId(msg);
  useSessionStore.getState().setEnv({
    cwd: p.cwd,
    projectRoot: p.projectRoot,
    projectName: p.projectRoot.split(/[/\\]/).pop() || p.projectRoot,
  });
  useFileStore.getState().setTreeLoading(true, sessionId);
  // Rehydrated tabs are path-only stubs; re-fetch their content from disk,
  // or drop them entirely when the server moved to a different project.
  reconcileFileTabsAfterEnvChange(p.projectRoot, sessionId);
  const ws = getWSClient();
  ws.send({
    type: 'files.tree',
    payload: sessionId ? { path: p.cwd, sessionId } : { path: p.cwd },
  });
}

export function handleModelRefineResult(msg: WSServerMessage) {
  const p = msg.payload as {
    refined: string;
    english: string;
    error?: string | undefined;
    errorKind?: 'timeout' | 'empty' | 'provider_error' | undefined;
    retryTimeoutMs?: number | undefined;
    fallbackRef?: string | undefined;
    refinedWith?: { provider: string; model: string } | undefined;
  };
  const refinePanel = useUIStore.getState().refinePanel;
  const origin = messageSessionId(msg) ?? refinePanel?.sessionId ?? null;
  // The tab that asked, not the tab in front: a background refine used to
  // enqueue its result into whichever composer happened to be on screen.
  // `chatFor` IS the routing contract: tagged → that session's lane,
  // untagged → the pre-session default lane, untagged-while-bound → dropped
  // (the server stamps every bound-session reply, so untagged here is a
  // server regression and must not guess a lane). Resolving untagged to
  // `null` instead killed the pre-session pre-queue path entirely.
  const chat = chatFor(msg) ?? (origin ? chatLane(origin) : null);
  const pendingRef = chat?.pendingRefinement ?? null;
  if (refinePanel?.sessionId && origin && refinePanel.sessionId !== origin) return;
  // A panel that names a session must never drain into the lane in front
  // when its result frame lost its stamp — that fallback is the cross-tab
  // leak this handler exists to prevent.
  if (refinePanel?.sessionId && !chat) return;

  // Pre-queue refinement path: ChatInput offered refinement before enqueuing.
  if (!refinePanel && pendingRef && chat) {
    chat.setRefining(false);
    const original = pendingRef.text;
    // Carry images from the refinement request so they aren't dropped when
    // the message is enqueued. pendingRef.images uses { data, mime } format;
    // convert to QueuedItem['images'] format for the queue.
    const refImages = pendingRef.images?.length
      ? pendingRef.images.map((img, i) => ({
          id: `pr_${Date.now()}_${i}`,
          dataUrl: `data:${img.mime};base64,${img.data}`,
          mediaType: img.mime,
          bytes: Math.round((img.data.length * 3) / 4),
        }))
      : undefined;

    // Degrade btw→queue when images are present: sendMailboxMessage (the btw
    // drain) carries only a string body — no image channel — so preserving
    // btw would silently drop image attachments.
    const hasImages = !!refImages && refImages.length > 0;
    const failMode =
      hasImages && pendingRef.mode === 'btw' ? 'queue' : (pendingRef.mode ?? 'queue');

    if (p.error) {
      // Refinement failed — enqueue original as-is with images.
      chat.setPendingRefinement(null);
      chat.enqueue(original, failMode, refImages);
      return;
    }

    const refined = p.refined ?? '';
    if (!refined || normalizedEqual(refined, original)) {
      // No-op refinement — enqueue original with images.
      chat.setPendingRefinement(null);
      chat.enqueue(original, failMode, refImages);
      return;
    }

    // Show the RefinePanel for user approval.
    // The resolve callback is a no-op here — the pre-queue path constructs
    // the panel from scratch (no prior panel to spread from), and decisions
    // are handled by the onDecision prop on the <RefinePanel> component
    // rather than through the store's resolve slot.
    chat.setPendingRefinement(null);
    useUIStore.getState().setRefinePanel({
      original,
      refined,
      english: p.english || refined,
      status: 'ready',
      // Preserve the submit mode so the approval path (RefinePanelHost
      // handleDecision) can dispatch via it instead of degrading to a plain
      // normal send — e.g. a mid-run `btw` stays a `btw`. Degrade to 'queue'
      // when images are present: sendMailboxMessage carries no image channel.
      mode:
        refImages && refImages.length > 0 && pendingRef.mode === 'btw' ? 'queue' : pendingRef.mode,
      // Carry images so the approval enqueue path can forward them — mirrors
      // the error/no-op branches above that pass refImages to enqueue.
      images: refImages,
      ...(p.refinedWith ? { provider: p.refinedWith.provider, model: p.refinedWith.model } : {}),
      error: undefined,
      errorKind: undefined,
      // The tab this prompt was typed in. Approving the panel — or letting it
      // time out — sends through the foreground, so an unstamped panel can
      // deliver one tab's prompt into another tab's session.
      sessionId: chat.sessionId,
      resolve: () => {},
    });
    return;
  }

  if (!refinePanel) return;
  // The shared projection (also used by the TUI) decides
  // what the reply means: one silent timeout retry, failure recovery, an
  // original-send for a no-op refinement, or the ready comparison panel.
  const projection = projectRefineResult(p, {
    original: refinePanel.original,
    retried: refinePanel.retried,
  });
  if (projection.action === 'retry') {
    // Auto-retry ONCE on a timeout with the server-suggested longer window —
    // the model was reachable, just slow. Everything else (or a second
    // timeout) surfaces the recovery panel so the user decides.
    useUIStore.getState().setRefinePanel({
      ...refinePanel,
      status: 'refining',
      retried: true,
    });
    getWSClient().refineModel(refinePanel.original, { timeoutMs: projection.timeoutMs });
    return;
  }
  if (projection.action === 'failed') {
    // Surface the failure with recovery options instead of silently sending
    // the original — the user can retry, switch model, edit, or send as-is.
    useUIStore.getState().setRefinePanel({
      ...refinePanel,
      status: 'failed',
      error: projection.error,
      errorKind: projection.errorKind,
      fallbackRef: projection.fallbackRef,
    });
    return;
  }
  const original = refinePanel.original;
  if (projection.action === 'noop-send') {
    useUIStore.getState().setRefinePanel(null);
    const target = chat ?? activeChatLane();
    target.addMessage({ role: 'user', content: original });
    target.setLoading(true);
    // The lane sentinel ('__unbound__') is not a session id — sending it as
    // one would have the server refuse the frame as an unknown session.
    const laneSession = target.sessionId !== DEFAULT_LANE_ID ? target.sessionId : undefined;
    getWSClient().sendMessage(original, undefined, false, laneSession);
    return;
  }
  useUIStore.getState().setRefinePanel({
    ...refinePanel,
    status: 'ready',
    refined: projection.refined,
    english: projection.english,
    ...(p.refinedWith ? { provider: p.refinedWith.provider, model: p.refinedWith.model } : {}),
    // Clear any stale failure state from a prior retry round.
    error: undefined,
    errorKind: undefined,
  });
}

export function handleGitInfo(msg: WSServerMessage) {
  const p = msg.payload as {
    branch: string;
    added: number;
    deleted: number;
    untracked: number;
    behind: number;
    ahead: number;
  };
  useGitInfoStore.getState().setInfo({ ...p, fetchedAt: Date.now() });
}

export function handleGitChanges(msg: WSServerMessage) {
  const p = msg.payload as {
    files: Array<{ path: string; status: string; added: number; deleted: number; staged: boolean }>;
    dirs?: Record<string, string> | undefined;
    repoPrefix?: string | undefined;
    error?: string | undefined;
  };
  useGitChangesStore
    .getState()
    .setFiles(p.files ?? [], p.error ?? null, p.repoPrefix ?? '', p.dirs ?? {});
}

export function handleGitDiff(msg: WSServerMessage) {
  const p = msg.payload as {
    path: string;
    oldText?: string | undefined;
    newText?: string | undefined;
    binary?: boolean | undefined;
    tooLarge?: boolean | undefined;
    error?: string | undefined;
    image?: GitImageDiff | undefined;
  };
  if (useGitChangesStore.getState().selectedPath !== p.path) return;
  useGitChangesStore.getState().setDiff({
    path: p.path,
    oldText: p.oldText ?? '',
    newText: p.newText ?? '',
    binary: p.binary,
    tooLarge: p.tooLarge,
    error: p.error,
    ...(p.image && (p.image.old || p.image.new) ? { image: p.image } : {}),
  });
}

export function handleGitActionResult(msg: WSServerMessage) {
  const p = msg.payload as {
    action: 'stage' | 'unstage' | 'discard' | 'commit';
    ok: boolean;
    error?: string | undefined;
  };
  if (!p.ok) {
    toast.error(p.error ?? `Git ${p.action} failed`);
    return;
  }

  const client = getWSClient();
  client.getGitChanges();
  client.getGitInfo();
}

// ── Cron event handlers ─────────────────────────────────────────────────

export function handleCronSnapshot(msg: WSServerMessage) {
  const p = msg.payload as {
    count: number;
    maxConcurrent: number;
    jobs: Array<{
      name: string;
      intervalMs: number;
      action: string;
      enabled: boolean;
      lastRun: string | null;
      nextRun: string;
      runCount: number;
      overdue: boolean;
    }>;
  };
  useCronStore.getState().setSnapshot({
    count: p.count,
    maxConcurrent: p.maxConcurrent,
    jobs: p.jobs ?? [],
  });
}

export function handleCronJobFired(msg: WSServerMessage) {
  const p = msg.payload as { name: string; action: string; runCount: number; ts: string };
  useCronStore.getState().recordFired(p.name, p.ts);
}

export function handleChimeraReportAvailable(msg: WSServerMessage) {
  const p = msg.payload as {
    reportId?: string | undefined;
    message?: string | undefined;
    findingCount?: number | undefined;
    fileCount?: number | undefined;
    hasActionableFindings?: boolean | undefined;
  };
  toast.info(
    p.message ?? '🦂 Chimera report ready. No follow-up started; open the mailbox to inspect it.',
    8_000,
  );

  // Registry first — it survives lane churn and dedupes against hydration.
  const sessionId = messageSessionId(msg);
  if (!p.reportId || !sessionId) return;
  const recorded = useChimeraReportsStore.getState().recordReport({
    reportId: p.reportId,
    sessionId,
    message: p.message ?? '',
    findingCount: p.findingCount ?? 0,
    fileCount: p.fileCount ?? 0,
    hasActionableFindings: p.hasActionableFindings === true,
    receivedAt: Date.now(),
    actionedAt: null,
    source: 'event',
  });
  // Only findings that ask the leader for action get a transcript card; the
  // toast above already covered the information-only reports.
  if (!recorded || p.hasActionableFindings !== true) return;

  // Surface IN the session's own transcript, not just as a transient toast:
  // the card lands in that session's lane (foreground or background) and
  // carries the one-click "send the leader to work" affordance rendered by
  // ChimeraReportCard. Positive routing via chatFor — never the foreground.
  chatFor(msg)?.addMessage({
    role: 'system',
    content: p.message ?? `🦂 Chimera report ${p.reportId} is ready — findings await review.`,
    chimeraReport: { reportId: p.reportId, actionable: true, actionedAt: null },
  });
}

/**
 * Server answered `chimera.reports.list` — merge the session's persisted
 * report list into the registry that feeds the Chimera panel and the reviews
 * view.
 *
 * Deliberately writes NO transcript cards. This request fires whenever a tab
 * becomes active, so on every resume and every tab switch it re-materialized
 * review cards into a conversation that was replayed from the journal without
 * them — the resumed session read as a wall of Chimera notices that were never
 * part of it. Worse, it raced the replay it accompanied: the report list comes
 * back in milliseconds while a large journal takes seconds, so the cards were
 * either wiped by the transcript landing on top of them or (when the replay
 * was discarded) the only thing left on screen.
 *
 * A report that arrives while the session is open still gets its card, from
 * `handleChimeraReportAvailable` — that one is an event about THIS run and
 * belongs in the transcript where it happened. Everything else is history, and
 * history has a panel.
 */
export function handleChimeraReports(msg: WSServerMessage) {
  const sessionId = messageSessionId(msg);
  if (!sessionId) return;
  const p = msg.payload as {
    reports?:
      | Array<{
          reportId: string;
          reviewedAt: string;
          lifecycleStatus: string;
          totalFindings: number;
          fileCount?: number | undefined;
          hasActionableFindings: boolean;
        }>
      | undefined;
  };
  const reports = p.reports ?? [];
  useChimeraReportsStore.getState().hydrateReports(
    sessionId,
    reports
      .filter(
        (r) =>
          r.reportId &&
          r.totalFindings > 0 &&
          r.lifecycleStatus !== 'completed' &&
          r.lifecycleStatus !== 'skipped',
      )
      .map((r) => {
        const reviewedAt = Date.parse(r.reviewedAt);
        return {
          reportId: r.reportId,
          sessionId,
          message: `🦂 Chimera report ready — ${r.totalFindings} finding(s) recorded for this session.`,
          findingCount: r.totalFindings,
          fileCount: typeof r.fileCount === 'number' ? r.fileCount : 0,
          hasActionableFindings: r.hasActionableFindings === true,
          receivedAt: Number.isFinite(reviewedAt) ? reviewedAt : Date.now(),
          actionedAt: null,
          source: 'hydrate' as const,
        };
      }),
  );
}

export const miscHandlerMap: Partial<Record<string, (msg: WSServerMessage) => void>> = {
  'goal-state.updated': handleGoalUpdated,
  'goal-state.refining': handleGoalRefining,
  'goal-state.error': handleGoalStateError,
  'prefs.updated': handlePrefsUpdated,
  'system_prompt.info': handleSystemPromptInfo,
  'goal.state': handleGoalState,
  'goal.progress': handleGoalProgress,
  'goal.paused': handleGoalLifecycle,
  'goal.resumed': handleGoalLifecycle,
  'goal.stopped': handleGoalLifecycle,
  'goal.cleared': handleGoalLifecycle,
  'goal.reverted': handleGoalLifecycle,
  'goal.saved': handleGoalLifecycle,
  'goal.completed': handleGoalLifecycle,
  'goal.failed': handleGoalLifecycle,
  'goal.error': handleGoalLifecycle,
  'goal.list': handleGoalList,
  // brain.status is NOT added to chat — the BrainSection component
  // renders this information natively in the settings panel.
  'brain.answer': handleBrainAnswer,
  'brain.event': handleBrainEvent,
  'memory.event': handleMemoryEvent,
  'collab.event': handleCollabEvent,
  'collab.injection.granted': handleCollabInjectionGranted,
  'eternal.iteration': handleEternalIteration,
  'working_dir.changed': handleWorkingDirChanged,
  'model.refine_result': handleModelRefineResult,
  'git.info': handleGitInfo,
  'git.changes': handleGitChanges,
  'git.diff': handleGitDiff,
  'git.action_result': handleGitActionResult,
  'cron.snapshot': handleCronSnapshot,
  'cron.job_fired': handleCronJobFired,
  'chimera.report_available': handleChimeraReportAvailable,
  'chimera.reports': handleChimeraReports,
};
export { handleBrainAnswer, handleBrainEvent, handleBrainStatus } from './brain-handlers.js';
export {
  handleGoalLifecycle,
  handleGoalList,
  handleGoalProgress,
  handleGoalState,
  handleGoalUpdated,
} from './goal-handlers.js';
