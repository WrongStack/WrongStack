import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppTranslation, i18n } from '@/i18n';
import { useWebSocket } from '@/hooks/useWebSocket';
import { useGoalRunStore, useChatStore, useWorktreeStore, useGoalAssessStore } from '@/stores';
import { showPanel } from '@/components/activity-bar/nav';
import { cn } from '@/lib/utils';
import { BoardView } from './BoardView';
import { WorktreeGraph } from './WorktreeGraph';
import { WorktreeLanes } from './WorktreeLanes';
import { WorktreeOrphans } from './WorktreeOrphans';
import { Layers, Loader2, Pause, Play, Plus, Rocket, Square, Undo2, X, Zap } from 'lucide-react';
import { Button } from './ui/button';

/**
 * GoalView — Full-screen goal phase view.
 *
 * Start screen (no phases) → goal form. Once phases exist, the interactive
 * kanban BoardView fills the area (phase columns / status swimlanes, drag-drop,
 * manual assignment, live worker per task). Worktree visualization docks at the
 * bottom while worktrees are active.
 *
 * Uses the shared useGoalRunStore (synced via goal.state WS events) so
 * board data stays consistent with the chat-area PhasePanel.
 */
export function GoalView({ onClose }: { onClose: () => void }): React.ReactElement {
  const { client } = useWebSocket();
  const { t } = useAppTranslation();
  const phases = useGoalRunStore((s) => s.phases);
  const overallPercent = useGoalRunStore((s) => s.overallPercent);
  const autonomous = useGoalRunStore((s) => s.autonomous);
  const title = useGoalRunStore((s) => s.title);
  const goalText = useGoalRunStore((s) => s.goal);
  const status = useGoalRunStore((s) => s.status);
  const lastError = useGoalRunStore((s) => s.lastError);
  const graphs = useGoalRunStore((s) => s.graphs);

  // Pull the list of persisted boards and current state for this project on mount.
  useEffect(() => {
    client?.send?.({ type: 'goal.list' });
    client?.send?.({ type: 'goal.state' });
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
  // Additional goal configuration options.
  const [multiBoard, setMultiBoard] = useState(false);
  const [verifyTasks, setVerifyTasks] = useState(false);
  const [chimeraReview, setChimeraReview] = useState(false);

  // ── Goal realism assessment ──────────────────────────────────────────────
  const assessResult = useGoalAssessStore((s) => s.result);
  const assessLoading = useGoalAssessStore((s) => s.loading);
  const assessDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounced assessment: send goal.assess 800ms after the user stops typing.
  useEffect(() => {
    if (assessDebounceRef.current) clearTimeout(assessDebounceRef.current);
    if (!goal.trim()) {
      useGoalAssessStore.getState().clear();
      return;
    }
    assessDebounceRef.current = setTimeout(() => {
      useGoalAssessStore.getState().setLoading();
      const seq = useGoalAssessStore.getState().nextSeq();
      client?.send?.({ type: 'goal.assess', payload: { goal, seq } });
    }, 800);
    return () => {
      if (assessDebounceRef.current) clearTimeout(assessDebounceRef.current);
    };
  }, [goal, client]);

  // Clear assessment when the form resets.
  useEffect(() => {
    if (!goal.trim() && !planningGoal) {
      useGoalAssessStore.getState().clear();
    }
  }, [goal, planningGoal]);

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
      content: i18n.t('activity:goalRun.planningAck'),
    });
    setPlanningGoal(g);
    setGoal('');
    client?.send?.({
      type: 'goal.start',
      payload: {
        title: g,
        autonomous: true,
        worktrees: isolate,
        multiBoard,
        verifyTasks,
        chimeraReview,
      },
    });
    // Navigate to chat so the user sees the echoed goal and live agent
    // messages in the transcript.
    showPanel('chat');
  }, [goal, planningGoal, client, isolate]);

  const handleCancelPlanning = useCallback(() => {
    client?.send?.({ type: 'goal.stop', payload: {} });
    setPlanningGoal(null);
  }, [client]);

  const handleToggleAutonomous = useCallback(() => {
    client?.send?.({ type: 'goal.toggleAutonomous', payload: {} });
  }, [client]);

  const handlePauseResume = useCallback(() => {
    client?.send?.(
      status === 'paused'
        ? { type: 'goal.resume', payload: {} }
        : { type: 'goal.pause', payload: {} },
    );
  }, [client, status]);

  const handleStop = useCallback(() => {
    client?.send?.({ type: 'goal.stop', payload: {} });
  }, [client]);

  // Reset to an empty board and start fresh. Clears locally too so the start
  // screen shows immediately, even before the server's cleared state arrives.
  const handleNew = useCallback(() => {
    client?.send?.({ type: 'goal.clear', payload: {} });
    useGoalRunStore.getState().clear();
    setPlanningGoal(null);
    setGoal('');
  }, [client]);

  const [confirmRevert, setConfirmRevert] = useState(false);
  const handleRevert = useCallback(() => {
    client?.send?.({ type: 'goal.revert', payload: {} });
    setConfirmRevert(false);
  }, [client]);

  const isLive = status === 'running' || status === 'paused';
  // A finished/halted run: offer New (reset) and Revert (undo the run's commits).
  const isDone = status === 'stopped' || status === 'completed' || status === 'failed';

  const handleSelectBoard = useCallback(
    (graphId: string) => {
      if (graphId) client?.send?.({ type: 'goal.load', payload: { graphId } });
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
            <h1 className="text-lg font-semibold">{hasPhases ? title || 'Goal' : 'Goal'}</h1>
            {hasPhases && (
              <p className="text-xs text-muted-foreground">
                {t('activity:goalRun.summary', { count: phases.length, pct: overallPercent })}
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
          {/* Board selector — every Goal run is a persisted board (JSON on
              disk); switch between all boards saved for this project. */}
          {graphs.length > 0 && (
            <select
              value={hasPhases ? (graphs.find((g) => g.title === title)?.id ?? '') : ''}
              onChange={(e) => handleSelectBoard(e.target.value)}
              title={t('activity:goalRun.switchBoard')}
              className="min-w-0 flex-1 rounded border border-border bg-card px-2 py-1 text-xs text-foreground sm:w-72 sm:flex-none"
            >
              <option value="" disabled>
                {t('activity:goalRun.boardsCount', { count: graphs.length })}
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
              title={t('activity:goalRun.toggleAutonomousTitle')}
              className={cn(
                'inline-flex items-center gap-1 rounded border px-2 py-1 text-xs transition-colors',
                autonomous
                  ? 'border-primary/30 bg-primary/10 text-primary'
                  : 'border-border text-muted-foreground hover:text-foreground',
              )}
            >
              <Zap className="h-3.5 w-3.5" />{' '}
              {autonomous ? t('activity:goalRun.autonomous') : t('activity:goalRun.manual')}
            </button>
          )}
          {isLive && (
            <>
              <button
                type="button"
                onClick={handlePauseResume}
                title={
                  status === 'paused'
                    ? t('activity:goalRun.resumeTitle')
                    : t('activity:goalRun.pauseTitle')
                }
                className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                {status === 'paused' ? (
                  <Play className="h-3.5 w-3.5" />
                ) : (
                  <Pause className="h-3.5 w-3.5" />
                )}
                {status === 'paused' ? t('activity:goalRun.resume') : t('activity:goalRun.pause')}
              </button>
              <button
                type="button"
                onClick={handleStop}
                title={t('activity:goalRun.stopTitle')}
                className="inline-flex items-center gap-1 rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs font-medium text-destructive transition-colors hover:bg-destructive/20"
              >
                <Square className="h-3.5 w-3.5 fill-current" /> {t('activity:goalRun.stop')}
              </button>
            </>
          )}
          {hasPhases && isDone && (
            <>
              <button
                type="button"
                onClick={handleNew}
                title={t('activity:goalRun.newTitle')}
                className="inline-flex items-center gap-1 rounded border border-primary/30 bg-primary/10 px-2 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/20"
              >
                <Plus className="h-3.5 w-3.5" /> {t('activity:goalRun.newLabel')}
              </button>
              {confirmRevert ? (
                <span className="inline-flex items-center gap-1 rounded border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-xs">
                  <span className="text-warning">{t('activity:goalRun.revertConfirm')}</span>
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
                  title={t('activity:goalRun.revertTitle')}
                  className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                >
                  <Undo2 className="h-3.5 w-3.5" /> {t('activity:goalRun.revert')}
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
            <Rocket className="h-3 w-3" /> {t('activity:goalRun.goal')}
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
              <h2 className="text-xl font-semibold">{t('activity:goalRun.planning')}</h2>
              <p className="text-sm text-muted-foreground">{t('activity:goalRun.planningBody')}</p>
            </div>
            <div className="rounded-lg border border-border bg-card px-4 py-3 text-left">
              <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                <Rocket className="h-3 w-3" /> {t('activity:goalRun.goal')}
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
              <h2 className="text-xl font-semibold">{t('activity:goalRun.startHeading')}</h2>
              <p className="text-sm text-muted-foreground">{t('activity:goalRun.startBody')}</p>
            </div>

            <textarea
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder={t('activity:goalRun.startPlaceholder')}
              rows={5}
              className="w-full rounded-lg border border-border bg-card px-4 py-3 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary/30 placeholder:text-muted-foreground/70"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  handleStart();
                }
              }}
            />

            {/* ── Goal realism assessment ── */}
            {assessLoading && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                {t('activity:goalRun.assess.analyzing')}
              </div>
            )}
            {!assessLoading && assessResult && !assessResult.parseFailed && (
              <div
                className={cn(
                  'rounded-lg border px-3 py-2 text-xs space-y-1.5',
                  assessResult.realistic
                    ? 'border-success/40 bg-success/10'
                    : 'border-warning/40 bg-warning/10',
                )}
              >
                <div className="flex items-center gap-1.5 font-medium">
                  {assessResult.realistic ? (
                    <span className="text-success">{t('activity:goalRun.assess.realistic')}</span>
                  ) : (
                    <span className="text-warning">
                      {t('activity:goalRun.assess.durationConcern')}
                    </span>
                  )}
                </div>
                {assessResult.durationClaimed && (
                  <p className="text-muted-foreground">
                    {t('activity:goalRun.assess.durationClaimed', {
                      duration: assessResult.durationClaimed,
                    })}
                  </p>
                )}
                <p className="text-muted-foreground">{assessResult.explanation}</p>
                {assessResult.recommendedDuration && (
                  <p className="text-muted-foreground">
                    {t('activity:goalRun.assess.recommendation', {
                      duration: assessResult.recommendedDuration,
                    })}
                  </p>
                )}
                {assessResult.concerns.length > 0 && (
                  <div className="space-y-0.5">
                    <p className="font-medium text-foreground/80">
                      {t('activity:goalRun.assess.concerns')}
                    </p>
                    <ul className="list-disc pl-4 space-y-0.5 text-muted-foreground">
                      {assessResult.concerns.map((c, i) => (
                        <li key={i}>{c}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
            {!assessLoading && assessResult?.parseFailed && (
              <div className="rounded-lg border border-border/40 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                {t('activity:goalRun.assess.analysisFailed')}
              </div>
            )}

            <label className="flex cursor-pointer items-center justify-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={isolate}
                onChange={(e) => setIsolate(e.target.checked)}
                className="h-3.5 w-3.5 accent-primary"
              />
              {t('activity:goalRun.isolateLabel')}
            </label>

            <div className="flex flex-wrap items-center justify-center gap-3 text-xs text-muted-foreground">
              <label className="flex cursor-pointer items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={multiBoard}
                  onChange={(e) => setMultiBoard(e.target.checked)}
                  className="h-3.5 w-3.5 accent-primary"
                />
                {t('activity:goalRun.multiBoardLabel')}
              </label>
              <label className="flex cursor-pointer items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={verifyTasks}
                  onChange={(e) => setVerifyTasks(e.target.checked)}
                  className="h-3.5 w-3.5 accent-primary"
                />
                {t('activity:goalRun.verifyTasksLabel')}
              </label>
              <label className="flex cursor-pointer items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={chimeraReview}
                  onChange={(e) => setChimeraReview(e.target.checked)}
                  className="h-3.5 w-3.5 accent-primary"
                />
                {t('activity:goalRun.chimeraReviewLabel')}
              </label>
            </div>

            <div className="flex items-center gap-3">
              {!assessLoading &&
                assessResult &&
                !assessResult.realistic &&
                !assessResult.parseFailed && (
                  <button
                    type="button"
                    onClick={() => useGoalAssessStore.getState().clear()}
                    className="shrink-0 rounded border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                    title={t('activity:goalRun.assess.overrideTitle')}
                  >
                    {t('activity:goalRun.assess.override')}
                  </button>
                )}
              <Button
                onClick={handleStart}
                disabled={
                  !goal.trim() ||
                  planningGoal != null ||
                  assessLoading ||
                  (!assessLoading &&
                    assessResult != null &&
                    !assessResult.parseFailed &&
                    !assessResult.realistic)
                }
                className="flex-1 gap-2"
                title={
                  !goal.trim()
                    ? ''
                    : !assessLoading &&
                        assessResult &&
                        !assessResult.parseFailed &&
                        !assessResult.realistic
                      ? t('activity:goalRun.assess.disableTitle')
                      : ''
                }
              >
                <Play className="h-4 w-4" />
                {t('activity:goalRun.startButton')}
              </Button>
            </div>

            <p className="text-xs text-muted-foreground text-center">
              {t('activity:goalRun.ctrlHint')} ·{' '}
              {isolate ? t('activity:goalRun.isolateOn') : t('activity:goalRun.isolateOff')}
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
              {t('activity:goalRun.lanes')}
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
              {t('activity:goalRun.graph')}
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
