import {
  ArrowLeft,
  CheckCircle2,
  Flag,
  LoaderCircle,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Square,
  Target,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import type { EngineSend } from './engine-operations';
import { type EngineState, entries, record } from './engine-state';
import { GoalPhaseVerification } from './GoalPhaseVerification';
import { GoalRevert } from './GoalRevert';
import { matchingGoalAssessment } from './goal-assessment';
import { type GoalBudgetWords, goalBudgetPayload, goalBudgetText } from './goal-budget-model';
import type { RunFocus } from './kanban-board-source';
import { ProjectMission } from './ProjectMission';
import './project-goals.css';

const label = (value: unknown, fallback = '—') =>
  typeof value === 'string' && value ? value : fallback;
const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const reportedCount = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? String(value) : '—';
const statusText = (value: unknown) => label(value).replaceAll('_', ' ');
let assessmentSequence = Date.now();
/** Engine requests the page sends, each with its own waiting notice. */
type RequestKind =
  | 'refresh'
  | 'pause'
  | 'resume'
  | 'stop'
  | 'addTask'
  | 'statusChange'
  | 'retry'
  | 'assignment'
  | 'moveTask';

/** A project-owned view over the engine's Goal catalog and per-goal state. */
export function ProjectGoals({
  state,
  send,
  onKanban,
  initialGoalId = '',
}: {
  state: EngineState;
  send: EngineSend;
  /** Opens Kanban; with a focus, on the board that mirrors that goal's run. */
  onKanban: (focus?: RunFocus) => void;
  /** Goal to select when the page opens, e.g. from its mirror board. */
  initialGoalId?: string | undefined;
}) {
  const { t } = useDesktopText();
  // Engine words (statuses) are named per language; unknown ones read as before.
  const named = (value: unknown) => {
    const raw = label(value);
    return raw === '—' ? raw : t(`goals.status.${raw}`, { defaultValue: statusText(raw) });
  };
  const budgetWords: GoalBudgetWords = {
    tasks: (used, max) => t('goals.budget.tasks', { used, max }),
    minutes: (used, max) => t('goals.budget.minutes', { used, max }),
    tokens: (used, max) => t('goals.budget.tokens', { used, max }),
    cost: (used, max, unpriced) =>
      unpriced > 0
        ? t('goals.budget.costUnpriced', { used, max, n: unpriced })
        : t('goals.budget.cost', { used, max }),
    budget: (parts) => t('goals.budget.line', { parts }),
    invalid: (limit, max) => t(`goals.limitError.${limit}`, { max }),
  };
  // The refresh notice clears when the catalog arrives; other notices wait for their goal.
  const refreshing = useRef(false);
  const [selected, setSelected] = useState(initialGoalId);
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [pendingStart, setPendingStart] = useState('');
  const [assessment, setAssessment] = useState<Record<string, unknown> | null>(null);
  const [assessing, setAssessing] = useState(false);
  const assessmentRequest = useRef(0);
  const [verify, setVerify] = useState(true);
  const [multiBoard, setMultiBoard] = useState(false);
  const [review, setReview] = useState(false);
  const [isolate, setIsolate] = useState(false);
  // Optional limits: tasks started, active run time and provider tokens, checked before each task.
  const [budgetTasks, setBudgetTasks] = useState(''),
    [budgetMinutes, setBudgetMinutes] = useState(''),
    [budgetTokens, setBudgetTokens] = useState(''),
    [resumeTasks, setResumeTasks] = useState(''),
    [resumeMinutes, setResumeMinutes] = useState(''),
    [resumeTokens, setResumeTokens] = useState(''),
    [budgetCost, setBudgetCost] = useState(''),
    [resumeCost, setResumeCost] = useState('');
  const [action, setAction] = useState('');
  const [error, setError] = useState('');
  const [stopConfirm, setStopConfirm] = useState(false);
  const [selectedTask, setSelectedTask] = useState('');
  const [newTasks, setNewTasks] = useState<Record<string, string>>({});
  const [agentName, setAgentName] = useState('');
  const [destination, setDestination] = useState('');
  const [confirmMove, setConfirmMove] = useState(false);
  const catalog = record(state.results['goal.list']);
  const summaries = entries(catalog['goals']);
  const graphs = entries(catalog['graphs']);
  const goals = (summaries.length ? summaries : graphs).filter(
    (item) => typeof item['id'] === 'string' && item['id'],
  );
  const visible = useMemo(
    () =>
      goals.filter((goal) =>
        `${label(goal['title'], '')} ${label(goal['id'], '')}`
          .toLowerCase()
          .includes(query.toLowerCase()),
      ),
    [goals, query],
  );
  const goal = selected ? state.goalStates[selected] : undefined;
  const summary = goals.find((item) => item['id'] === selected);
  const goalError = selected ? state.goalErrors[selected] : undefined;
  const phases = entries(goal?.['phases']);
  const task = phases
    .flatMap((phase) =>
      entries(phase['tasks']).map<Record<string, unknown>>((item) => ({
        ...item,
        phaseId: phase['id'],
        phaseName: phase['name'],
      })),
    )
    .find((item) => item['id'] === selectedTask);
  const readOnly = goal?.['readOnly'] === true;
  const status = label(goal?.['status'] ?? summary?.['status'], 'unknown');
  const liveBoard = !readOnly && ['running', 'paused'].includes(status);
  const sendRequest = async (type: string, payload: Record<string, unknown>, kind: RequestKind) => {
    setError('');
    refreshing.current = kind === 'refresh';
    setAction(t(`goals.requested.${kind}`));
    try {
      await send(type, payload);
    } catch (e) {
      setAction('');
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  useEffect(() => {
    void send('goal.list').catch((e) => setError(String(e)));
  }, [send]);
  useEffect(() => {
    if (!selected) return;
    setSelectedTask('');
    setStopConfirm(false);
    if (selected !== pendingStart) {
      setAction('');
      void send('goal.status', { goalId: selected }).catch((e) => setError(String(e)));
    }
  }, [selected, send, pendingStart]);
  useEffect(() => {
    if (goal && (selected !== pendingStart || goal['graphId'])) {
      setAction('');
      if (selected === pendingStart && goal['graphId']) {
        setTitle('');
        setPendingStart('');
      }
    }
  }, [goal, pendingStart, selected]);
  useEffect(() => {
    if (state.results['goal.list'] && refreshing.current) {
      refreshing.current = false;
      setAction('');
    }
  }, [state.results['goal.list']]);
  useEffect(() => {
    if (goalError) {
      setError(label(goalError['message'], t('goals.refused')));
      setAction('');
    }
  }, [goalError]);
  useEffect(() => {
    const result = matchingGoalAssessment(
      state.results['goal.assess.result'],
      assessmentRequest.current,
    );
    if (!result) return;
    assessmentRequest.current = 0;
    setAssessing(false);
    setAssessment(result);
  }, [state.results['goal.assess.result']]);
  useEffect(() => {
    setAgentName(typeof task?.['assignee'] === 'string' ? task['assignee'] : '');
    setDestination('');
    setConfirmMove(false);
  }, [selectedTask]);
  const assess = async () => {
    const goal = title.trim();
    if (!goal || assessing) return;
    const seq = ++assessmentSequence;
    assessmentRequest.current = seq;
    setAssessment(null);
    setAssessing(true);
    setError('');
    try {
      await send('goal.assess', { goal, seq });
    } catch (e) {
      if (assessmentRequest.current === seq) {
        assessmentRequest.current = 0;
        setAssessing(false);
        setError(e instanceof Error ? e.message : String(e));
      }
    }
  };
  const start = async () => {
    if (!title.trim()) return;
    let budget: ReturnType<typeof goalBudgetPayload>;
    try {
      budget = goalBudgetPayload(budgetTasks, budgetMinutes, budgetTokens, budgetCost, budgetWords);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    assessmentRequest.current = 0;
    setAssessing(false);
    setAssessment(null);
    const id = crypto.randomUUID();
    setError('');
    setPendingStart(id);
    setSelected(id);
    setCreating(false);
    refreshing.current = false;
    setAction(t('goals.submitted'));
    try {
      await send('goal.start', {
        goalId: id,
        title: title.trim(),
        autonomous: true,
        worktrees: isolate,
        multiBoard,
        verifyTasks: verify,
        chimeraReview: review,
        ...(budget ? { budget } : {}),
      });
    } catch (e) {
      setAction('');
      setPendingStart('');
      setCreating(true);
      setSelected('');
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <section className="project-goals" aria-label={t('goals.label')}>
      <header className="studio-heading">
        <div>
          <h1>{t('goals.title')}</h1>
          <p>{t('goals.intro')}</p>
        </div>
        <div className="goal-header-actions">
          <button
            type="button"
            className="button secondary"
            onClick={() => {
              void sendRequest('goal.list', {}, 'refresh');
              void send('goal-state.get').catch((e) => setError(String(e)));
            }}
          >
            <RefreshCw size={14} /> {t('goals.refresh')}
          </button>
          <button
            type="button"
            className="button primary"
            onClick={() => {
              setCreating(true);
              setSelected('');
            }}
          >
            <Plus size={14} /> {t('goals.new')}
          </button>
        </div>
      </header>
      {error && (
        <div className="session-error" role="alert">
          <p>{error}</p>
          {pendingStart && selected === pendingStart && (
            <button
              type="button"
              onClick={() => {
                setSelected('');
                setPendingStart('');
                setCreating(true);
                setError('');
              }}
            >
              {t('goals.returnDraft')}
            </button>
          )}
        </div>
      )}
      {action && (
        <p className="goal-request" role="status">
          <LoaderCircle size={14} className="spin" /> {action}
        </p>
      )}
      {creating ? (
        <section className="goal-create">
          <button type="button" className="goal-back" onClick={() => setCreating(false)}>
            <ArrowLeft size={14} /> {t('goals.allGoals')}
          </button>
          <h2>{t('goals.createTitle')}</h2>
          <p>{t('goals.createIntro')}</p>
          <label>
            {t('goals.goal')}
            <textarea
              aria-label={t('goals.goal')}
              value={title}
              onChange={(event) => {
                setTitle(event.target.value);
                assessmentRequest.current = 0;
                setAssessing(false);
                setAssessment(null);
              }}
              placeholder={t('goals.goalPlaceholder')}
            />
          </label>
          <div className="goal-assessment">
            <div>
              <strong>{t('goals.feasibility')}</strong>
              <p>{t('goals.feasibilityHelp')}</p>
            </div>
            <button
              type="button"
              className="button secondary"
              disabled={!title.trim() || assessing}
              onClick={() => void assess()}
            >
              {assessing ? t('goals.assessing') : t('goals.assess')}
            </button>
          </div>
          {assessment && (
            <div className="goal-assessment-result" role="status">
              {assessment['parseFailed'] === true ? (
                <>
                  <strong>{t('goals.unavailable')}</strong>
                  <p>{label(assessment['parseError'], t('goals.noAssessment'))}</p>
                </>
              ) : (
                <>
                  <strong>
                    {assessment['realistic'] === true
                      ? t('goals.feasible')
                      : assessment['realistic'] === false
                        ? t('goals.reviewScope')
                        : t('goals.assessment')}
                  </strong>
                  {typeof assessment['explanation'] === 'string' && assessment['explanation'] && (
                    <p>{assessment['explanation']}</p>
                  )}
                  {typeof assessment['durationClaimed'] === 'string' && (
                    <p>
                      {t('goals.requestedDuration', { duration: assessment['durationClaimed'] })}
                    </p>
                  )}
                  {typeof assessment['recommendedDuration'] === 'string' && (
                    <p>
                      {t('goals.suggestedDuration', {
                        duration: assessment['recommendedDuration'],
                      })}
                    </p>
                  )}
                  {Array.isArray(assessment['concerns']) &&
                    assessment['concerns'].some((item) => typeof item === 'string') && (
                      <ul>
                        {assessment['concerns']
                          .filter((item): item is string => typeof item === 'string')
                          .map((item, index) => (
                            <li key={`${index}-${item}`}>{item}</li>
                          ))}
                      </ul>
                    )}
                </>
              )}
            </div>
          )}
          <div className="goal-options">
            <label>
              <input
                type="checkbox"
                checked={verify}
                onChange={(e) => setVerify(e.target.checked)}
              />{' '}
              {t('goals.verifyTasks')}
            </label>
            <label>
              <input
                type="checkbox"
                checked={multiBoard}
                onChange={(e) => setMultiBoard(e.target.checked)}
              />{' '}
              {t('goals.multiBoard')}
            </label>
            <label>
              <input
                type="checkbox"
                checked={review}
                onChange={(e) => setReview(e.target.checked)}
              />{' '}
              {t('goals.chimera')}
            </label>
            <label>
              <input
                type="checkbox"
                checked={isolate}
                onChange={(e) => setIsolate(e.target.checked)}
              />{' '}
              {t('goals.isolate')}
            </label>
            <label>
              {t('goals.taskLimit')}
              <input
                type="number"
                min={1}
                step={1}
                inputMode="numeric"
                value={budgetTasks}
                placeholder={t('goals.noLimit')}
                onChange={(e) => setBudgetTasks(e.target.value)}
              />
            </label>
            <label>
              {t('goals.minutesLimit')}
              <input
                type="number"
                min={1}
                inputMode="decimal"
                value={budgetMinutes}
                placeholder={t('goals.noLimit')}
                onChange={(e) => setBudgetMinutes(e.target.value)}
              />
            </label>
            <label title={t('goals.tokenHelp')}>
              {t('goals.tokenLimit')}
              <input
                type="number"
                min={1}
                step={1}
                inputMode="numeric"
                value={budgetTokens}
                placeholder={t('goals.noLimit')}
                onChange={(e) => setBudgetTokens(e.target.value)}
              />
            </label>
            <label title={t('goals.costHelp')}>
              {t('goals.costLimit')}
              <input
                type="number"
                min={0.01}
                step={0.01}
                inputMode="decimal"
                value={budgetCost}
                placeholder={t('goals.noLimit')}
                onChange={(e) => setBudgetCost(e.target.value)}
              />
            </label>
          </div>
          <div className="goal-create-actions">
            <button type="button" className="button secondary" onClick={() => setCreating(false)}>
              {t('goals.cancel')}
            </button>
            <button
              type="button"
              className="button primary"
              disabled={!title.trim()}
              onClick={() => void start()}
            >
              <Target size={14} /> {t('goals.start')}
            </button>
          </div>
        </section>
      ) : selected ? (
        <>
          <button
            type="button"
            className="goal-back"
            onClick={() => {
              setSelected('');
              setError('');
            }}
          >
            <ArrowLeft size={14} /> {t('goals.allGoals')}
          </button>
          <div className="goal-detail-head">
            <div>
              <span className="eyebrow">{t('goals.eyebrow')}</span>
              <h2>{label(goal?.['title'] ?? summary?.['title'], t('goals.goal'))}</h2>
              <p>{label(goal?.['goal'], '')}</p>
              <div className="goal-chips">
                <span>{named(status)}</span>
                <span>{readOnly ? t('goals.otherOwner') : t('goals.projectEngine')}</span>
                {goal?.['verifyTasks'] === true && <span>{t('goals.taskVerification')}</span>}
                {goal?.['multiBoard'] === true && <span>{t('goals.multipleBoards')}</span>}
                {goalBudgetText(goal?.['budget'], goal?.['budgetUsage'], budgetWords) && (
                  <span>
                    {goalBudgetText(goal?.['budget'], goal?.['budgetUsage'], budgetWords)}
                  </span>
                )}
              </div>
            </div>
            <div className="goal-controls">
              {status === 'running' && (
                <button
                  type="button"
                  className="button secondary"
                  disabled={readOnly}
                  onClick={() => void sendRequest('goal.pause', { goalId: selected }, 'pause')}
                >
                  <Pause size={14} /> {t('goals.pause')}
                </button>
              )}
              {['stopped', 'failed'].includes(status) && !readOnly && (
                // New limits replace the saved budget when the run resumes; blank keeps it.
                <details className="goal-resume-budget">
                  <summary>{t('goals.resumeLimits')}</summary>
                  <input
                    type="number"
                    min={1}
                    step={1}
                    aria-label={t('goals.resumeTasksLabel')}
                    placeholder={t('goals.taskLimit')}
                    value={resumeTasks}
                    onChange={(e) => setResumeTasks(e.target.value)}
                  />
                  <input
                    type="number"
                    min={1}
                    aria-label={t('goals.resumeMinutesLabel')}
                    placeholder={t('goals.minutesPlaceholder')}
                    value={resumeMinutes}
                    onChange={(e) => setResumeMinutes(e.target.value)}
                  />
                  <input
                    type="number"
                    min={1}
                    step={1}
                    aria-label={t('goals.resumeTokensLabel')}
                    placeholder={t('goals.tokensPlaceholder')}
                    value={resumeTokens}
                    onChange={(e) => setResumeTokens(e.target.value)}
                  />
                  <input
                    type="number"
                    min={0.01}
                    step={0.01}
                    aria-label={t('goals.resumeCostLabel')}
                    placeholder="USD"
                    value={resumeCost}
                    onChange={(e) => setResumeCost(e.target.value)}
                  />
                </details>
              )}
              {['paused', 'stopped', 'failed'].includes(status) && (
                <button
                  type="button"
                  className="button secondary"
                  disabled={readOnly}
                  onClick={() => {
                    let budget: ReturnType<typeof goalBudgetPayload>;
                    try {
                      budget =
                        status === 'paused'
                          ? undefined
                          : goalBudgetPayload(
                              resumeTasks,
                              resumeMinutes,
                              resumeTokens,
                              resumeCost,
                              budgetWords,
                            );
                    } catch (e) {
                      setError(e instanceof Error ? e.message : String(e));
                      return;
                    }
                    void sendRequest(
                      'goal.resume',
                      { goalId: selected, ...(budget ? { budget } : {}) },
                      'resume',
                    );
                  }}
                >
                  <Play size={14} /> {t('goals.resume')}
                </button>
              )}
              {['running', 'paused'].includes(status) &&
                (stopConfirm ? (
                  <>
                    <span>{t('goals.stopAsk')}</span>
                    <button
                      type="button"
                      className="button secondary"
                      onClick={() => {
                        setStopConfirm(false);
                        void sendRequest('goal.stop', { goalId: selected }, 'stop');
                      }}
                    >
                      {t('goals.confirmStop')}
                    </button>
                    <button type="button" onClick={() => setStopConfirm(false)}>
                      {t('goals.cancel')}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="button secondary"
                    disabled={readOnly}
                    onClick={() => setStopConfirm(true)}
                  >
                    <Square size={14} /> {t('goals.stop')}
                  </button>
                ))}
              {selected && (
                <GoalRevert
                  key={selected}
                  goalId={selected}
                  goal={goal}
                  state={state}
                  send={send}
                  readOnly={readOnly}
                />
              )}
              <button
                type="button"
                className="button secondary"
                title={selected ? t('goals.boardHelp') : undefined}
                onClick={() =>
                  onKanban(
                    selected
                      ? {
                          system: 'goal',
                          runId: selected,
                          phaseId: phases.find((phase) => phase['status'] === 'running')?.['id'] as
                            | string
                            | undefined,
                        }
                      : undefined,
                  )
                }
              >
                {selected ? t('goals.openBoard') : t('goals.openKanban')}
              </button>
            </div>
          </div>
          {!goal ? (
            <div className="goal-empty">
              {!goalError && <LoaderCircle size={22} className="spin" />}
              <p>{goalError ? t('goals.notLoaded') : t('goals.waiting')}</p>
              {selected === pendingStart && (
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => {
                    setSelected('');
                    setPendingStart('');
                    setCreating(true);
                  }}
                >
                  {t('goals.returnDraft')}
                </button>
              )}
            </div>
          ) : (
            <>
              <div className="goal-metrics">
                <div>
                  <strong>
                    {reportedCount(record(goal['progress'])['completed'])} /{' '}
                    {reportedCount(record(goal['progress'])['totalPhases'])}
                  </strong>
                  <span>{t('goals.phasesComplete')}</span>
                </div>
                <div>
                  <strong>
                    {reportedCount(record(goal['progress'])['completedTasks'])} /{' '}
                    {reportedCount(record(goal['progress'])['totalTasks'])}
                  </strong>
                  <span>{t('goals.tasksComplete')}</span>
                </div>
                <div>
                  <strong>
                    {typeof goal['overallPercent'] === 'number'
                      ? `${goal['overallPercent']}%`
                      : '—'}
                  </strong>
                  <span>{t('goals.phaseProgress')}</span>
                </div>
                <div>
                  <strong>
                    {record(goal['finalVerification'])['skipped'] === true
                      ? t('goals.skipped')
                      : named(record(goal['finalVerification'])['status'] ?? 'not_run')}
                  </strong>
                  <span>{t('goals.finalVerification')}</span>
                </div>
              </div>
              {typeof goal['lastError'] === 'string' && goal['lastError'] && (
                <p className="session-error">{goal['lastError']}</p>
              )}
              <div className="goal-workspace">
                <div className="goal-phase-list">
                  <header>
                    <Flag size={15} />
                    <strong>{t('goals.phasesAndTasks')}</strong>
                    <span>{t('goals.phaseCount', { n: phases.length })}</span>
                  </header>
                  {phases.map((phase) => (
                    <article key={String(phase['id'])} className="goal-phase">
                      <div className="goal-phase-head">
                        <div>
                          <strong>{label(phase['name'], t('goals.phase'))}</strong>
                          <p>{label(phase['description'], '')}</p>
                        </div>
                        <span>{named(phase['status'])}</span>
                      </div>
                      <div className="goal-phase-progress">
                        <span
                          style={{
                            width: `${Math.max(0, Math.min(100, count(phase['progressPercent'])))}%`,
                          }}
                        />
                      </div>
                      <small>
                        {t('goals.taskCount', {
                          done: reportedCount(phase['completedTasks']),
                          total: reportedCount(phase['taskCount']),
                        })}
                        {typeof phase['priority'] === 'string' &&
                          phase['priority'] &&
                          ` · ${t('goals.priorityLine', {
                            priority: t(`goals.priority.${phase['priority']}`, {
                              defaultValue: phase['priority'],
                            }),
                          })}`}
                      </small>
                      <GoalPhaseVerification phase={phase} />
                      <div className="goal-tasks">
                        {entries(phase['tasks']).map((item) => (
                          <button
                            type="button"
                            key={String(item['id'])}
                            aria-pressed={selectedTask === item['id']}
                            onClick={() => setSelectedTask(String(item['id']))}
                          >
                            <CheckCircle2 size={14} />
                            <span>{label(item['title'], t('goals.task'))}</span>
                            <small>{named(item['status'])}</small>
                          </button>
                        ))}
                      </div>
                      {liveBoard && (
                        <form
                          onSubmit={(event) => {
                            event.preventDefault();
                            const phaseId = String(phase['id']);
                            const newTask = newTasks[phaseId] ?? '';
                            if (!newTask.trim()) return;
                            void sendRequest(
                              'goal.addTask',
                              { goalId: selected, phaseId: phase['id'], title: newTask.trim() },
                              'addTask',
                            );
                          }}
                        >
                          <input
                            aria-label={t('goals.newTaskFor', {
                              phase: label(phase['name'], t('goals.phaseLower')),
                            })}
                            value={newTasks[String(phase['id'])] ?? ''}
                            onChange={(event) =>
                              setNewTasks((current) => ({
                                ...current,
                                [String(phase['id'])]: event.target.value,
                              }))
                            }
                            placeholder={t('goals.addTaskPlaceholder')}
                          />
                          <button
                            type="submit"
                            disabled={
                              !(newTasks[String(phase['id'])] ?? '').trim() || Boolean(action)
                            }
                          >
                            {t('goals.add')}
                          </button>
                        </form>
                      )}
                    </article>
                  ))}
                  {!phases.length && <p className="goal-empty">{t('goals.noPhases')}</p>}
                </div>
                <aside className="goal-inspector">
                  {task ? (
                    <>
                      <span className="eyebrow">{t('goals.taskDetails')}</span>
                      <h3>{label(task['title'], t('goals.task'))}</h3>
                      <p>{label(task['description'], t('goals.noDescription'))}</p>
                      <dl>
                        {(
                          [
                            ['phase', task['phaseName']],
                            ['status', task['status']],
                            ['priority', task['priority']],
                            ['type', task['type']],
                            ['assignee', task['assignee']],
                            ['estimateHours', task['estimateHours']],
                            ['actualHours', task['actualHours']],
                          ] as const
                        ).map(([name, value]) => (
                          <div key={name}>
                            <dt>{t(`goals.field.${name}`)}</dt>
                            <dd>
                              {typeof value === 'number'
                                ? value
                                : name === 'status'
                                  ? named(value)
                                  : name === 'priority' && typeof value === 'string' && value
                                    ? t(`goals.priority.${value}`, { defaultValue: value })
                                    : statusText(value)}
                            </dd>
                          </div>
                        ))}
                      </dl>
                      {Array.isArray(task['tags']) && task['tags'].length > 0 && (
                        <p>
                          {t('goals.tags', {
                            tags: task['tags'].filter((tag) => typeof tag === 'string').join(', '),
                          })}
                        </p>
                      )}
                      {!readOnly && (
                        <>
                          <label>
                            {t('goals.changeStatus')}
                            <select
                              value={label(task['status'], 'pending')}
                              onChange={(e) =>
                                void sendRequest(
                                  'goal.taskStatus',
                                  { goalId: selected, taskId: task['id'], status: e.target.value },
                                  'statusChange',
                                )
                              }
                            >
                              {[
                                'pending',
                                'in_progress',
                                'blocked',
                                'failed',
                                'review',
                                'completed',
                              ].map((value) => (
                                <option key={value} value={value}>
                                  {t(`goals.status.${value}`)}
                                </option>
                              ))}
                            </select>
                          </label>
                          {['failed', 'blocked'].includes(String(task['status'])) && (
                            <button
                              type="button"
                              className="button secondary"
                              onClick={() =>
                                void sendRequest(
                                  'goal.retryTask',
                                  { goalId: selected, taskId: task['id'] },
                                  'retry',
                                )
                              }
                            >
                              {t('goals.retryTask')}
                            </button>
                          )}
                          {liveBoard && (
                            <div className="goal-task-actions">
                              <form
                                onSubmit={(event) => {
                                  event.preventDefault();
                                  void sendRequest(
                                    'goal.assignTask',
                                    {
                                      goalId: selected,
                                      taskId: task['id'],
                                      ...(agentName.trim() ? { agentName: agentName.trim() } : {}),
                                    },
                                    'assignment',
                                  );
                                }}
                              >
                                <label>
                                  {t('goals.assignAgent')}
                                  <input
                                    value={agentName}
                                    onChange={(event) => setAgentName(event.target.value)}
                                    placeholder={t('goals.agentPlaceholder')}
                                  />
                                </label>
                                <button
                                  type="submit"
                                  className="button secondary"
                                  disabled={Boolean(action)}
                                >
                                  {t('goals.updateAssignment')}
                                </button>
                              </form>
                              {phases.length > 1 && (
                                <form
                                  onSubmit={(event) => {
                                    event.preventDefault();
                                    if (destination) setConfirmMove(true);
                                  }}
                                >
                                  <label>
                                    {t('goals.moveToPhase')}
                                    <select
                                      value={destination}
                                      onChange={(event) => {
                                        setDestination(event.target.value);
                                        setConfirmMove(false);
                                      }}
                                    >
                                      <option value="">{t('goals.selectDestination')}</option>
                                      {phases
                                        .filter(
                                          (phase) =>
                                            typeof phase['id'] === 'string' &&
                                            phase['id'] !== task['phaseId'],
                                        )
                                        .map((phase) => (
                                          <option
                                            key={String(phase['id'])}
                                            value={String(phase['id'])}
                                          >
                                            {label(phase['name'], t('goals.phase'))}
                                          </option>
                                        ))}
                                    </select>
                                  </label>
                                  {confirmMove ? (
                                    <>
                                      <p>{t('goals.moveWarning')}</p>
                                      <button
                                        type="button"
                                        className="button secondary"
                                        disabled={Boolean(action)}
                                        onClick={() => {
                                          setConfirmMove(false);
                                          void sendRequest(
                                            'goal.moveTask',
                                            {
                                              goalId: selected,
                                              taskId: task['id'],
                                              toPhaseId: destination,
                                            },
                                            'moveTask',
                                          );
                                        }}
                                      >
                                        {t('goals.confirmMove')}
                                      </button>
                                      <button type="button" onClick={() => setConfirmMove(false)}>
                                        {t('goals.cancel')}
                                      </button>
                                    </>
                                  ) : (
                                    <button
                                      type="submit"
                                      className="button secondary"
                                      disabled={!destination || Boolean(action)}
                                    >
                                      {t('goals.moveTask')}
                                    </button>
                                  )}
                                </form>
                              )}
                            </div>
                          )}
                        </>
                      )}
                    </>
                  ) : (
                    <>
                      <Target size={25} />
                      <h3>{t('goals.inspectTitle')}</h3>
                      <p>{t('goals.inspectHelp')}</p>
                    </>
                  )}
                </aside>
              </div>
            </>
          )}
        </>
      ) : (
        <>
          <ProjectMission state={state} send={send} />
          <div className="goal-catalog-header">
            <div>
              <h2>{t('goals.executionGoals')}</h2>
              <p>{t('goals.recordedRuns', { n: goals.length })}</p>
            </div>
            <label>
              <span className="sr-only">{t('goals.search')}</span>
              <input
                aria-label={t('goals.search')}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('goals.searchPlaceholder')}
              />
            </label>
          </div>
          {!state.results['goal.list'] ? (
            <div className="goal-empty">
              <LoaderCircle size={22} className="spin" />
              <p>{t('goals.reading')}</p>
            </div>
          ) : visible.length ? (
            <div className="goal-catalog">
              {visible.map((item) => (
                <button
                  type="button"
                  key={String(item['id'])}
                  onClick={() => {
                    setSelected(String(item['id']));
                    setError('');
                  }}
                >
                  <div>
                    <span className="eyebrow">{named(item['status'])}</span>
                    <h3>{label(item['title'], t('goals.untitled'))}</h3>
                    <p>
                      {t('goals.catalogLine', {
                        doneTasks: reportedCount(item['completedTasks']),
                        tasks: reportedCount(item['totalTasks']),
                        donePhases: reportedCount(item['completedPhases']),
                        phases: reportedCount(item['totalPhases']),
                      })}
                    </p>
                  </div>
                  <span className="goal-percent">
                    {typeof item['percentComplete'] === 'number'
                      ? `${Math.round(item['percentComplete'])}%`
                      : '—'}
                  </span>
                  <small>{t('goals.verification', { status: named(item['verification']) })}</small>
                </button>
              ))}
            </div>
          ) : (
            <div className="goal-empty">
              <Target size={28} />
              <h2>{query ? t('goals.noMatch') : t('goals.none')}</h2>
              <p>{query ? t('goals.tryAnother') : t('goals.createHint')}</p>
            </div>
          )}
        </>
      )}
    </section>
  );
}
