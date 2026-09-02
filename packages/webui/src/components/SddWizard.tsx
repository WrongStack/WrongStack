import {
  Bot,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Copy,
  Lightbulb,
  Loader2,
  Network,
  Rocket,
  RotateCcw,
  Send,
  SlidersHorizontal,
  Sparkles,
  Target,
  User,
  X,
  Zap,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useProviderModels } from '@/hooks/useProviderModels';
import { useScrollPosition } from '@/hooks/useScrollPosition';
import { useWebSocket } from '@/hooks/useWebSocket';
import { priorityStyle } from '@/lib/sdd-theme';
import { cn } from '@/lib/utils';
import { useAppTranslation } from '@/i18n';
import { useSddWizardStore } from '@/stores';
import { FallbackEditor } from './FallbackEditor';
import { ModelPicker } from './ModelPicker';
import { type FlowTask, SddFlowGraph } from './SddFlowGraph';
import { Button } from './ui/button';

const PHASE_LABEL: Record<string, string> = {
  idle: 'phaseStart',
  questioning: 'phaseInterview',
  spec_review: 'phaseSpecReview',
  implementation: 'phasePlanning',
  task_review: 'phaseTaskReview',
  executing: 'phaseRunning',
  done: 'phaseDone',
};

const PHASE_ORDER = ['questioning', 'spec_review', 'implementation', 'task_review', 'executing'];

