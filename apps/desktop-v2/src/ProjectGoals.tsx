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
import type { EngineSend } from './engine-operations';
import { type EngineState, entries, record } from './engine-state';
import { GoalRevert } from './GoalRevert';
import { matchingGoalAssessment } from './goal-assessment';
import { goalBudgetPayload, goalBudgetText } from './goal-budget-model';
import { ProjectMission } from './ProjectMission';
import './project-goals.css';

const label = (value: unknown, fallback = 'Not reported') =>
  typeof value === 'string' && value ? value : fallback;
const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const reportedCount = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? String(value) : '—';
const statusText = (value: unknown) => label(value).replaceAll('_', ' ');
let assessmentSequence = Date.now();

/** A project-owned view over the engine's Goal catalog and per-goal state. */
export function ProjectGoals({
  state,
  send,
  onKanban,
}: {
  state: EngineState;
  send: EngineSend;
  onKanban: () => void;
}) {
  const [selected, setSelected] = useState('');
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
    [resumeTokens, setResumeTokens] = useState('');
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
  const sendRequest = async (
    type: string,
    payload: Record<string, unknown>,
    description: string,
  ) => {
    setError('');
    setAction(`${description} requested. Waiting for the engine.`);
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
    if (state.results['goal.list'])
      setAction((current) => (current.startsWith('Refresh ') ? '' : current));
  }, [state.results['goal.list']]);
  useEffect(() => {
    if (goalError) {
      setError(label(goalError['message'], 'The engine refused this request.'));
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
      budget = goalBudgetPayload(budgetTasks, budgetMinutes, budgetTokens);
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
    setAction('Goal submitted. Waiting for the engine to plan.');
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
    <section className="project-goals" aria-label="Project Goals">
      <header className="studio-heading">
        <div>
          <span className="eyebrow">A DIRECTION FOR THE WHOLE PROJECT</span>
          <h1>
            Goals<span className="heading-dot">.</span>
          </h1>
          <p>Plan missions, follow their phases and inspect work across the project.</p>
        </div>
        <div className="goal-header-actions">
          <button
            type="button"
            className="button secondary"
            onClick={() => void sendRequest('goal.list', {}, 'Refresh')}
          >
            <RefreshCw size={14} /> Refresh
          </button>
          <button
            type="button"
            className="button primary"
            onClick={() => {
              setCreating(true);
              setSelected('');
            }}
          >
            <Plus size={14} /> New goal
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
              Return to goal draft
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
            <ArrowLeft size={14} /> All goals
          </button>
          <h2>What should this project achieve?</h2>
          <p>WrongStack plans the phases and coordinates work using the project engine.</p>
          <label>
            Goal
            <textarea
              aria-label="Goal"
              value={title}
              onChange={(event) => {
                setTitle(event.target.value);
                assessmentRequest.current = 0;
                setAssessing(false);
                setAssessment(null);
              }}
              placeholder="Describe the outcome and constraints…"
            />
          </label>
          <div className="goal-assessment">
            <div>
              <strong>Check feasibility</strong>
              <p>Ask the configured model to assess the goal before planning.</p>
            </div>
            <button
              type="button"
              className="button secondary"
              disabled={!title.trim() || assessing}
              onClick={() => void assess()}
            >
              {assessing ? 'Assessing…' : 'Assess goal'}
            </button>
          </div>
          {assessment && (
            <div className="goal-assessment-result" role="status">
              {assessment['parseFailed'] === true ? (
                <>
                  <strong>Assessment unavailable</strong>
                  <p>
                    {label(
                      assessment['parseError'],
                      'The model did not return a usable assessment.',
                    )}
                  </p>
                </>
              ) : (
                <>
                  <strong>
                    {assessment['realistic'] === true
                      ? 'Goal looks feasible'
                      : assessment['realistic'] === false
                        ? 'Review the scope'
                        : 'Assessment'}
                  </strong>
                  {typeof assessment['explanation'] === 'string' && assessment['explanation'] && (
                    <p>{assessment['explanation']}</p>
                  )}
                  {typeof assessment['durationClaimed'] === 'string' && (
                    <p>Requested duration: {assessment['durationClaimed']}</p>
                  )}
                  {typeof assessment['recommendedDuration'] === 'string' && (
                    <p>Suggested duration: {assessment['recommendedDuration']}</p>
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
              Verify tasks
            </label>
            <label>
              <input
                type="checkbox"
                checked={multiBoard}
                onChange={(e) => setMultiBoard(e.target.checked)}
              />{' '}
              Separate board for each phase
            </label>
            <label>
              <input
                type="checkbox"
                checked={review}
                onChange={(e) => setReview(e.target.checked)}
              />{' '}
              Chimera review
            </label>
            <label>
              <input
                type="checkbox"
                checked={isolate}
                onChange={(e) => setIsolate(e.target.checked)}
              />{' '}
              Isolate work in Git worktrees
            </label>
            <label>
              Task limit
              <input
                type="number"
                min={1}
                step={1}
                inputMode="numeric"
                value={budgetTasks}
                placeholder="No limit"
                onChange={(e) => setBudgetTasks(e.target.value)}
              />
            </label>
            <label>
              Run-time limit (minutes)
              <input
                type="number"
                min={1}
                inputMode="decimal"
                value={budgetMinutes}
                placeholder="No limit"
                onChange={(e) => setBudgetMinutes(e.target.value)}
              />
            </label>
            <label title="Provider tokens reported by the task agents, checked before each task: the task that crosses the limit finishes.">
              Token limit
              <input
                type="number"
                min={1}
                step={1}
                inputMode="numeric"
                value={budgetTokens}
                placeholder="No limit"
                onChange={(e) => setBudgetTokens(e.target.value)}
              />
            </label>
          </div>
          <div className="goal-create-actions">
            <button type="button" className="button secondary" onClick={() => setCreating(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="button primary"
              disabled={!title.trim()}
              onClick={() => void start()}
            >
              <Target size={14} /> Start goal
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
            <ArrowLeft size={14} /> All goals
          </button>
          <div className="goal-detail-head">
            <div>
              <span className="eyebrow">PROJECT MISSION</span>
              <h2>{label(goal?.['title'] ?? summary?.['title'], 'Goal')}</h2>
              <p>{label(goal?.['goal'], '')}</p>
              <div className="goal-chips">
                <span>{statusText(status)}</span>
                <span>{readOnly ? 'Controlled by another owner' : 'Project engine'}</span>
                {goal?.['verifyTasks'] === true && <span>Task verification</span>}
                {goal?.['multiBoard'] === true && <span>Multiple boards</span>}
                {goalBudgetText(goal?.['budget'], goal?.['budgetUsage']) && (
                  <span>{goalBudgetText(goal?.['budget'], goal?.['budgetUsage'])}</span>
                )}
              </div>
            </div>
            <div className="goal-controls">
              {status === 'running' && (
                <button
                  type="button"
                  className="button secondary"
                  disabled={readOnly}
                  onClick={() => void sendRequest('goal.pause', { goalId: selected }, 'Pause')}
                >
                  <Pause size={14} /> Pause
                </button>
              )}
              {['stopped', 'failed'].includes(status) && !readOnly && (
                // New limits replace the saved budget when the run resumes; blank keeps it.
                <span className="goal-resume-budget">
                  <input
                    type="number"
                    min={1}
                    step={1}
                    aria-label="Task limit for the resumed run"
                    placeholder="Task limit"
                    value={resumeTasks}
                    onChange={(e) => setResumeTasks(e.target.value)}
                  />
                  <input
                    type="number"
                    min={1}
                    aria-label="Run-time limit in minutes for the resumed run"
                    placeholder="Minutes"
                    value={resumeMinutes}
                    onChange={(e) => setResumeMinutes(e.target.value)}
                  />
                  <input
                    type="number"
                    min={1}
                    step={1}
                    aria-label="Token limit for the resumed run"
                    placeholder="Tokens"
                    value={resumeTokens}
                    onChange={(e) => setResumeTokens(e.target.value)}
                  />
                </span>
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
                          : goalBudgetPayload(resumeTasks, resumeMinutes, resumeTokens);
                    } catch (e) {
                      setError(e instanceof Error ? e.message : String(e));
                      return;
                    }
                    void sendRequest(
                      'goal.resume',
                      { goalId: selected, ...(budget ? { budget } : {}) },
                      'Resume',
                    );
                  }}
                >
                  <Play size={14} /> Resume
                </button>
              )}
              {['running', 'paused'].includes(status) &&
                (stopConfirm ? (
                  <>
                    <span>Stop this run?</span>
                    <button
                      type="button"
                      className="button secondary"
                      onClick={() => {
                        setStopConfirm(false);
                        void sendRequest('goal.stop', { goalId: selected }, 'Stop');
                      }}
                    >
                      Confirm stop
                    </button>
                    <button type="button" onClick={() => setStopConfirm(false)}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="button secondary"
                    disabled={readOnly}
                    onClick={() => setStopConfirm(true)}
                  >
                    <Square size={14} /> Stop
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
              <button type="button" className="button secondary" onClick={onKanban}>
                Open Kanban
              </button>
            </div>
          </div>
          {!goal ? (
            <div className="goal-empty">
              {!goalError && <LoaderCircle size={22} className="spin" />}
              <p>
                {goalError
                  ? 'The engine did not load this goal.'
                  : 'Waiting for the engine’s goal state…'}
              </p>
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
                  Return to goal draft
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
                  <span>Phases complete</span>
                </div>
                <div>
                  <strong>
                    {reportedCount(record(goal['progress'])['completedTasks'])} /{' '}
                    {reportedCount(record(goal['progress'])['totalTasks'])}
                  </strong>
                  <span>Tasks complete</span>
                </div>
                <div>
                  <strong>
                    {typeof goal['overallPercent'] === 'number'
                      ? `${goal['overallPercent']}%`
                      : '—'}
                  </strong>
                  <span>Phase progress</span>
                </div>
                <div>
                  <strong>
                    {record(goal['finalVerification'])['skipped'] === true
                      ? 'Skipped'
                      : statusText(record(goal['finalVerification'])['status'] ?? 'not run')}
                  </strong>
                  <span>Final verification</span>
                </div>
              </div>
              {typeof goal['lastError'] === 'string' && goal['lastError'] && (
                <p className="session-error">{goal['lastError']}</p>
              )}
              <div className="goal-workspace">
                <div className="goal-phase-list">
                  <header>
                    <Flag size={15} />
                    <strong>Phases and tasks</strong>
                    <span>{phases.length} phases</span>
                  </header>
                  {phases.map((phase) => (
                    <article key={String(phase['id'])} className="goal-phase">
                      <div className="goal-phase-head">
                        <div>
                          <strong>{label(phase['name'], 'Phase')}</strong>
                          <p>{label(phase['description'], '')}</p>
                        </div>
                        <span>{statusText(phase['status'])}</span>
                      </div>
                      <div className="goal-phase-progress">
                        <span
                          style={{
                            width: `${Math.max(0, Math.min(100, count(phase['progressPercent'])))}%`,
                          }}
                        />
                      </div>
                      <small>
                        {reportedCount(phase['completedTasks'])} /{' '}
                        {reportedCount(phase['taskCount'])} tasks ·{' '}
                        {label(phase['priority'], 'priority not reported')} priority
                      </small>
                      <div className="goal-tasks">
                        {entries(phase['tasks']).map((item) => (
                          <button
                            type="button"
                            key={String(item['id'])}
                            aria-pressed={selectedTask === item['id']}
                            onClick={() => setSelectedTask(String(item['id']))}
                          >
                            <CheckCircle2 size={14} />
                            <span>{label(item['title'], 'Task')}</span>
                            <small>{statusText(item['status'])}</small>
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
                              'Add task',
                            );
                          }}
                        >
                          <input
                            aria-label={`New task for ${label(phase['name'], 'phase')}`}
                            value={newTasks[String(phase['id'])] ?? ''}
                            onChange={(event) =>
                              setNewTasks((current) => ({
                                ...current,
                                [String(phase['id'])]: event.target.value,
                              }))
                            }
                            placeholder="Add a task to this phase"
                          />
                          <button
                            type="submit"
                            disabled={
                              !(newTasks[String(phase['id'])] ?? '').trim() || Boolean(action)
                            }
                          >
                            Add
                          </button>
                        </form>
                      )}
                    </article>
                  ))}
                  {!phases.length && (
                    <p className="goal-empty">No phases have been reported yet.</p>
                  )}
                </div>
                <aside className="goal-inspector">
                  {task ? (
                    <>
                      <span className="eyebrow">TASK DETAILS</span>
                      <h3>{label(task['title'], 'Task')}</h3>
                      <p>{label(task['description'], 'No description was recorded.')}</p>
                      <dl>
                        {[
                          ['Phase', task['phaseName']],
                          ['Status', task['status']],
                          ['Priority', task['priority']],
                          ['Type', task['type']],
                          ['Assigned agent', task['assignee']],
                          ['Estimated hours', task['estimateHours']],
                          ['Actual hours', task['actualHours']],
                        ].map(([name, value]) => (
                          <div key={String(name)}>
                            <dt>{String(name)}</dt>
                            <dd>{typeof value === 'number' ? value : statusText(value)}</dd>
                          </div>
                        ))}
                      </dl>
                      {Array.isArray(task['tags']) && task['tags'].length > 0 && (
                        <p>
                          Tags: {task['tags'].filter((tag) => typeof tag === 'string').join(', ')}
                        </p>
                      )}
                      {!readOnly && (
                        <>
                          <label>
                            Change status
                            <select
                              value={label(task['status'], 'pending')}
                              onChange={(e) =>
                                void sendRequest(
                                  'goal.taskStatus',
                                  { goalId: selected, taskId: task['id'], status: e.target.value },
                                  'Status change',
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
                                  {value.replaceAll('_', ' ')}
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
                                  'Retry',
                                )
                              }
                            >
                              Retry task
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
                                    'Assignment',
                                  );
                                }}
                              >
                                <label>
                                  Assign agent
                                  <input
                                    value={agentName}
                                    onChange={(event) => setAgentName(event.target.value)}
                                    placeholder="Agent name; empty clears assignment"
                                  />
                                </label>
                                <button
                                  type="submit"
                                  className="button secondary"
                                  disabled={Boolean(action)}
                                >
                                  Update assignment
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
                                    Move to phase
                                    <select
                                      value={destination}
                                      onChange={(event) => {
                                        setDestination(event.target.value);
                                        setConfirmMove(false);
                                      }}
                                    >
                                      <option value="">Select destination</option>
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
                                            {label(phase['name'], 'Phase')}
                                          </option>
                                        ))}
                                    </select>
                                  </label>
                                  {confirmMove ? (
                                    <>
                                      <p>
                                        Moving removes this task’s phase dependencies and
                                        parent/child links.
                                      </p>
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
                                            'Move task',
                                          );
                                        }}
                                      >
                                        Confirm move
                                      </button>
                                      <button type="button" onClick={() => setConfirmMove(false)}>
                                        Cancel
                                      </button>
                                    </>
                                  ) : (
                                    <button
                                      type="submit"
                                      className="button secondary"
                                      disabled={!destination || Boolean(action)}
                                    >
                                      Move task
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
                      <h3>Inspect the work</h3>
                      <p>Select a task to see its status, assignment, and recorded details.</p>
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
              <h2>Execution goals</h2>
              <p>{goals.length} recorded goal runs</p>
            </div>
            <label>
              <span className="sr-only">Search goals</span>
              <input
                aria-label="Search goals"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search goals…"
              />
            </label>
          </div>
          {!state.results['goal.list'] ? (
            <div className="goal-empty">
              <LoaderCircle size={22} className="spin" />
              <p>Reading the project goal catalog…</p>
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
                    <span className="eyebrow">{statusText(item['status'])}</span>
                    <h3>{label(item['title'], 'Untitled goal')}</h3>
                    <p>
                      {reportedCount(item['completedTasks'])} / {reportedCount(item['totalTasks'])}{' '}
                      tasks · {reportedCount(item['completedPhases'])} /{' '}
                      {reportedCount(item['totalPhases'])} phases
                    </p>
                  </div>
                  <span className="goal-percent">
                    {typeof item['percentComplete'] === 'number'
                      ? `${Math.round(item['percentComplete'])}%`
                      : '—'}
                  </span>
                  <small>Verification: {statusText(item['verification'])}</small>
                </button>
              ))}
            </div>
          ) : (
            <div className="goal-empty">
              <Target size={28} />
              <h2>{query ? 'No matching goals' : 'No goals yet'}</h2>
              <p>
                {query
                  ? 'Try another search.'
                  : 'Create a goal when you are ready to coordinate work across this project.'}
              </p>
            </div>
          )}
        </>
      )}
    </section>
  );
}
