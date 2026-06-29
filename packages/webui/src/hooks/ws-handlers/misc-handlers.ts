import { normalizedEqual } from '@wrongstack/core';
import { toast } from '@/components/Toaster';
import { getWSClient } from '@/lib/ws-client';
import type { PhaseItem } from '@/components/PhasePanel';
import { useAutoPhaseStore, useChatStore, useFileStore, useGitChangesStore, useGitInfoStore, useGoalStore, useSessionStore, useUIStore, useVizStore } from '@/stores';
import { useLocalPrefs } from '@/stores/local-prefs';
import type { WSServerMessage } from '@/types';

function isActiveSessionMessage(msg: WSServerMessage): boolean {
  const sessionId = (msg.payload as { sessionId?: string | undefined } | undefined)?.sessionId;
  const activeId = useSessionStore.getState().session?.id;
  return !sessionId || !activeId || sessionId === activeId;
}

function deriveAutoPhaseStatus(phases: PhaseItem[] | undefined): 'running' | 'paused' | 'completed' | 'failed' | undefined {
  if (!phases || phases.length === 0) return undefined;
  const statuses = phases.map((p) => (p as unknown as { status?: string }).status);
  if (statuses.some((s) => s === 'failed')) return 'failed';
  if (statuses.every((s) => s === 'completed' || s === 'skipped')) return 'completed';
  if (statuses.some((s) => s === 'paused')) return 'paused';
  return 'running';
}

export function handleAutoPhaseState(msg: WSServerMessage) {
  const p = msg.payload as Record<string, unknown>;
  const phases = Array.isArray(p.phases) ? (p.phases as PhaseItem[]) : undefined;
  const status = deriveAutoPhaseStatus(phases);
  useAutoPhaseStore.getState().setState({
    phases,
    activePhaseId: typeof p.activePhaseId === 'string' ? p.activePhaseId : undefined,
    overallPercent: typeof p.overallPercent === 'number' ? p.overallPercent : undefined,
    autonomous: typeof p.autonomous === 'boolean' ? p.autonomous : undefined,
    title: typeof p.title === 'string' ? p.title : undefined,
    goal: typeof p.goal === 'string' ? p.goal : undefined,
    status,
    lastError: status === 'failed' ? useAutoPhaseStore.getState().lastError : null,
  });
}

export function handleAutoPhaseProgress(msg: WSServerMessage) {
  const p = msg.payload as Record<string, unknown>;
  const progress = {
    totalPhases: typeof p.totalPhases === 'number' ? p.totalPhases : 0,
    completed: typeof p.completed === 'number' ? p.completed : 0,
    failed: typeof p.failed === 'number' ? p.failed : 0,
    totalTasks: typeof p.totalTasks === 'number' ? p.totalTasks : 0,
    completedTasks: typeof p.completedTasks === 'number' ? p.completedTasks : 0,
    failedTasks: typeof p.failedTasks === 'number' ? p.failedTasks : 0,
  };
  useAutoPhaseStore.getState().setState({
    progress,
    overallPercent: typeof p.percentComplete === 'number' ? Math.round(p.percentComplete) : undefined,
    status: progress.failed > 0 || progress.failedTasks > 0 ? 'failed' : 'running',
    lastEvent: 'progress',
  });
}

