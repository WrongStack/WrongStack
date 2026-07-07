import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
  Network,
  Rocket,
  Send,
  SlidersHorizontal,
  Sparkles,
  Target,
  User,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useProviderModels } from '@/hooks/useProviderModels';
import { useWebSocket } from '@/hooks/useWebSocket';
import { openMainView } from '@/lib/view-navigation';
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

/**
 * SddWizard — the interactive "New SDD Project" flow. Drives the server-side
 * SddInterviewDriver over WS: goal → Q&A → spec → task graph → Start Run, then
 * hands off to the live board. Works on both webui servers (the run uses the
 * CLI's director-backed fleet or the runtime light factory respectively).
 */
export function SddWizard({ onClose }: { onClose: () => void }): React.ReactElement {
  const { t } = useAppTranslation();
  const { client } = useWebSocket();
  const snapshot = useSddWizardStore((s) => s.snapshot);
  const agentText = useSddWizardStore((s) => s.agentText);
  const error = useSddWizardStore((s) => s.error);
  const startedRunId = useSddWizardStore((s) => s.startedRunId);
  const setStartedRunId = useSddWizardStore((s) => s.setStartedRunId);

  const [goal, setGoal] = useState('');
  const [reply, setReply] = useState('');
  // Tracks the "Start Interview" click until the first snapshot lands, so the
  // goal screen gives immediate feedback instead of sitting there enabled.
  const [submitting, setSubmitting] = useState(false);
  // Collapse the (tall) decomposition graph to reclaim vertical space.
  const [graphOpen, setGraphOpen] = useState(true);
  // Collapse the implementation-plan card (can be long).
  const [planOpen, setPlanOpen] = useState(true);
  // Run config (the whole-plan default model + fallback chain), applied at Start Run.
  const [runCfgOpen, setRunCfgOpen] = useState(false);
  const [runModel, setRunModel] = useState<string | undefined>(undefined);
  const [runProvider, setRunProvider] = useState<string | undefined>(undefined);
  const [runFallbacks, setRunFallbacks] = useState<string[]>([]);
  // Parallel worker slots (how many tasks run at once) + worktree isolation.
  const [runSlots, setRunSlots] = useState(4);
  const [runWorktrees, setRunWorktrees] = useState(true);
  const modelCandidates = useProviderModels(runCfgOpen);
  const send = useCallback(
    (msg: Parameters<NonNullable<typeof client>['send']>[0]) => client?.send?.(msg),
    [client],
  );

  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    send({ type: 'sdd.spec.get' });
  }, [send]);

  // Auto-scroll the transcript to the newest message as the interview advances.
  const answerCount = snapshot?.answers.length ?? 0;
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [answerCount, agentText]);

  // When the run starts, jump to the live board to watch the agents work.
  useEffect(() => {
    if (startedRunId) {
      openMainView('sddboard');
      setStartedRunId(null);
    }
  }, [startedRunId, setStartedRunId]);

  const busy = snapshot?.busy ?? false;
  const phase = snapshot?.phase ?? 'idle';
  const started = Boolean(snapshot);

  // Clear the submit spinner once the interview session actually exists.
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
  const approve = () => !busy && send({ type: 'sdd.spec.approve', payload: {} });
  const startRun = () => {
    send({
      type: 'sdd.run.start',
      payload: {
        parallelSlots: runSlots,
        worktrees: runWorktrees,
        ...(runModel ? { model: runModel, provider: runProvider } : {}),
        ...(runFallbacks.length ? { fallbackModels: runFallbacks } : {}),
      },
    });
    setRunCfgOpen(false);
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

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-background">
      <header className="sdd-sheen flex shrink-0 items-center justify-between border-b border-border px-4 py-2">
        <div className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-primary" />
          <div>
            <h1 className="text-lg font-semibold">{snapshot?.title || t('activity:sddWizard.titleFallback')}</h1>
            {started && (
              <p className="text-xs text-muted-foreground">
                {t(`activity:sddWizard.${PHASE_LABEL[phase] ?? 'phaseStart'}`)}
                {phase === 'questioning' &&
                  ` · ${t('activity:sddWizard.questionsSuffix', { cur: snapshot?.questionCount ?? 0, max: snapshot?.maxQuestions ?? 0 })}`}
                {snapshot && snapshot.taskCount > 0 ? ` · ${t('activity:sddWizard.tasksSuffix', { count: snapshot.taskCount })}` : ''}
              </p>
            )}
          </div>
          {busy && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
        </div>
        <div className="flex items-center gap-2">
          {canRun && (
            <div className="relative flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setRunCfgOpen((o) => !o)}
                title={t('activity:sddWizard.runCfgTitle')}
                className={cn(
                  'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium',
                  runModel || runFallbacks.length
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
                    <label htmlFor="sdd-slots" className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
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
            return (
              <span key={p} className="flex items-center gap-1">
                <span
                  className={cn(
                    'rounded-full px-2 py-0.5',
                    active
                      ? 'bg-primary/15 text-primary'
                      : done
                        ? 'text-success'
                        : 'text-muted-foreground',
                  )}
                >
                  {done && <Check className="mr-0.5 inline h-3 w-3" />}
                  {t(`activity:sddWizard.${PHASE_LABEL[p]}`)}
                </span>
                {i < PHASE_ORDER.length - 1 && <span className="text-muted-foreground/40">→</span>}
              </span>
            );
          })}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {error && (
          <div className="mb-3 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
            {error}
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
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> {t('activity:sddWizard.startingInterview')}
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
            {/* Decomposition reveal — the task graph as an animated DAG.
                Collapsible + capped height so it never crowds out the transcript. */}
            {hasGraph && (
              <div className="sdd-rise overflow-hidden rounded-lg border border-primary/20 bg-[hsl(var(--surface-2)/0.85)]">
                <button
                  type="button"
                  onClick={() => setGraphOpen((o) => !o)}
                  className="flex w-full items-center gap-1.5 border-b border-border/60 px-3 py-1.5 text-[11px] font-medium text-primary hover:bg-muted/40"
                >
                  {graphOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                  <Network className="h-3.5 w-3.5" />
                  {t('activity:sddWizard.taskGraphSummary', { count: snapshot?.taskCount ?? 0 })}
                  <span className="ml-auto text-muted-foreground">{graphOpen ? t('activity:sddWizard.dragToExplore') : t('activity:sddWizard.show')}</span>
                </button>
                {graphOpen && (
                  <div className="h-[32dvh] min-h-[200px]">
                    <SddFlowGraph tasks={flowTasks} columns={snapshot?.board?.columns ?? []} />
                  </div>
                )}
              </div>
            )}

            <div className="mx-auto max-w-2xl space-y-3">
              {/* ── Goal block — the operator's full prompt, leading the flow
                  (the header title is only a short heading). ── */}
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
                  {snapshot?.answers.map((qa, i) => (
                    <div key={i} className="space-y-2.5">
                      <ChatBubble role="assistant" text={qa.question} />
                      <ChatBubble role="user" text={qa.answer} />
                    </div>
                  ))}
                  {/* The current unanswered agent question. Hidden while it still
                      equals the just-answered question (the next turn is in
                      flight) so it never duplicates the last transcript entry. */}
                  {agentText && phase === 'questioning' && agentText !== lastQuestion && (
                    <ChatBubble role="assistant" text={agentText} />
                  )}
                  {/* "thinking" indicator while the agent works the next turn. */}
                  {busy && <ChatBubble role="assistant" text="" thinking />}
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
                    {snapshot.spec.requirements.map((r, i) => (
                      <li key={i} className="flex gap-1.5">
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

              {/* Implementation plan — rendered as a readable, collapsible card
                  (raw task JSON stripped) instead of a wall-of-text bubble. */}
              {agentText && (phase === 'implementation' || phase === 'task_review') && (
                <div className="sdd-rise rounded-md border border-border bg-card">
                  <button
                    type="button"
                    onClick={() => setPlanOpen((o) => !o)}
                    className="flex w-full items-center gap-1.5 border-b border-border/60 px-3 py-2 text-sm font-semibold hover:bg-muted/40"
                  >
                    {planOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                    <Sparkles className="h-3.5 w-3.5 text-primary" /> {t('activity:sddWizard.implementationPlan')}
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

              {/* Other review-phase narration (e.g. spec_review feedback before the
                  spec card parses). */}
              {agentText &&
                phase !== 'questioning' &&
                phase !== 'implementation' &&
                phase !== 'task_review' &&
                !snapshot?.spec && <ChatBubble role="assistant" text={agentText} />}

              {/* Approve button for review phases */}
              {(phase === 'spec_review' ||
                phase === 'implementation' ||
                phase === 'task_review') && (
                <Button variant="secondary" onClick={approve} disabled={busy}>
                  <Check className="mr-1.5 h-4 w-4" />
                  {phase === 'spec_review'
                    ? t('activity:sddWizard.approveSpec')
                    : phase === 'task_review'
                      ? t('activity:sddWizard.approveTasks')
                      : t('activity:sddWizard.approvePlan')}
                </Button>
              )}
              <div ref={bottomRef} />
            </div>
          </div>
        )}
      </div>

      {/* Reply input (during the interview) */}
      {started && phase !== 'executing' && phase !== 'done' && (
        <div className="flex shrink-0 items-end gap-2 border-t bg-card px-4 py-2">
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
            placeholder={phase === 'questioning' ? t('activity:sddWizard.answerPlaceholder') : t('activity:sddWizard.changePlaceholder')}
            disabled={busy}
            className="max-h-32 flex-1 resize-none rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary disabled:opacity-50"
          />
          <Button size="icon" onClick={sendReply} disabled={busy || !reply.trim()}>
            <Send className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * Strip fenced ```json … ``` blocks (the machine-readable task array) from the
 * agent's plan text so the rendered plan stays prose-only and readable. Falls
 * back to the original text if stripping would leave it empty.
 */
function stripJsonBlocks(text: string): string {
  const stripped = text.replace(/```json[\s\S]*?```/gi, '').trim();
  return stripped.length > 0 ? stripped : text.trim();
}

/** One transcript message — agent question (left) or the user's answer (right). */
function ChatBubble({
  role,
  text,
  live,
  thinking,
}: {
  role: 'assistant' | 'user';
  text: string;
  live?: boolean;
  thinking?: boolean;
}): React.ReactElement {
  const isUser = role === 'user';
  return (
    <div className={cn('sdd-rise flex items-start gap-2', isUser && 'flex-row-reverse')}>
      <span
        className={cn(
          'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full',
          isUser
            ? 'bg-info/15 text-info'
            : 'bg-primary/15 text-primary',
          (live || thinking) && 'sdd-agent-live',
        )}
      >
        {isUser ? <User className="h-3.5 w-3.5" /> : <Bot className="h-3.5 w-3.5" />}
      </span>
      <div
        className={cn(
          'max-w-[80%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm leading-relaxed text-foreground',
          isUser ? 'rounded-tr-sm bg-info/10' : 'rounded-tl-sm bg-muted',
        )}
      >
        {thinking ? (
          <span className="flex items-center gap-1 py-0.5">
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-200ms]" />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-100ms]" />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground" />
          </span>
        ) : (
          text
        )}
      </div>
    </div>
  );
}
