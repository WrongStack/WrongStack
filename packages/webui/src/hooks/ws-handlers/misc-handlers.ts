import type { PhaseItem } from '@/components/PhasePanel';
import { toast } from '@/components/Toaster';
import { reconcileFileTabsAfterEnvChange } from '@/hooks/ws-handlers/files-mailbox-handlers';
import { normalizedEqual } from '@/lib/core-browser-shim';
import { getWSClient } from '@/lib/ws-client';
import { chatFor, messageSessionId } from '@/lib/ws-client-utils';
import {
  type BrainDecisionData,
  type CouncilDecisionData,
  useChimeraReportsStore,
  useCouncilLogStore,
  useCronStore,
  useFileStore,
  useGitChangesStore,
  useGitInfoStore,
  useGoalRunStore,
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
import type { WSSystemPromptInfo } from '@/types/server-message';

/**
 * The Brain council log of the conversation a frame names.
 *
 * Council panels are per conversation, so the write has to be addressed: the
 * store's foreground `getState()` would put a background tab's panel on the
 * screen the user is looking at.
 */
function councilLogFor(msg: WSServerMessage) {
  return useCouncilLogStore.for(messageSessionId(msg)).getState();
}

function deriveGoalRunStatus(
  phases: PhaseItem[] | undefined,
): 'running' | 'paused' | 'completed' | 'failed' | undefined {
  if (!phases || phases.length === 0) return undefined;
  const statuses = phases.map((p) => (p as unknown as { status?: string }).status);
  if (statuses.some((s) => s === 'failed')) return 'failed';
  if (statuses.every((s) => s === 'completed' || s === 'skipped')) return 'completed';
  if (statuses.some((s) => s === 'paused')) return 'paused';
  return 'running';
}

export function handleGoalState(msg: WSServerMessage) {
  const p = msg.payload as Record<string, unknown>;
  const phases = Array.isArray(p.phases) ? (p.phases as PhaseItem[]) : undefined;
  const status = deriveGoalRunStatus(phases);
  useGoalRunStore.getState().setState({
    phases,
    activePhaseId: typeof p.activePhaseId === 'string' ? p.activePhaseId : undefined,
    overallPercent: typeof p.overallPercent === 'number' ? p.overallPercent : undefined,
    autonomous: typeof p.autonomous === 'boolean' ? p.autonomous : undefined,
    title: typeof p.title === 'string' ? p.title : undefined,
    goal: typeof p.goal === 'string' ? p.goal : undefined,
    status,
    multiBoard: p.multiBoard === true,
    lastError: status === 'failed' ? useGoalRunStore.getState().lastError : null,
  });
}

export function handleGoalProgress(msg: WSServerMessage) {
  const p = msg.payload as Record<string, unknown>;
  const progress = {
    totalPhases: typeof p.totalPhases === 'number' ? p.totalPhases : 0,
    completed: typeof p.completed === 'number' ? p.completed : 0,
    failed: typeof p.failed === 'number' ? p.failed : 0,
    totalTasks: typeof p.totalTasks === 'number' ? p.totalTasks : 0,
    completedTasks: typeof p.completedTasks === 'number' ? p.completedTasks : 0,
    failedTasks: typeof p.failedTasks === 'number' ? p.failedTasks : 0,
  };
  useGoalRunStore.getState().setState({
    progress,
    overallPercent:
      typeof p.percentComplete === 'number' ? Math.round(p.percentComplete) : undefined,
    status: progress.failed > 0 || progress.failedTasks > 0 ? 'failed' : 'running',
    lastEvent: 'progress',
  });
}

export function handleGoalLifecycle(msg: WSServerMessage) {
  const p = msg.payload as Record<string, unknown>;
  const title = typeof p.title === 'string' && p.title ? p.title : 'Goal';
  const error = typeof p.error === 'string' && p.error ? p.error : undefined;

  if (msg.type === 'goal.paused') {
    useGoalRunStore
      .getState()
      .setState({ status: 'paused', autonomous: false, lastEvent: 'paused' });
    toast.info('Goal paused');
    return;
  }
  if (msg.type === 'goal.resumed') {
    useGoalRunStore
      .getState()
      .setState({ status: 'running', autonomous: true, lastEvent: 'resumed' });
    toast.info('Goal resumed');
    return;
  }
  if (msg.type === 'goal.stopped') {
    useGoalRunStore
      .getState()
      .setState({ status: 'stopped', autonomous: false, lastEvent: 'stopped' });
    toast.warn('Goal stopped');
    return;
  }
  if (msg.type === 'goal.cleared') {
    // Reset to an empty board → the view falls back to the goal-entry screen.
    useGoalRunStore.getState().clear();
    return;
  }
  if (msg.type === 'goal.reverted') {
    const ok = (p as { ok?: boolean }).ok === true;
    const reverted = typeof p.reverted === 'number' ? p.reverted : 0;
    const reason = typeof p.reason === 'string' ? p.reason : undefined;
    if (ok) {
      toast.success(
        reverted > 0
          ? `Reverted ${reverted} commit${reverted === 1 ? '' : 's'}`
          : 'Nothing to revert',
      );
    } else {
      toast.error(`Revert failed: ${reason ?? 'unknown error'}`);
    }
    useGoalRunStore.getState().setState({ lastEvent: 'reverted' });
    return;
  }
  if (msg.type === 'goal.saved') {
    useGoalRunStore.getState().setState({ lastEvent: 'saved' });
    toast.success('Goal graph saved');
    return;
  }
  if (msg.type === 'goal.completed') {
    useGoalRunStore.getState().setState({
      status: 'completed',
      autonomous: false,
      overallPercent: 100,
      lastEvent: 'completed',
      lastError: null,
    });
    toast.success(`${title} completed`);
    return;
  }
  if (msg.type === 'goal.failed' || msg.type === 'goal.error') {
    const message = error ?? (typeof p.message === 'string' ? p.message : `${title} failed`);
    useGoalRunStore
      .getState()
      .setState({ status: 'failed', autonomous: false, lastEvent: 'failed', lastError: message });
    toast.error(message);
  }
}

export function handleGoalList(msg: WSServerMessage) {
  const p = msg.payload as {
    graphs?: Array<{ id: string; title: string; updatedAt: number; status: string }> | undefined;
  };
  useGoalRunStore.getState().setState({
    lastEvent: 'list',
    graphs: Array.isArray(p.graphs) ? p.graphs : [],
  });
}

export function handleGoalUpdated(msg: WSServerMessage) {
  const p = msg.payload as Record<string, unknown> | null;
  useGoalStateStore.getState().setGoal(p);
}

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
  if (confirm) {
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

export function handleBrainStatus(msg: WSServerMessage) {
  // `brain.*` is fail-OPEN: the arbiter is global and legitimately emits
  // untagged, which belongs to whoever is in front. A TAGGED one lands in its
  // own lane — including a background tab's, which an `isActiveSessionMessage`
  // gate here used to throw away after the router had already addressed it.
  const chat = chatFor(msg) ?? activeChatLane();
  const p = msg.payload as {
    maxAutoRisk: string;
    log: Array<{ at: number; kind: string; question: string; outcome: string }>;
  };
  const lines = [
    '🧠 **Brain** — policy → LLM decision chain',
    '',
    `Autonomy ceiling: \`${p.maxAutoRisk}\` _(change with \`/brain risk <off|low|medium|high|all>\`)_`,
  ];
  if (p.log.length === 0) {
    lines.push('', '_No decisions recorded yet this session._');
  } else {
    lines.push('', `Recent decisions (${p.log.length}):`);
    for (const entry of p.log.slice(-10)) {
      const ago = Math.max(0, Math.round((Date.now() - entry.at) / 1000));
      const age =
        ago < 60
          ? `${ago}s`
          : ago < 3600
            ? `${Math.round(ago / 60)}m`
            : `${Math.round(ago / 3600)}h`;
      const q = entry.question.length > 70 ? `${entry.question.slice(0, 67)}…` : entry.question;
      lines.push(
        `- \`${age} ago\` **${entry.kind}** — ${q}${entry.outcome ? ` → _${entry.outcome}_` : ''}`,
      );
    }
  }
  chat.addMessage({ role: 'assistant', content: lines.join('\n') });
}

export function handleBrainAnswer(msg: WSServerMessage) {
  // `brain.*` is fail-OPEN: the arbiter is global and legitimately emits
  // untagged, which belongs to whoever is in front. A TAGGED one lands in its
  // own lane — including a background tab's, which an `isActiveSessionMessage`
  // gate here used to throw away after the router had already addressed it.
  const chat = chatFor(msg) ?? activeChatLane();
  const p = msg.payload as {
    question: string;
    decision: {
      type: string;
      text?: string;
      rationale?: string;
      reason?: string;
      optionId?: string;
    };
  };
  let content: string;
  if (p.decision.type === 'answer') {
    const rationale =
      p.decision.rationale && p.decision.rationale !== p.decision.text
        ? `\n\n_${p.decision.rationale}_`
        : '';
    content = `🧠 ${p.decision.text ?? ''}${rationale}`;
  } else if (p.decision.type === 'deny') {
    content = `🧠 Denied: ${p.decision.reason ?? ''}`;
  } else {
    content = '🧠 The Brain escalated this question back to you — it needs human judgement.';
  }
  const brainDecision: BrainDecisionData = {
    kind:
      p.decision.type === 'answer'
        ? 'answered'
        : p.decision.type === 'deny'
          ? 'denied'
          : 'ask_human',
    question: p.question,
    decisionType: p.decision.type,
    text: p.decision.text,
    rationale: p.decision.rationale,
    reason: p.decision.reason,
    optionId: p.decision.optionId,
    at: Date.now(),
  };
  chat.addMessage({ role: 'assistant', content, brainDecision });
}

/**
 * Council seat votes are NOT buffered here: the council log store already
 * tracks each panel's seats per request id (deduped by seat id, retained as
 * whole panels in its ring buffer). `brain.council_vote` fires once per seat
 * and `brain.council_resolved` once per panel, both from inside
 * `council.decide()`. Both reached the browser and were dropped on the
 * floor, so the most expensive Brain tier — one provider call per seat — was
 * completely invisible in the UI. The resolved handler reads the panel's
 * seats back from the store, so vote eviction is per-panel (per-request): a
 * live panel's seats can never be dropped by other requests' vote traffic
 * (the old global 50-vote buffer could). Whole panels still age out of the
 * store's ring buffer, which is the intended log retention.
 */
export function handleBrainEvent(msg: WSServerMessage) {
  // `brain.*` is fail-OPEN: the arbiter is global and legitimately emits
  // untagged, which belongs to whoever is in front. A TAGGED one lands in its
  // own lane — including a background tab's, which an `isActiveSessionMessage`
  // gate here used to throw away after the router had already addressed it.
  const chat = chatFor(msg) ?? activeChatLane();
  const p = msg.payload as {
    event: string;
    intervened?: boolean;
    requestId?: string;
    seatId?: string;
    persona?: string;
    status?: string;
    optionId?: string;
    model?: string;
    veto?: boolean;
    resolution?: string;
    reason?: string;
    configuredSeatCount?: number;
    validVoteCount?: number;
    distinctTargetCount?: number;
    judgeUsed?: boolean;
    judgeLabel?: string;
    judgeIsVoter?: boolean;
    warnings?: string[];
    /** Which tier of the ladder resolved the decision. */
    tier?: string;
    /** ask_human only: a human is being waited on and the decision is open. */
    pending?: boolean;
    usage?: { totalTokens?: number; durationMs?: number };
    request?: { id?: string; question?: string; source?: string; risk?: string };
    decision?: {
      type?: string;
      optionId?: string;
      text?: string;
      reason?: string;
      rationale?: string;
    };
  };
  // The question text lives on the decision_* events, not the council ones.
  // Fold it into an already-open panel so the log row reads as a question
  // rather than a bare request id.
  //
  // NOTE the two id shapes: the council events carry a top-level `requestId`,
  // while every `brain.decision_*` event nests it as `request.id`. Reading only
  // the former silently never matched, which is the whole reason this lookup
  // is spelled out rather than inlined.
  const questionRequestId = p.requestId ?? p.request?.id;
  if (questionRequestId && p.request?.question) {
    councilLogFor(msg).noteQuestion(questionRequestId, p.request.question);
  }
  if (p.event === 'brain.council_vote') {
    councilLogFor(msg).recordVote(p as Record<string, unknown>);
    const requestId = p.requestId ?? 'unknown';
    useVizStore.getState().pushEvent({
      // seatId is always emitted by the server; the timestamp-suffixed
      // fallback only guards a malformed payload from producing duplicate
      // React keys in the live feed.
      id: `council_${requestId}_${p.seatId ?? `seat-${Date.now()}`}`,
      kind: 'brain:council_vote',
      timestamp: Date.now(),
      source: p.model ?? p.persona ?? 'seat',
      target: 'brain',
      label: `${p.persona ?? 'voter'} → ${p.status === 'valid' ? (p.optionId ?? 'stance') : (p.status ?? 'failed')}`,
      data: p,
      color: '#38bdf8',
      flowGroup: 'brain',
    });
    return;
  }
  if (p.event === 'brain.council_resolved') {
    councilLogFor(msg).recordResolution(p as Record<string, unknown>);
    const requestId = p.requestId ?? 'unknown';
    // Read the panel's seats back from the log store — recordResolution above
    // upserts the panel, so it is always present. No parallel buffer: eviction
    // is per-panel, so a live panel's votes can never be dropped by other
    // requests' traffic.
    const panel = councilLogFor(msg).panels.find((entry) => entry.requestId === requestId);
    const seats = panel?.seats ?? [];
    const seatLines = seats.map(
      (seat) =>
        `- **${seat.persona}**${seat.veto ? ' (veto)' : ''} → ${seat.status === 'valid' ? (seat.optionId ?? 'stance') : seat.status}${seat.model ? ` · \`${seat.model}\`` : ''}`,
    );
    // `distinctTargetCount` is reported next to the seat count on purpose: a
    // panel whose seats resolved to the SAME model looks like a normal
    // unanimous verdict while adding cost without adding independence.
    const headline = [
      `⚖️ **Council ${p.resolution ?? 'resolved'}**`,
      `${p.validVoteCount ?? seats.length}/${p.configuredSeatCount ?? seats.length} seats`,
      `${p.distinctTargetCount ?? 0} distinct target${p.distinctTargetCount === 1 ? '' : 's'}`,
      p.judgeUsed ? 'judge used' : undefined,
      p.usage?.totalTokens ? `${p.usage.totalTokens} tok` : undefined,
    ]
      .filter(Boolean)
      .join(' · ');

    const councilDecision: CouncilDecisionData = {
      requestId,
      status: p.status ?? panel?.status ?? 'decided',
      resolution: p.resolution ?? panel?.resolution ?? 'decided',
      optionId: p.optionId ?? panel?.optionId,
      question: panel?.question ?? p.request?.question,
      reason: p.reason ?? panel?.reason,
      configuredSeatCount: p.configuredSeatCount ?? panel?.configuredSeatCount ?? seats.length,
      validVoteCount: p.validVoteCount ?? panel?.validVoteCount ?? seats.length,
      distinctTargetCount:
        p.distinctTargetCount ??
        panel?.distinctTargetCount ??
        new Set(seats.map((s) => s.model || s.persona)).size,
      judgeUsed: Boolean(p.judgeUsed ?? panel?.judgeUsed),
      totalTokens: p.usage?.totalTokens ?? panel?.totalTokens,
      durationMs: p.usage?.durationMs ?? panel?.durationMs,
      warnings: p.warnings ?? panel?.warnings,
      seats: seats.length > 0 ? seats : (panel?.seats ?? []),
    };

    chat.addMessage({
      role: 'assistant',
      content: [headline, ...seatLines, ...(p.warnings ?? []).map((w) => `> ⚠ ${w}`)]
        .filter(Boolean)
        .join('\n'),
      councilDecision,
    });
    for (const warning of p.warnings ?? []) toast.warn(warning);
    return;
  }
  if (p.event === 'brain.intervention') {
    const guidance = p.decision?.rationale ?? p.decision?.text ?? '';
    const headline = p.intervened
      ? '🧠 **Brain intervention** — corrective guidance was sent to the agent.'
      : '🧠 **Brain check** — a distress signal was reviewed; no action needed.';
    const brainDecision: BrainDecisionData = {
      id: p.requestId ?? p.request?.id,
      kind: p.intervened ? 'intervention' : 'check',
      intervened: Boolean(p.intervened),
      question: p.request?.question,
      source: p.request?.source,
      risk: p.request?.risk,
      decisionType: p.decision?.type ?? (p.intervened ? 'steer' : 'observe'),
      optionId: p.decision?.optionId,
      text: p.decision?.text,
      rationale: guidance,
      reason: p.decision?.reason,
      at: Date.now(),
    };
    chat.addMessage({
      role: 'assistant',
      content: [headline, p.request?.question ?? '', guidance ? `_${guidance}_` : '']
        .filter(Boolean)
        .join('\n\n'),
      brainDecision,
    });
    if (p.intervened) toast.info('Brain intervened: agent steered');
  } else if (p.event === 'brain.decision_denied') {
    const reason = p.decision?.reason ?? p.request?.question ?? 'request';
    const brainDecision: BrainDecisionData = {
      id: p.requestId ?? p.request?.id,
      kind: 'denied',
      question: p.request?.question,
      source: p.request?.source,
      risk: p.request?.risk,
      tier: p.tier,
      decisionType: 'deny',
      reason,
      rationale: p.decision?.rationale,
      at: Date.now(),
    };
    chat.addMessage({
      role: 'assistant',
      content: `🧠 Denied: ${reason}`,
      brainDecision,
    });
    toast.warn(`Brain denied: ${reason}`);
  } else if (p.event === 'brain.decision_answered') {
    const text = p.decision?.text ?? p.decision?.optionId ?? '';
    const rationale = p.decision?.rationale ?? '';
    const brainDecision: BrainDecisionData = {
      id: p.requestId ?? p.request?.id,
      kind: 'answered',
      question: p.request?.question,
      source: p.request?.source,
      risk: p.request?.risk,
      tier: p.tier,
      decisionType: p.decision?.type ?? 'answer',
      optionId: p.decision?.optionId,
      text,
      rationale,
      reason: p.decision?.reason,
      at: Date.now(),
    };
    chat.addMessage({
      role: 'assistant',
      content: `🧠 ${text}${rationale ? `\n\n_${rationale}_` : ''}`,
      brainDecision,
    });
  } else if (p.event === 'brain.decision_ask_human') {
    const brainDecision: BrainDecisionData = {
      id: p.requestId ?? p.request?.id,
      kind: 'ask_human',
      question: p.request?.question,
      source: p.request?.source,
      risk: p.request?.risk,
      tier: p.tier,
      decisionType: 'ask_human',
      rationale: p.decision?.rationale,
      reason: p.decision?.reason,
      at: Date.now(),
    };
    chat.addMessage({
      role: 'assistant',
      // The same event carries the PROMPT (a human is being waited on right
      // now) and a final ask_human (nothing is waiting — the chain simply had
      // no answer). Saying "it needs human judgement" for both told a user
      // to act on a decision that had already closed.
      content: p.pending
        ? '🧠 The Brain is waiting on you — this decision needs human judgement.'
        : '🧠 The Brain escalated this question back to you; no prompt is open for it.',
      brainDecision,
    });
  }
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
  if (p.error) {
    // Auto-retry ONCE on a timeout with the server-suggested longer window —
    // the model was reachable, just slow. Everything else (or a second
    // timeout) surfaces the recovery panel so the user decides.
    if (p.errorKind === 'timeout' && !refinePanel.retried && p.retryTimeoutMs) {
      useUIStore.getState().setRefinePanel({
        ...refinePanel,
        status: 'refining',
        retried: true,
      });
      getWSClient().refineModel(refinePanel.original, { timeoutMs: p.retryTimeoutMs });
      return;
    }
    // Surface the failure with recovery options instead of silently sending
    // the original — the user can retry, switch model, edit, or send as-is.
    useUIStore.getState().setRefinePanel({
      ...refinePanel,
      status: 'failed',
      error: p.error,
      errorKind: p.errorKind,
      fallbackRef: p.fallbackRef,
    });
    return;
  }
  const original = refinePanel.original;
  if (normalizedEqual(p.refined, original)) {
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
    refined: p.refined,
    english: p.english,
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
  };
  if (useGitChangesStore.getState().selectedPath !== p.path) return;
  useGitChangesStore.getState().setDiff({
    path: p.path,
    oldText: p.oldText ?? '',
    newText: p.newText ?? '',
    binary: p.binary,
    tooLarge: p.tooLarge,
    error: p.error,
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
          fileCount: 0,
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