export function handleAutoPhaseLifecycle(msg: WSServerMessage) {
  const p = msg.payload as Record<string, unknown>;
  const title = typeof p.title === 'string' && p.title ? p.title : 'AutoPhase';
  const error = typeof p.error === 'string' && p.error ? p.error : undefined;

  if (msg.type === 'autophase.paused') {
    useAutoPhaseStore.getState().setState({ status: 'paused', autonomous: false, lastEvent: 'paused' });
    toast.info('AutoPhase paused');
    return;
  }
  if (msg.type === 'autophase.resumed') {
    useAutoPhaseStore.getState().setState({ status: 'running', autonomous: true, lastEvent: 'resumed' });
    toast.info('AutoPhase resumed');
    return;
  }
  if (msg.type === 'autophase.stopped') {
    useAutoPhaseStore.getState().setState({ status: 'stopped', autonomous: false, lastEvent: 'stopped' });
    toast.warn('AutoPhase stopped');
    return;
  }
  if (msg.type === 'autophase.cleared') {
    // Reset to an empty board → the view falls back to the goal-entry screen.
    useAutoPhaseStore.getState().clear();
    return;
  }
  if (msg.type === 'autophase.reverted') {
    const ok = (p as { ok?: boolean }).ok === true;
    const reverted = typeof p.reverted === 'number' ? p.reverted : 0;
    const reason = typeof p.reason === 'string' ? p.reason : undefined;
    if (ok) {
      toast.success(reverted > 0 ? `Reverted ${reverted} commit${reverted === 1 ? '' : 's'}` : 'Nothing to revert');
    } else {
      toast.error(`Revert failed: ${reason ?? 'unknown error'}`);
    }
    useAutoPhaseStore.getState().setState({ lastEvent: 'reverted' });
    return;
  }
  if (msg.type === 'autophase.saved') {
    useAutoPhaseStore.getState().setState({ lastEvent: 'saved' });
    toast.success('AutoPhase graph saved');
    return;
  }
  if (msg.type === 'autophase.completed') {
    useAutoPhaseStore.getState().setState({ status: 'completed', autonomous: false, overallPercent: 100, lastEvent: 'completed', lastError: null });
    toast.success(`${title} completed`);
    return;
  }
  if (msg.type === 'autophase.failed' || msg.type === 'autophase.error') {
    const message = error ?? (typeof p.message === 'string' ? p.message : `${title} failed`);
    useAutoPhaseStore.getState().setState({ status: 'failed', autonomous: false, lastEvent: 'failed', lastError: message });
    toast.error(message);
  }
}

export function handleAutoPhaseList(msg: WSServerMessage) {
  const p = msg.payload as {
    graphs?: Array<{ id: string; title: string; updatedAt: number; status: string }> | undefined;
  };
  useAutoPhaseStore.getState().setState({
    lastEvent: 'list',
    graphs: Array.isArray(p.graphs) ? p.graphs : [],
  });
}

export function handleGoalUpdated(msg: WSServerMessage) {
  const p = msg.payload as Record<string, unknown> | null;
  useGoalStore.getState().setGoal(p);
}

export function handlePrefsUpdated(msg: WSServerMessage) {
  const p = msg.payload as Record<string, unknown>;
  (useLocalPrefs.getState().set as (patch: Record<string, unknown>) => void)(p);
}

export function handleBrainStatus(msg: WSServerMessage) {
  if (!isActiveSessionMessage(msg)) return;
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
      const age = ago < 60 ? `${ago}s` : ago < 3600 ? `${Math.round(ago / 60)}m` : `${Math.round(ago / 3600)}h`;
      const q = entry.question.length > 70 ? `${entry.question.slice(0, 67)}…` : entry.question;
      lines.push(`- \`${age} ago\` **${entry.kind}** — ${q}${entry.outcome ? ` → _${entry.outcome}_` : ''}`);
    }
  }
  useChatStore.getState().addMessage({ role: 'assistant', content: lines.join('\n') });
}