export function SddWizard({
  onClose,
  onRunStarted,
}: {
  onClose: () => void;
  onRunStarted?: () => void;
}): React.ReactElement {
  const { t } = useAppTranslation();
  const { client } = useWebSocket();
  const snapshot = useSddWizardStore((s) => s.snapshot);
  const agentText = useSddWizardStore((s) => s.agentText);
  const error = useSddWizardStore((s) => s.error);
  const startedRunId = useSddWizardStore((s) => s.startedRunId);
  const setStartedRunId = useSddWizardStore((s) => s.setStartedRunId);

  const [goal, setGoal] = useState('');
  const [reply, setReply] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [graphOpen, setGraphOpen] = useState(true);
  const [planOpen, setPlanOpen] = useState(true);
  const [runCfgOpen, setRunCfgOpen] = useState(false);
  const [runModel, setRunModel] = useState<string | undefined>(undefined);
  const [runProvider, setRunProvider] = useState<string | undefined>(undefined);
  const [runFallbacks, setRunFallbacks] = useState<string[]>([]);
  const [runSlots, setRunSlots] = useState(4);
  const [runWorktrees, setRunWorktrees] = useState(true);
  const [runPlanDecompose, setRunPlanDecompose] = useState(false);
  const modelCandidates = useProviderModels(runCfgOpen);

  const send = useCallback(
    (msg: Parameters<NonNullable<typeof client>['send']>[0]) => client?.send?.(msg),
    [client],
  );

  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    send({ type: 'sdd.spec.get' });
  }, [send]);

  const answerCount = snapshot?.answers.length ?? 0;
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [answerCount, agentText]);

  useEffect(() => {
    if (!startedRunId) return;
    setStartedRunId(null);
    onRunStarted?.();
  }, [onRunStarted, setStartedRunId, startedRunId]);

  const busy = snapshot?.busy ?? false;
  const phase = snapshot?.phase ?? 'idle';
  const started = Boolean(snapshot?.sessionId);
  const resumed = Boolean(snapshot?.resumed);
  const priorRunId = snapshot?.lastRunId;

  useEffect(() => {
    if (started) setSubmitting(false);
  }, [started]);

  const lastQuestion = snapshot?.answers[snapshot.answers.length - 1]?.question ?? '';
  const canRun =
    !!snapshot &&
    (snapshot.taskCount > 0 ||
      !!snapshot.graphId ||
      phase === 'task_review' ||
      phase === 'executing');

  const startGoal = () => {
    const g = goal.trim();
    if (!g || busy || submitting) return;
    setSubmitting(true);
    send({ type: 'sdd.spec.start', payload: { goal: g } });
  };

  const sendReply = () => {
    const text = reply.trim();
    if (!text || busy) return;
    send({ type: 'sdd.spec.message', payload: { text } });
    setReply('');
  };

  const sendDirectReply = (text: string) => {
    if (busy || !text.trim()) return;
    send({ type: 'sdd.spec.message', payload: { text: text.trim() } });
    setReply('');
  };

  const approve = () => !busy && send({ type: 'sdd.spec.approve', payload: {} });
  const rewind = (targetPhase?: string) =>
    !busy && send({ type: 'sdd.spec.rewind', payload: targetPhase ? { targetPhase } : {} });

  const startRun = () => {
    send({
      type: 'sdd.run.start',
      payload: {
        parallelSlots: runSlots,
        worktrees: runWorktrees,
        planDecompose: runPlanDecompose,
        ...(runModel ? { model: runModel, provider: runProvider } : {}),
        ...(runFallbacks.length ? { fallbackModels: runFallbacks } : {}),
      },
    });
    setRunCfgOpen(false);
  };

  const discardInterview = () => {
    if (busy) return;
    send({ type: 'sdd.spec.discard', payload: {} });
  };

  const flowTasks = useMemo<FlowTask[]>(
    () =>
      (snapshot?.board?.tasks ?? []).map((t) => ({
        id: t.id,
        shortId: t.shortId,
        title: t.title,
        displayStatus: t.displayStatus,
        priority: t.priority,
        deps: t.deps,
        agentName: t.agentName,
        worktreeBranch: t.worktreeBranch,
        retries: t.retries,
      })),
    [snapshot?.board],
  );
  const hasGraph = flowTasks.length > 0;

  const activeQuestion = agentText && phase === 'questioning' ? agentText : (lastQuestion ?? '');
  const quickReplies = useMemo(() => extractQuickReplies(activeQuestion), [activeQuestion]);
  const answeredCount = snapshot?.answers.length ?? 0;
  const minQuestions = snapshot?.minQuestions ?? 2;
  const maxQuestions = snapshot?.maxQuestions ?? 5;
  const hasMetMin = answeredCount >= minQuestions;
  const progressPct = Math.min(100, Math.round((answeredCount / Math.max(1, maxQuestions)) * 100));

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-background">
      <header className="sdd-sheen flex shrink-0 items-center justify-between border-b border-border px-4 py-2">
        <div className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-primary" />
          <div>
            <h1 className="text-lg font-semibold">
              {snapshot?.title || t('activity:sddWizard.titleFallback')}
            </h1>
            {started && (
              <p className="text-xs text-muted-foreground">
                {t(`activity:sddWizard.${PHASE_LABEL[phase] ?? 'phaseStart'}`)}
                {phase === 'questioning' &&
                  ` · ${t('activity:sddWizard.questionsSuffix', { cur: snapshot?.questionCount ?? 0, max: snapshot?.maxQuestions ?? 0 })}`}
                {snapshot && snapshot.taskCount > 0
                  ? ` · ${t('activity:sddWizard.tasksSuffix', { count: snapshot.taskCount })}`
                  : ''}
              </p>
            )}
          </div>
          {busy && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
        </div>
        <div className="flex items-center gap-2">
          {priorRunId && (
            <button
              type="button"
              onClick={() => onRunStarted?.()}
              className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-muted"
            >
              <Rocket className="h-3.5 w-3.5" /> {t('activity:sddWizard.openLiveBoard')}
            </button>
          )}
          {started && (
            <button
              type="button"
              onClick={discardInterview}
              disabled={busy}
              title={t('activity:sddWizard.discardTitle')}
              className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
            >
              {t('activity:sddWizard.discardInterview')}
            </button>
          )}
          {canRun && (
            <div className="relative flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setRunCfgOpen((o) => !o)}
                title={t('activity:sddWizard.runCfgTitle')}
                className={cn(
                  'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium',
                  runModel || runFallbacks.length || runPlanDecompose
                    ? 'border-primary/40 bg-primary/10 text-primary'
                    : 'border-border bg-muted text-muted-foreground hover:text-foreground',
                )}
              >
                <SlidersHorizontal className="h-3.5 w-3.5" />
                {runModel ? runModel : t('activity:sddWizard.modelsLabel')}
              </button>
              <button
                type="button"
                onClick={startRun}
                className="inline-flex items-center gap-1 rounded-md bg-success/15 px-2.5 py-1 text-xs font-medium text-success hover:bg-success/25"
              >
                <Rocket className="h-3.5 w-3.5" /> {t('activity:sddWizard.startRun')}
              </button>

              {runCfgOpen && (
                <div className="sdd-rise absolute right-0 top-9 z-50 w-72 rounded-lg border border-border bg-popover p-3 shadow-xl">
                  <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {t('activity:sddWizard.defaultWorkerModel')}
                  </div>
                  <ModelPicker
                    value={runModel}
                    provider={runProvider}
                    candidates={modelCandidates}
                    placeholder={t('activity:sddWizard.leaderDefaultPlaceholder')}
                    resetLabel={t('activity:sddWizard.useSessionDefault')}
                    onPick={(model, provider) => {
                      setRunModel(model);
                      setRunProvider(provider);
                    }}
                    onReset={
                      runModel
                        ? () => {
                            setRunModel(undefined);
                            setRunProvider(undefined);
                          }
                        : undefined
                    }
                  />
                  <div className="mb-1 mt-3 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {t('activity:sddWizard.fallbackChain')}
                  </div>
                  <FallbackEditor
                    value={runFallbacks}
                    candidates={modelCandidates}
                    onChange={setRunFallbacks}
                  />
                  <p className="mt-2 text-[10px] text-muted-foreground">
                    {t('activity:sddWizard.appliesToAll')}
                  </p>

                  {/* Parallelism + isolation */}
                  <div className="mt-3 flex items-center justify-between gap-2">
                    <label
                      htmlFor="sdd-slots"
                      className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
                    >
                      {t('activity:sddWizard.parallelAgents')}
                    </label>
                    <input
                      id="sdd-slots"
                      type="number"
                      min={1}
                      max={16}
                      value={runSlots}
                      onChange={(e) => {
                        const n = Number.parseInt(e.target.value, 10);
                        setRunSlots(Number.isFinite(n) ? Math.min(16, Math.max(1, n)) : 1);
                      }}
                      className="w-16 rounded-md border border-border bg-background px-2 py-1 text-right text-xs outline-none focus:border-primary"
                    />
                  </div>
                  <label className="mt-2 flex cursor-pointer items-center justify-between gap-2">
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      {t('activity:sddWizard.isolateWorktrees')}
                    </span>
                    <input
                      type="checkbox"
                      checked={runWorktrees}
                      onChange={(e) => setRunWorktrees(e.target.checked)}
                      className="h-3.5 w-3.5 accent-primary"
                    />
                  </label>
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    {runWorktrees
                      ? t('activity:sddWizard.worktreeOn')
                      : t('activity:sddWizard.worktreeOff')}
                  </p>
                  <label className="mt-2 flex cursor-pointer items-center justify-between gap-2">
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      {t('activity:sddWizard.planDecompose')}
                    </span>
                    <input
                      type="checkbox"
                      checked={runPlanDecompose}
                      onChange={(e) => setRunPlanDecompose(e.target.checked)}
                      className="h-3.5 w-3.5 accent-primary"
                    />
                  </label>
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    {runPlanDecompose
                      ? t('activity:sddWizard.planDecomposeOn')
                      : t('activity:sddWizard.planDecomposeOff')}
                  </p>
                </div>
              )}
            </div>
          )}
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      </header>

      {/* Phase stepper */}
      {started && (
        <div className="flex shrink-0 items-center gap-1 border-b bg-card/50 px-4 py-1.5 text-[11px]">
          {PHASE_ORDER.map((p, i) => {
            const active = p === phase;
            const done = PHASE_ORDER.indexOf(phase) > i;
            const canRewindToThis = done && !busy && phase !== 'executing' && phase !== 'done';
            return (
              <span key={p} className="flex items-center gap-1">
                {canRewindToThis ? (
                  <button
                    type="button"
                    onClick={() => rewind(p)}
                    title={t(
                      'activity:sddWizard.rewindToPhaseTitle',
                      'Return to this phase to revise',
                    )}
                    className="inline-flex items-center rounded-full px-2 py-0.5 text-success transition hover:bg-success/10 hover:underline"
                  >
                    <Check className="mr-0.5 inline h-3 w-3" />
                    {t(`activity:sddWizard.${PHASE_LABEL[p]}`)}
                  </button>
                ) : (
                  <span
                    className={cn(
                      'rounded-full px-2 py-0.5',
                      active
                        ? 'bg-primary/15 text-primary font-medium'
                        : done
                          ? 'text-success'
                          : 'text-muted-foreground',
                    )}
                  >
                    {done && <Check className="mr-0.5 inline h-3 w-3" />}
                    {t(`activity:sddWizard.${PHASE_LABEL[p]}`)}
                  </span>
                )}
                {i < PHASE_ORDER.length - 1 && <span className="text-muted-foreground/65">→</span>}
              </span>
            );
          })}
        </div>
      )}

      <div
        ref={useScrollPosition('sdd-wizard')}
        className="min-h-0 flex-1 overflow-auto overscroll-contain p-4"
      >
        {error && (
          <div className="mb-3 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
            {error}
          </div>
        )}

        {resumed && started && (
          <div className="mb-3 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-primary">
            {t('activity:sddWizard.resumeBanner')}
          </div>
        )}

        {!started ? (
          // ── Goal entry ──
          <div className="mx-auto mt-8 max-w-xl">
            <label className="mb-2 block text-sm font-medium" htmlFor="sdd-goal">
              {t('activity:sddWizard.goalPrompt')}
            </label>
            <textarea
              id="sdd-goal"
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) startGoal();
              }}
              rows={4}
              placeholder={t('activity:sddWizard.goalPlaceholder')}
              className="w-full resize-none rounded-md border border-border bg-card px-3 py-2 text-sm outline-none focus:border-primary"
            />
            <Button className="mt-3" onClick={startGoal} disabled={!goal.trim() || submitting}>
              {submitting ? (
                <>
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />{' '}
                  {t('activity:sddWizard.startingInterview')}
                </>
              ) : (
                <>
                  <Sparkles className="mr-1.5 h-4 w-4" /> {t('activity:sddWizard.startInterview')}
                </>
              )}
            </Button>
            <p className="mt-3 text-xs text-muted-foreground">
              {t('activity:sddWizard.introBody')}
            </p>
          </div>
        ) : (
          // ── Conversation / review ──
          <div className="space-y-4">
            {/* ── Interview progress & depth bar in questioning phase ── */}
            {phase === 'questioning' && (
              <div className="rounded-md border border-border/80 bg-card/60 p-2.5 shadow-sm">
                <div className="mb-1.5 flex items-center justify-between text-xs">
                  <span className="flex items-center gap-1.5 font-medium text-foreground">
                    <Sparkles className="h-3.5 w-3.5 text-primary" />
                    {t('activity:sddWizard.interviewProgress', 'Interview Progress')}
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    {t('activity:sddWizard.questionOf', {
                      current: answeredCount + 1,
                      max: maxQuestions,
                    })}
                    {' · '}
                    {hasMetMin ? (
                      <span className="font-medium text-success">
                        {t('activity:sddWizard.minRequiredMet', 'Min met ✓')}
                      </span>
                    ) : (
                      <span>
                        {t('activity:sddWizard.minRequiredRemaining', {
                          count: minQuestions - answeredCount,
                        })}
                      </span>
                    )}
                  </span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn(
                      'h-full transition-all duration-500',
                      hasMetMin ? 'bg-success' : 'bg-primary',
                    )}
                    style={{ width: `${Math.max(12, progressPct)}%` }}
                  />
                </div>
              </div>
            )}

            {/* Decomposition reveal — the task graph as an animated DAG. */}
            {hasGraph && (
              <div className="sdd-rise overflow-hidden rounded-lg border border-primary/20 bg-[hsl(var(--surface-2)/0.85)]">
                <button
                  type="button"
                  onClick={() => setGraphOpen((o) => !o)}
                  className="flex w-full items-center gap-1.5 border-b border-border/60 px-3 py-1.5 text-[11px] font-medium text-primary hover:bg-muted/40"
                >
                  {graphOpen ? (
                    <ChevronDown className="h-3.5 w-3.5" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5" />
                  )}
                  <Network className="h-3.5 w-3.5" />
                  {t('activity:sddWizard.taskGraphSummary', { count: snapshot?.taskCount ?? 0 })}
                  <span className="ml-auto text-muted-foreground">
                    {graphOpen
                      ? t('activity:sddWizard.dragToExplore')
                      : t('activity:sddWizard.show')}
                  </span>
                </button>
                {graphOpen && (
                  <div className="h-[32dvh] min-h-[200px]">
                    <SddFlowGraph tasks={flowTasks} columns={snapshot?.board?.columns ?? []} />
                  </div>
                )}
              </div>
            )}

            {/* ── Goal block — the operator's full prompt ── */}
            {snapshot?.goal && (
              <div className="rounded-md border border-border bg-muted/30 px-3 py-2">
                <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  <Target className="h-3 w-3" /> {t('activity:sddWizard.goalLabel')}
                </div>
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
                  {snapshot.goal}
                </p>
              </div>
            )}

            {/* ── Interview transcript — full Q&A history ── */}
            {snapshot?.answers.length || (agentText && phase === 'questioning') || busy ? (
              <div className="space-y-2.5">
                {snapshot?.answers.map((qa, idx) => (
                  <div key={`${idx}-${qa.question.slice(0, 32)}`} className="space-y-2.5">
                    <ChatBubble speaker="assistant" text={qa.question} questionIndex={idx + 1} />
                    <ChatBubble speaker="user" text={qa.answer} />
                  </div>
                ))}
                {/* The current unanswered agent question */}
                {agentText && phase === 'questioning' && agentText !== lastQuestion && (
                  <ChatBubble
                    speaker="assistant"
                    text={agentText}
                    live
                    questionIndex={answeredCount + 1}
                  />
                )}
                {/* "thinking" indicator while the agent works the next turn */}
                {busy && <ChatBubble speaker="assistant" text="" thinking />}
              </div>
            ) : null}

            {/* Spec card once generated */}
            {snapshot?.spec && (
              <div className="sdd-rise rounded-md border border-border bg-card p-3">
                <div className="mb-1 flex items-center gap-1.5 text-sm font-semibold">
                  <Sparkles className="h-3.5 w-3.5 text-primary" />
                  {snapshot.spec.title}
                </div>
                <p className="mb-2 text-xs text-muted-foreground">{snapshot.spec.overview}</p>
                <ul className="space-y-0.5 text-xs">
                  {snapshot.spec.requirements.map((r, idx) => (
                    <li
                      key={`${r.priority}-${idx}-${r.description.slice(0, 24)}`}
                      className="flex gap-1.5"
                    >
                      <span
                        className={cn(
                          'shrink-0 font-mono uppercase',
                          priorityStyle(r.priority).text,
                        )}
                      >
                        {r.priority[0]}
                      </span>
                      <span>{r.description}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Implementation plan card */}
            {agentText && (phase === 'implementation' || phase === 'task_review') && (
              <div className="sdd-rise rounded-md border border-border bg-card">
                <button
                  type="button"
                  onClick={() => setPlanOpen((o) => !o)}
                  className="flex w-full items-center gap-1.5 border-b border-border/60 px-3 py-2 text-sm font-semibold hover:bg-muted/40"
                >
                  {planOpen ? (
                    <ChevronDown className="h-3.5 w-3.5" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5" />
                  )}
                  <Sparkles className="h-3.5 w-3.5 text-primary" />{' '}
                  {t('activity:sddWizard.implementationPlan')}
                </button>
                {planOpen && (
                  <div className="max-h-[40dvh] overflow-auto px-3 py-2">
                    <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
                      {stripJsonBlocks(agentText)}
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* Other review-phase narration */}
            {agentText &&
              phase !== 'questioning' &&
              phase !== 'implementation' &&
              phase !== 'task_review' &&
              !snapshot?.spec && <ChatBubble speaker="assistant" text={agentText} />}

            {/* Approve & Revise buttons for review phases */}
            {(phase === 'spec_review' || phase === 'implementation' || phase === 'task_review') && (
              <div className="flex flex-wrap items-center gap-2 pt-1">
                {phase === 'task_review' ? (
                  <Button
                    className="bg-success/15 text-success hover:bg-success/25"
                    onClick={startRun}
                    disabled={busy}
                  >
                    <Rocket className="mr-1.5 h-4 w-4" />
                    {t('activity:sddWizard.startRun', 'Start Run')}
                  </Button>
                ) : (
                  <Button variant="secondary" onClick={approve} disabled={busy}>
                    <Check className="mr-1.5 h-4 w-4" />
                    {phase === 'spec_review'
                      ? t('activity:sddWizard.approveSpec')
                      : t('activity:sddWizard.approvePlan')}
                  </Button>
                )}
                <Button
                  variant="outline"
                  onClick={() => rewind()}
                  disabled={busy}
                  className="text-xs text-muted-foreground hover:text-foreground"
                  title={
                    phase === 'spec_review'
                      ? t(
                          'activity:sddWizard.backToQuestionsTitle',
                          'Reject spec and return to questioning',
                        )
                      : t(
                          'activity:sddWizard.backToSpecTitle',
                          'Reject plan and return to spec review',
                        )
                  }
                >
                  <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                  {phase === 'spec_review'
                    ? t('activity:sddWizard.backToQuestions', 'Back to Questions')
                    : phase === 'task_review'
                      ? t('activity:sddWizard.backToSpec', 'Back to Spec')
                      : t('activity:sddWizard.backToSpec', 'Back to Spec')}
                </Button>
              </div>
            )}
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      {/* Reply input & Quick actions (during the interview) */}
      {started && phase !== 'executing' && phase !== 'done' && (
        <div className="border-t bg-card">
          {/* Quick-reply chips and directives during questioning */}
          {phase === 'questioning' && !busy && (
            <div className="flex flex-wrap items-center gap-1.5 px-4 pt-2">
              {quickReplies.map((opt) => (
                <button
                  key={opt}
                  type="button"
                  onClick={() => setReply(opt)}
                  className="inline-flex items-center rounded-full border border-primary/25 bg-primary/5 px-2.5 py-1 text-xs text-primary transition hover:bg-primary/15 hover:border-primary/40 active:scale-95"
                >
                  <span className="mr-1 opacity-70">👉</span>
                  {opt}
                </button>
              ))}

              <button
                type="button"
                onClick={() =>
                  sendDirectReply(
                    t(
                      'activity:sddWizard.quickBestPracticeDirective',
                      'Use standard industry best practices for this.',
                    ),
                  )
                }
                className="inline-flex items-center rounded-full border border-warning/30 bg-warning/10 px-2.5 py-1 text-xs text-warning transition hover:bg-warning/20 active:scale-95"
                title="Answer using standard industry best practice"
              >
                <Lightbulb className="mr-1 h-3 w-3" />
                {t('activity:sddWizard.quickBestPractice', 'Use Best Practice')}
              </button>

              {hasMetMin && (
                <button
                  type="button"
                  onClick={() =>
                    sendDirectReply(
                      'We have covered the necessary requirements. Please generate the complete specification JSON now.',
                    )
                  }
                  className="inline-flex items-center rounded-full border border-success/30 bg-success/15 px-2.5 py-1 text-xs font-medium text-success transition hover:bg-success/25 active:scale-95"
                  title={t(
                    'activity:sddWizard.generateSpecNowTitle',
                    'Generate the specification now with gathered requirements',
                  )}
                >
                  <Zap className="mr-1 h-3 w-3" />
                  {t('activity:sddWizard.generateSpecNow', 'Generate Spec Now')}
                </button>
              )}
            </div>
          )}

          <div className="flex shrink-0 items-end gap-2 px-4 py-2">
            <textarea
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  sendReply();
                }
              }}
              rows={1}
              placeholder={
                phase === 'questioning'
                  ? t('activity:sddWizard.answerPlaceholder')
                  : t('activity:sddWizard.changePlaceholder')
              }
              disabled={busy}
              className="max-h-32 flex-1 resize-none rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary disabled:opacity-50"
            />
            <Button size="icon" onClick={sendReply} disabled={busy || !reply.trim()}>
              <Send className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Strip fenced ```json … ``` blocks (the machine-readable task array) from the
 * agent's plan text so the rendered plan stays prose-only and readable.
 */
function stripJsonBlocks(text: string): string {
  const stripped = text.replace(/```json[\s\S]*?```/gi, '').trim();
  return stripped.length > 0 ? stripped : text.trim();
}

/** Extracts candidate quick-reply choices from agent question text. */
function extractQuickReplies(text: string): string[] {
  if (!text) return [];
  const results: string[] = [];

  const listMatches = text.matchAll(
    /(?:^|\n)\s*(?:[0-9]+[.)]|[A-D][.)]|[-*]\s+\*\*|[-*]\s+\[)\s*([^:\n\r]+)/gi,
  );
  for (const m of listMatches) {
    const raw = (m[1] ?? '').trim().replace(/^[`"']|[`"']$/g, '');
    if (raw && raw.length > 2 && raw.length < 50 && !results.includes(raw)) {
      results.push(raw);
    }
  }

  if (results.length === 0) {
    const inlineMatch = text.match(/(?:Options|Choices|Öneriler|Seçenekler):\s*([^\n\r]+)/i);
    if (inlineMatch?.[1]) {
      const parts = inlineMatch[1]
        .split(/[,|/]/)
        .map((p) => p.trim())
        .filter((p) => p.length > 2 && p.length < 45);
      results.push(...parts.slice(0, 4));
    }
  }

  return results.slice(0, 4);
}

/** Detects architectural topic badge from question content. */
function detectTopicBadge(text: string): { label: string; color: string } | null {
  const lower = text.toLowerCase();
  if (/security|auth|jwt|oauth|token|permission|role|rbac|şifre|güvenlik/i.test(lower)) {
    return {
      label: 'Security & Auth',
      color: 'bg-destructive/10 text-destructive border-destructive/20',
    };
  }
  if (/database|sql|postgres|sqlite|redis|mongodb|schema|tablo|veritabanı/i.test(lower)) {
    return { label: 'Data & Storage', color: 'bg-info/10 text-info border-info/20' };
  }
  if (/api|endpoint|rest|graphql|grpc|route|http/i.test(lower)) {
    return { label: 'API & Routing', color: 'bg-success/10 text-success border-success/20' };
  }
  if (/test|vitest|jest|e2e|playwright|coverage|mock/i.test(lower)) {
    return { label: 'Testing & QA', color: 'bg-warning/10 text-warning border-warning/20' };
  }
  if (/ui|css|component|frontend|react|tailwind|button|view|görsel|arayüz/i.test(lower)) {
    return { label: 'UI & Layout', color: 'bg-primary/10 text-primary border-primary/20' };
  }
  if (/architecture|microservice|queue|worker|scale|mimari/i.test(lower)) {
    return { label: 'Architecture', color: 'bg-accent/30 text-accent-foreground border-border' };
  }
  return null;
}

/** One transcript message — agent question (left) or user answer (right). */
function ChatBubble({
  speaker,
  text,
  live,
  thinking,
  questionIndex,
}: {
  speaker: 'assistant' | 'user';
  text: string;
  live?: boolean;
  thinking?: boolean;
  questionIndex?: number | undefined;
}): React.ReactElement {
  const isUser = speaker === 'user';
  const [copied, setCopied] = useState(false);
  const topicBadge = !isUser && text ? detectTopicBadge(text) : null;

  const handleCopy = () => {
    if (!text) return;
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className={cn('group sdd-rise flex items-start gap-2', isUser && 'flex-row-reverse')}>
      <span
        className={cn(
          'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs',
          isUser ? 'bg-info/15 text-info' : 'bg-primary/15 text-primary',
          (live || thinking) && 'sdd-agent-live',
        )}
      >
        {isUser ? <User className="h-3.5 w-3.5" /> : <Bot className="h-3.5 w-3.5" />}
      </span>

      <div
        className={cn(
          'relative max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed text-foreground shadow-sm transition-all',
          isUser
            ? 'rounded-tr-sm bg-info/10 border border-info/20'
            : 'rounded-tl-sm bg-muted/80 border border-border/70',
        )}
      >
        {!isUser && !thinking && (
          <div className="mb-1.5 flex items-center gap-1.5 text-[10px]">
            {questionIndex !== undefined && (
              <span className="rounded bg-primary/15 px-1.5 py-0.2 font-mono font-semibold text-primary">
                Q{questionIndex}
              </span>
            )}
            {topicBadge && (
              <span className={cn('rounded border px-1.5 py-0.2 font-medium', topicBadge.color)}>
                {topicBadge.label}
              </span>
            )}
          </div>
        )}

        {thinking ? (
          <span className="flex items-center gap-1 py-1">
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-200ms]" />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-100ms]" />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground" />
          </span>
        ) : (
          <p className="whitespace-pre-wrap">{text}</p>
        )}

        {!thinking && text && (
          <button
            type="button"
            onClick={handleCopy}
            title={copied ? 'Copied' : 'Copy'}
            className="absolute -bottom-2 right-2 hidden rounded bg-background/90 p-1 text-[10px] text-muted-foreground shadow border group-hover:flex items-center gap-1 hover:text-foreground"
          >
            {copied ? (
              <CheckCheck className="h-3 w-3 text-success" />
            ) : (
              <Copy className="h-3 w-3" />
            )}
          </button>
        )}
      </div>
    </div>
  );
}
