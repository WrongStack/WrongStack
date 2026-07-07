import { useCallback, useEffect, useState } from 'react';
import { useAppTranslation, i18n } from '@/i18n';
import { useWebSocket } from '@/hooks/useWebSocket';
import { useAutoPhaseStore, useChatStore, useWorktreeStore } from '@/stores';
import { showPanel } from '@/components/activity-bar/nav';
import { cn } from '@/lib/utils';
import { BoardView } from './BoardView';
import { WorktreeGraph } from './WorktreeGraph';
import { WorktreeLanes } from './WorktreeLanes';
import { WorktreeOrphans } from './WorktreeOrphans';
import { Layers, Loader2, Pause, Play, Plus, Rocket, Square, Undo2, X, Zap } from 'lucide-react';
import { Button } from './ui/button';

/**
 * AutoPhaseView — Full-screen phase view.
 *
 * Start screen (no phases) → goal form. Once phases exist, the interactive
 * kanban BoardView fills the area (phase columns / status swimlanes, drag-drop,
 * manual assignment, live worker per task). Worktree visualization docks at the
 * bottom while worktrees are active.
 *
 * Uses the shared useAutoPhaseStore (synced via autophase.state WS events) so
 * board data stays consistent with the chat-area PhasePanel.
 */
export function AutoPhaseView({ onClose }: { onClose: () => void }): React.ReactElement {
  const { client } = useWebSocket();
  const { t } = useAppTranslation();
  const phases = useAutoPhaseStore((s) => s.phases);
  const overallPercent = useAutoPhaseStore((s) => s.overallPercent);
  const autonomous = useAutoPhaseStore((s) => s.autonomous);
  const title = useAutoPhaseStore((s) => s.title);
  const goalText = useAutoPhaseStore((s) => s.goal);
  const status = useAutoPhaseStore((s) => s.status);
  const lastError = useAutoPhaseStore((s) => s.lastError);
  const graphs = useAutoPhaseStore((s) => s.graphs);

  // Pull the list of persisted boards and current state for this project on mount.
  useEffect(() => {
    client?.send?.({ type: 'autophase.list' });
    client?.send?.({ type: 'autophase.state' });
  }, [client]);

  const worktrees = useWorktreeStore((s) => s.worktrees);
  const baseBranch = useWorktreeStore((s) => s.baseBranch);

  const [goal, setGoal] = useState('');
  // The goal we submitted, kept until the first phase state arrives so the
  // start screen can show a persistent "planning…" state instead of silently
  // resetting the form (which read as "nothing happened").
  const [planningGoal, setPlanningGoal] = useState<string | null>(null);
  const [showGraph, setShowGraph] = useState(false);
  // Per-run git-worktree isolation (vs running phases on the current branch).
  const [isolate, setIsolate] = useState(true);

  const hasPhases = phases.length > 0;
  const planning = planningGoal != null && !hasPhases;

  // Phases arrived (or the run was cleared) → planning is over.
  useEffect(() => {
    if (hasPhases) setPlanningGoal(null);
  }, [hasPhases]);

  const handleStart = useCallback(() => {
    const g = goal.trim();
    if (!g || planningGoal != null) return;
    // Echo the goal into the chat transcript and acknowledge it, so the run is
    // traceable in chat history and the submit gives clear feedback.
    const chat = useChatStore.getState();
    chat.addMessage({ role: 'user', content: g });
    chat.addMessage({
      role: 'assistant',
      content: i18n.t('activity:autoPhase.planningAck'),
    });
    setPlanningGoal(g);
    setGoal('');
    client?.send?.({
      type: 'autophase.start',
      payload: { title: g, autonomous: true, worktrees: isolate },
    });
    // Navigate to chat so the user sees the echoed goal and live agent
    // messages in the transcript.
    showPanel('chat');
  }, [goal, planningGoal, client, isolate]);

  const handleCancelPlanning = useCallback(() => {
    client?.send?.({ type: 'autophase.stop', payload: {} });
    setPlanningGoal(null);
  }, [client]);

  const handleToggleAutonomous = useCallback(() => {
    client?.send?.({ type: 'autophase.toggleAutonomous', payload: {} });
  }, [client]);

  const handlePauseResume = useCallback(() => {
    client?.send?.(
      status === 'paused'
        ? { type: 'autophase.resume', payload: {} }
        : { type: 'autophase.pause', payload: {} },
    );
  }, [client, status]);

  const handleStop = useCallback(() => {
    client?.send?.({ type: 'autophase.stop', payload: {} });
  }, [client]);

  // Reset to an empty board and start fresh. Clears locally too so the start
  // screen shows immediately, even before the server's cleared state arrives.
  const handleNew = useCallback(() => {
    client?.send?.({ type: 'autophase.clear', payload: {} });
    useAutoPhaseStore.getState().clear();
    setPlanningGoal(null);
    setGoal('');
  }, [client]);

  const [confirmRevert, setConfirmRevert] = useState(false);
  const handleRevert = useCallback(() => {
    client?.send?.({ type: 'autophase.revert', payload: {} });
    setConfirmRevert(false);
  }, [client]);

  const isLive = status === 'running' || status === 'paused';
  // A finished/halted run: offer New (reset) and Revert (undo the run's commits).
  const isDone = status === 'stopped' || status === 'completed' || status === 'failed';

  const handleSelectBoard = useCallback(
    (graphId: string) => {
      if (graphId) client?.send?.({ type: 'autophase.load', payload: { graphId } });
    },
    [client],
  );

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-background">
      {/* Header */}
      <header className="flex shrink-0 flex-col gap-2 border-b bg-card px-4 py-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-2">
          <Layers className="h-5 w-5 text-muted-foreground" />
          <div>
            <h1 className="text-lg font-semibold">
              {hasPhases ? title || 'AutoPhase' : 'AutoPhase'}
            </h1>
            {hasPhases && (
              <p className="text-xs text-muted-foreground">
                {t('activity:autoPhase.summary', { count: phases.length, pct: overallPercent })}
              </p>
            )}
          </div>
          {hasPhases && (
            <span
              className={cn(
                'rounded border px-2 py-0.5 text-[11px] font-medium capitalize',
                status === 'failed'
                  ? 'border-destructive/40 bg-destructive/10 text-destructive'
                  : status === 'paused' || status === 'stopped'
                    ? 'border-warning/40 bg-warning/10 text-warning'
                    : status === 'completed'
                      ? 'border-success/40 bg-success/10 text-success'
                      : 'border-primary/30 bg-primary/10 text-primary',
              )}
              title={lastError ?? undefined}
            >
              {status}
            </span>
          )}
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2 sm:justify-end">
          {/* Board selector — every AutoPhase run is a persisted board (JSON on
              disk); switch between all boards saved for this project. */}
          {graphs.length > 0 && (
            <select
              value={hasPhases ? (graphs.find((g) => g.title === title)?.id ?? '') : ''}
              onChange={(e) => handleSelectBoard(e.target.value)}
              title={t('activity:autoPhase.switchBoard')}
              className="min-w-0 flex-1 rounded border border-border bg-card px-2 py-1 text-xs text-foreground sm:w-72 sm:flex-none"
            >
              <option value="" disabled>
                {t('activity:autoPhase.boardsCount', { count: graphs.length })}
              </option>
              {graphs.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.title} · {g.status}
                </option>
              ))}
            </select>
          )}
          {hasPhases && (
            <button
              type="button"
              onClick={handleToggleAutonomous}
              title={t('activity:autoPhase.toggleAutonomousTitle')}
              className={cn(
                'inline-flex items-center gap-1 rounded border px-2 py-1 text-xs transition-colors',
                autonomous
                  ? 'border-primary/30 bg-primary/10 text-primary'
                  : 'border-border text-muted-foreground hover:text-foreground',
              )}
            >
              <Zap className="h-3.5 w-3.5" />{' '}
              {autonomous ? t('activity:autoPhase.autonomous') : t('activity:autoPhase.manual')}
            </button>
          )}
          {isLive && (
            <>
              <button
                type="button"
                onClick={handlePauseResume}
                title={
                  status === 'paused'
                    ? t('activity:autoPhase.resumeTitle')
                    : t('activity:autoPhase.pauseTitle')
                }
                className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                {status === 'paused' ? (
                  <Play className="h-3.5 w-3.5" />
                ) : (
                  <Pause className="h-3.5 w-3.5" />
                )}
                {status === 'paused'
                  ? t('activity:autoPhase.resume')
                  : t('activity:autoPhase.pause')}
              </button>
              <button
                type="button"
                onClick={handleStop}
                title={t('activity:autoPhase.stopTitle')}
                className="inline-flex items-center gap-1 rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs font-medium text-destructive transition-colors hover:bg-destructive/20"
              >
                <Square className="h-3.5 w-3.5 fill-current" /> {t('activity:autoPhase.stop')}
              </button>
            </>
          )}
          {hasPhases && isDone && (
            <>
              <button
                type="button"
                onClick={handleNew}
                title={t('activity:autoPhase.newTitle')}
                className="inline-flex items-center gap-1 rounded border border-primary/30 bg-primary/10 px-2 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/20"
              >
                <Plus className="h-3.5 w-3.5" /> {t('activity:autoPhase.newLabel')}
              </button>
              {confirmRevert ? (
                <span className="inline-flex items-center gap-1 rounded border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-xs">
                  <span className="text-warning">
                    {t('activity:autoPhase.revertConfirm')}
                  </span>
                  <button
                    type="button"
                    onClick={handleRevert}
                    className="rounded bg-destructive/15 px-1.5 py-0.5 font-medium text-destructive hover:bg-destructive/25"
                  >
                    {t('common:action.yes')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmRevert(false)}
                    className="rounded px-1.5 py-0.5 text-muted-foreground hover:text-foreground"
                  >
                    {t('common:action.no')}
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmRevert(true)}
                  title={t('activity:autoPhase.revertTitle')}
                  className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                >
                  <Undo2 className="h-3.5 w-3.5" /> {t('activity:autoPhase.revert')}
                </button>
              )}
            </>
          )}
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      </header>

      {/* Goal block — the operator's full prompt, shown verbatim and separate
          from the short title heading (not a dropdown / not a card tile). */}
      {hasPhases && goalText && (
        <div className="shrink-0 border-b border-border/60 bg-muted/20 px-4 py-2.5">
          <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            <Rocket className="h-3 w-3" /> {t('activity:autoPhase.goal')}
          </div>
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
            {goalText}
          </p>
        </div>
      )}

      {hasPhases ? (
        /* ── Interactive kanban board ── */
        <div className="flex min-h-0 flex-1">
          <BoardView />
        </div>
      ) : planning ? (
        /* ── Planning state — goal accepted, phases not built yet ── */
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="max-w-lg w-full space-y-5 text-center">
            <Loader2 className="h-10 w-10 mx-auto animate-spin text-primary/70" />
            <div className="space-y-1">
              <h2 className="text-xl font-semibold">{t('activity:autoPhase.planning')}</h2>
              <p className="text-sm text-muted-foreground">
                {t('activity:autoPhase.planningBody')}
              </p>
            </div>
            <div className="rounded-lg border border-border bg-card px-4 py-3 text-left">
              <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                <Rocket className="h-3 w-3" /> {t('activity:autoPhase.goal')}
              </div>
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
                {planningGoal}
              </p>
            </div>
            <Button variant="outline" onClick={handleCancelPlanning} className="gap-2">
              <Square className="h-4 w-4 fill-current" /> {t('common:action.cancel')}
            </Button>
          </div>
        </div>
      ) : (
        /* ── Start screen ── */
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="max-w-lg w-full space-y-6">
            <div className="text-center space-y-2">
              <Rocket className="h-10 w-10 mx-auto text-primary/60" />
              <h2 className="text-xl font-semibold">{t('activity:autoPhase.startHeading')}</h2>
              <p className="text-sm text-muted-foreground">{t('activity:autoPhase.startBody')}</p>
            </div>

            <textarea
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder={t('activity:autoPhase.startPlaceholder')}
              rows={5}
              className="w-full rounded-lg border border-border bg-card px-4 py-3 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary/30 placeholder:text-muted-foreground/50"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  handleStart();
                }
              }}
            />

            <label className="flex cursor-pointer items-center justify-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={isolate}
                onChange={(e) => setIsolate(e.target.checked)}
                className="h-3.5 w-3.5 accent-primary"
              />
              {t('activity:autoPhase.isolateLabel')}
            </label>

            <div className="flex items-center gap-3">
              <Button onClick={handleStart} disabled={!goal.trim()} className="flex-1 gap-2">
                <Play className="h-4 w-4" />
                {t('activity:autoPhase.startButton')}
              </Button>
            </div>

            <p className="text-xs text-muted-foreground text-center">
              {t('activity:autoPhase.ctrlHint')} ·{' '}
              {isolate ? t('activity:autoPhase.isolateOn') : t('activity:autoPhase.isolateOff')}
            </p>
          </div>
        </div>
      )}

      {/* Worktree visualization */}
      {worktrees.length > 0 && (
        <div className="border-t bg-card/50 shrink-0">
          <div className="flex items-center justify-end gap-2 px-4 pt-2 text-xs">
            <button
              type="button"
              onClick={() => setShowGraph(false)}
              className={cn(
                'rounded px-2 py-0.5 border transition-colors',
                !showGraph
                  ? 'bg-primary/10 border-primary/30 text-primary'
                  : 'border-border text-muted-foreground hover:text-foreground',
              )}
            >
              {t('activity:autoPhase.lanes')}
            </button>
            <button
              type="button"
              onClick={() => setShowGraph(true)}
              className={cn(
                'rounded px-2 py-0.5 border transition-colors',
                showGraph
                  ? 'bg-primary/10 border-primary/30 text-primary'
                  : 'border-border text-muted-foreground hover:text-foreground',
              )}
            >
              {t('activity:autoPhase.graph')}
            </button>
          </div>
          <div className="space-y-2 px-4 pb-3">
            <WorktreeOrphans />
            {showGraph ? (
              <WorktreeGraph worktrees={worktrees} baseBranch={baseBranch} />
            ) : (
              <WorktreeLanes worktrees={worktrees} baseBranch={baseBranch} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