export function handleBrainAnswer(msg: WSServerMessage) {
  if (!isActiveSessionMessage(msg)) return;
  const p = msg.payload as {
    question: string;
    decision: { type: string; text?: string; rationale?: string; reason?: string };
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
  useChatStore.getState().addMessage({ role: 'assistant', content });
}

export function handleBrainEvent(msg: WSServerMessage) {
  if (!isActiveSessionMessage(msg)) return;
  const p = msg.payload as {
    event: string;
    intervened?: boolean;
    request?: { question?: string; source?: string; risk?: string };
    decision?: { type?: string; optionId?: string; text?: string; reason?: string; rationale?: string };
  };
  if (p.event === 'brain.intervention') {
    const guidance = p.decision?.rationale ?? p.decision?.text ?? '';
    const headline = p.intervened
      ? '🧠 **Brain intervention** — corrective guidance was sent to the agent.'
      : '🧠 **Brain check** — a distress signal was reviewed; no action needed.';
    useChatStore.getState().addMessage({
      role: 'assistant',
      content: [headline, p.request?.question ?? '', guidance ? `_${guidance}_` : '']
        .filter(Boolean)
        .join('\n\n'),
    });
    if (p.intervened) toast.info('Brain intervened: agent steered');
  } else if (p.event === 'brain.decision_denied') {
    toast.warn(`Brain denied: ${p.decision?.reason ?? p.request?.question ?? 'request'}`);
  }
}

export function handleCollabEvent(msg: WSServerMessage) {
  const p = msg.payload as Record<string, unknown>;
  const label =
    typeof p.kind === 'string'
      ? p.kind
      : typeof p.event === 'string'
        ? p.event
        : 'collab.event';
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

  useGoalStore.getState().appendJournalEntry({
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
  useSessionStore.getState().setEnv({
    cwd: p.cwd,
    projectRoot: p.projectRoot,
    projectName: p.projectRoot.split(/[/\\]/).pop() || p.projectRoot,
  });
  useFileStore.getState().setTreeLoading(true);
  getWSClient().send({ type: 'files.tree', payload: { path: p.cwd } });
}

export function handleModelRefineResult(msg: WSServerMessage) {
  const p = msg.payload as { refined: string; english: string; error?: string | undefined };
  const refinePanel = useUIStore.getState().refinePanel;
  if (!refinePanel) return;
  if (p.error) {
    toast.error(`Refinement failed: ${p.error}`);
    const { original } = refinePanel;
    useUIStore.getState().setRefinePanel(null);
    useChatStore.getState().addMessage({ role: 'user', content: original });
    useChatStore.getState().setLoading(true);
    getWSClient().sendMessage(original);
    return;
  }
  const original = refinePanel.original;
  if (normalizedEqual(p.refined, original)) {
    useUIStore.getState().setRefinePanel(null);
    useChatStore.getState().addMessage({ role: 'user', content: original });
    useChatStore.getState().setLoading(true);
    getWSClient().sendMessage(original);
    return;
  }
  useUIStore.getState().setRefinePanel({
    ...refinePanel,
    refined: p.refined,
    english: p.english,
  });
}

export function handleGitInfo(msg: WSServerMessage) {
  const p = msg.payload as { branch: string; added: number; deleted: number; untracked: number; behind: number; ahead: number };
  useGitInfoStore.getState().setInfo({ ...p, fetchedAt: Date.now() });
}

export function handleGitChanges(msg: WSServerMessage) {
  const p = msg.payload as {
    files: Array<{ path: string; status: string; added: number; deleted: number; staged: boolean }>;
    error?: string | undefined;
  };
  useGitChangesStore.getState().setFiles(p.files ?? [], p.error ?? null);
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

export const miscHandlerMap: Partial<Record<string, (msg: WSServerMessage) => void>> = {
  'goal.updated': handleGoalUpdated,
  'prefs.updated': handlePrefsUpdated,
  'autophase.state': handleAutoPhaseState,
  'autophase.progress': handleAutoPhaseProgress,
  'autophase.paused': handleAutoPhaseLifecycle,
  'autophase.resumed': handleAutoPhaseLifecycle,
  'autophase.stopped': handleAutoPhaseLifecycle,
  'autophase.cleared': handleAutoPhaseLifecycle,
  'autophase.reverted': handleAutoPhaseLifecycle,
  'autophase.saved': handleAutoPhaseLifecycle,
  'autophase.completed': handleAutoPhaseLifecycle,
  'autophase.failed': handleAutoPhaseLifecycle,
  'autophase.error': handleAutoPhaseLifecycle,
  'autophase.list': handleAutoPhaseList,
  'brain.status': handleBrainStatus,
  'brain.answer': handleBrainAnswer,
  'brain.event': handleBrainEvent,
  'collab.event': handleCollabEvent,
  'collab.injection.granted': handleCollabInjectionGranted,
  'eternal.iteration': handleEternalIteration,
  'working_dir.changed': handleWorkingDirChanged,
  'model.refine_result': handleModelRefineResult,
  'git.info': handleGitInfo,
  'git.changes': handleGitChanges,
  'git.diff': handleGitDiff,
};
