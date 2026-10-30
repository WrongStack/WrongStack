import {
  ArrowLeft,
  CheckCircle2,
  FileText,
  LoaderCircle,
  Play,
  RefreshCw,
  Workflow,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { FormDraftStorage } from './durable-form-draft';
import type { EngineHttp } from './engine-http';
import type { EngineSend } from './engine-operations';
import { type EngineState, entries, record } from './engine-state';
import type { RunFocus } from './kanban-board-source';
import { ProjectRequirements } from './ProjectRequirements';
import type { RequirementDraftStorage } from './requirement-draft';
import type { RequirementRecordDraftStorageFactory } from './requirement-record-draft';
import { SddDependencyGraph } from './SddDependencyGraph';
import { SddLifecycle } from './SddLifecycle';
import { SddTaskDetails } from './SddTaskDetails';
import './project-sdd.css';

const text = (value: unknown, fallback = 'Not reported') =>
  typeof value === 'string' && value ? value : fallback;
const num = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? String(value) : '—';
const readable = (value: unknown) => text(value).replaceAll('_', ' ');

/** Project SDD connects directly to the interview, specifications and run protocols. */
export function ProjectSdd({
  state,
  send,
  http,
  draftStorage,
  recordDraftStorage,
  resourceInputStorage,
  onKanban,
}: {
  state: EngineState;
  send: EngineSend;
  http: EngineHttp;
  draftStorage?: RequirementDraftStorage;
  recordDraftStorage?: RequirementRecordDraftStorageFactory;
  resourceInputStorage?: (formKey: string) => FormDraftStorage;
  /** Opens Kanban on the board that mirrors an SDD run. */
  onKanban?: ((focus: RunFocus) => void) | undefined;
}) {
  const [view, setView] = useState<'requirements' | 'interview' | 'specs' | 'runs'>('interview');
  const [transfer, setTransfer] = useState<string | null>(null);
  const [goal, setGoal] = useState('');
  const [reply, setReply] = useState('');
  const [error, setError] = useState('');
  const [waiting, setWaiting] = useState('');
  const [selectedSpec, setSelectedSpec] = useState('');
  const [selectedTask, setSelectedTask] = useState('');
  const [specView, setSpecView] = useState<'list' | 'graph'>('list');
  const [confirm, setConfirm] = useState('');
  const [slots, setSlots] = useState(4);
  const [isolate, setIsolate] = useState(false);
  const [decompose, setDecompose] = useState(false);
  const lastError = useRef(state.results['sdd.spec.error']);
  const lastRun = useRef(state.results['sdd.run.started']);
  const submittedAnswer = useRef<{ text: string; previousCount: number } | null>(null);
  const snapshot = record(state.results['sdd.spec.snapshot']);
  const phase = text(snapshot['phase'], 'idle');
  const started = Boolean(state.sddInterviewId && snapshot['discarded'] !== true);
  const busy = snapshot['busy'] === true;
  const answers = entries(snapshot['answers']);
  const spec = record(snapshot['spec']);
  const specs = entries(record(state.results['specs.list'])['specs']).filter(
    (row) => typeof row['id'] === 'string',
  );
  const detail = selectedSpec ? state.specDetails[selectedSpec] : undefined;
  const columns = entries(detail?.['columns']);
  const boards = entries(record(state.results['sdd.board.list'])['boards']);
  const board = record(state.results['sdd.board.snapshot']);
  const runId = text(board['runId'], '');
  const tasks = entries(board['tasks']);
  const task = tasks.find((item) => item['id'] === selectedTask);
  const request = async (type: string, payload: Record<string, unknown>, description: string) => {
    setError('');
    setWaiting(`${description} requested. Waiting for the engine.`);
    try {
      await send(type, payload);
    } catch (e) {
      setWaiting('');
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  useEffect(() => {
    for (const type of ['sdd.spec.get', 'specs.list', 'sdd.board.list', 'sdd.board.get'])
      void send(type).catch((e) => setError(String(e)));
  }, [send]);
  useEffect(() => {
    if (state.results['sdd.spec.snapshot']) setWaiting('');
    const pending = submittedAnswer.current;
    const currentAnswers = entries(record(state.results['sdd.spec.snapshot'])['answers']);
    if (
      pending &&
      currentAnswers.length > pending.previousCount &&
      currentAnswers.some(
        (row, index) => index >= pending.previousCount && row['answer'] === pending.text,
      )
    ) {
      setReply((current) => (current.trim() === pending.text ? '' : current));
      submittedAnswer.current = null;
    }
  }, [state.results['sdd.spec.snapshot']]);
  useEffect(() => {
    if (state.results['sdd.board.snapshot'])
      setWaiting((current) =>
        /^(Pause|Resume|Stop|Task .+) requested/.test(current) ? '' : current,
      );
  }, [state.results['sdd.board.snapshot']]);
  useEffect(() => {
    const failure = state.results['sdd.spec.error'];
    if (failure && failure !== lastError.current) {
      setWaiting('');
      setError(text(failure['message'], 'The SDD engine refused the request.'));
    }
    lastError.current = failure;
  }, [state.results['sdd.spec.error']]);
  useEffect(() => {
    if (state.results['sdd.run.started'] && state.results['sdd.run.started'] !== lastRun.current) {
      setWaiting('');
      setView('runs');
      void send('sdd.board.list').catch((e) => setError(String(e)));
    }
    lastRun.current = state.results['sdd.run.started'];
  }, [state.results['sdd.run.started'], send]);
  const submitGoal = () => {
    if (goal.trim()) void request('sdd.spec.start', { goal: goal.trim() }, 'Interview');
  };
  const submitReply = () => {
    if (reply.trim()) {
      submittedAnswer.current = { text: reply.trim(), previousCount: answers.length };
      void request('sdd.spec.message', { text: reply.trim() }, 'Answer');
    }
  };
  const beginRun = (type: 'sdd.run.start' | 'sdd.run.from_spec', id?: string) => {
    setConfirm('');
    void request(
      type,
      {
        ...(id ? { specId: id } : {}),
        parallelSlots: slots,
        worktrees: isolate,
        planDecompose: decompose,
      },
      'SDD run',
    );
  };
  return (
    <section className="project-sdd" aria-label="Project SDD">
      <header className="studio-heading">
        <div>
          <span className="eyebrow">FROM INTENT TO VERIFIED WORK</span>
          <h1>
            SDD<span className="heading-dot">.</span>
          </h1>
          <p>Shape requirements, inspect specifications and follow project execution.</p>
        </div>
        <button
          type="button"
          className="button secondary"
          onClick={() => {
            for (const type of ['sdd.spec.get', 'specs.list', 'sdd.board.list', 'sdd.board.get'])
              void send(type).catch((e) => setError(String(e)));
          }}
        >
          <RefreshCw size={14} /> Refresh
        </button>
      </header>
      <nav className="sdd-navigation" aria-label="SDD workspace">
        <button
          type="button"
          aria-pressed={view === 'requirements'}
          onClick={() => setView('requirements')}
        >
          Requirements
        </button>
        <button
          type="button"
          aria-pressed={view === 'interview'}
          onClick={() => setView('interview')}
        >
          Interview
        </button>
        <button type="button" aria-pressed={view === 'specs'} onClick={() => setView('specs')}>
          Specifications <span>{specs.length}</span>
        </button>
        <button type="button" aria-pressed={view === 'runs'} onClick={() => setView('runs')}>
          Runs <span>{boards.length}</span>
        </button>
      </nav>
      {error && (
        <p className="session-error" role="alert">
          {error}
        </p>
      )}
      {waiting && (
        <p className="goal-request" role="status">
          <LoaderCircle className="spin" size={14} />
          {waiting}
        </p>
      )}
      {transfer !== null && (
        <div className="sdd-card">
          <p>Replace the current interview draft with this requirement?</p>
          <div className="sdd-actions">
            <button type="button" className="button secondary" onClick={() => setTransfer(null)}>
              Keep current draft
            </button>
            <button
              type="button"
              className="button primary"
              onClick={() => {
                setGoal(transfer);
                setTransfer(null);
                setView('interview');
              }}
            >
              Use requirement
            </button>
          </div>
        </div>
      )}
      <div hidden={view !== 'requirements'}>
        <ProjectRequirements
          http={http}
          {...(draftStorage ? { draftStorage } : {})}
          {...(recordDraftStorage ? { recordDraftStorage } : {})}
          {...(resourceInputStorage ? { resourceInputStorage } : {})}
          onStartSdd={(value) => {
            if (started) {
              setError(
                'An interview is already active. Continue it or discard it before preparing another request.',
              );
              return;
            }
            if (goal.trim() && goal !== value) {
              setTransfer(value);
              return;
            }
            setGoal(value);
            setView('interview');
          }}
        />
      </div>
      {view === 'requirements' ? null : view === 'interview' ? (
        <div className="sdd-layout">
          <main className="sdd-main">
            {!started ? (
              <div className="sdd-card sdd-start">
                <Workflow size={24} />
                <h2>Start with the outcome</h2>
                <p>
                  WrongStack will interview you, prepare a specification and break it into work. An
                  existing interview is preserved by the engine.
                </p>
                <label>
                  Project outcome
                  <textarea
                    aria-label="Project outcome"
                    value={goal}
                    onChange={(e) => setGoal(e.target.value)}
                    placeholder="What should this project deliver?"
                  />
                </label>
                <button
                  type="button"
                  className="button primary"
                  disabled={!goal.trim() || Boolean(waiting)}
                  onClick={submitGoal}
                >
                  Start interview
                </button>
              </div>
            ) : (
              <>
                <div className="sdd-interview-head">
                  <div>
                    <span className="eyebrow">SPECIFICATION INTERVIEW</span>
                    <h2>{text(snapshot['title'], 'Project interview')}</h2>
                    <p>{text(snapshot['goal'], '')}</p>
                  </div>
                  <span className="sdd-chip">{readable(phase)}</span>
                </div>
                <div className="sdd-transcript">
                  {answers.map((answer, index) => (
                    <div className="sdd-exchange" key={index}>
                      <p>
                        <strong>WrongStack</strong>
                        {text(answer['question'], '')}
                      </p>
                      <p>
                        <strong>You</strong>
                        {text(answer['answer'], '')}
                      </p>
                    </div>
                  ))}
                  {state.sddAgentText && (
                    <div className="sdd-agent">
                      <strong>WrongStack</strong>
                      <p>{state.sddAgentText}</p>
                    </div>
                  )}
                  {busy && (
                    <p className="goal-request">
                      <LoaderCircle className="spin" size={14} /> Working on the next step…
                    </p>
                  )}
                </div>
                {['questioning', 'spec_review', 'task_review', 'implementation'].includes(
                  phase,
                ) && (
                  <form
                    className="sdd-reply"
                    onSubmit={(e) => {
                      e.preventDefault();
                      submitReply();
                    }}
                  >
                    <label>
                      Answer or feedback
                      <textarea
                        aria-label="Answer or feedback"
                        value={reply}
                        onChange={(e) => setReply(e.target.value)}
                        placeholder="Add your answer or feedback…"
                      />
                    </label>
                    <button
                      type="submit"
                      className="button primary"
                      disabled={!reply.trim() || busy || Boolean(waiting)}
                    >
                      Send feedback
                    </button>
                    <small>Your text stays here until you change it.</small>
                  </form>
                )}
                <div className="sdd-actions">
                  {['spec_review', 'task_review'].includes(phase) && (
                    <button
                      type="button"
                      className="button primary"
                      disabled={busy || Boolean(waiting)}
                      onClick={() => void request('sdd.spec.approve', {}, 'Approval')}
                    >
                      <CheckCircle2 size={14} /> Approve{' '}
                      {phase === 'spec_review' ? 'specification' : 'tasks'}
                    </button>
                  )}
                  {['spec_review', 'implementation', 'task_review'].includes(phase) && (
                    <button
                      type="button"
                      className="button secondary"
                      disabled={busy || Boolean(waiting)}
                      onClick={() => void request('sdd.spec.rewind', {}, 'Rewind')}
                    >
                      Rewind
                    </button>
                  )}
                  {confirm === 'discard' ? (
                    <>
                      <span>Discard this interview?</span>
                      <button
                        type="button"
                        className="button secondary"
                        onClick={() => {
                          setConfirm('');
                          void request('sdd.spec.discard', {}, 'Discard');
                        }}
                      >
                        Confirm discard
                      </button>
                      <button type="button" onClick={() => setConfirm('')}>
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="button secondary"
                      disabled={busy || Boolean(waiting)}
                      onClick={() => setConfirm('discard')}
                    >
                      Discard interview
                    </button>
                  )}
                </div>
                {['task_review', 'executing'].includes(phase) && (
                  <div className="sdd-run-config">
                    <h3>Run the task graph</h3>
                    <RunOptions
                      slots={slots}
                      setSlots={setSlots}
                      isolate={isolate}
                      setIsolate={setIsolate}
                      decompose={decompose}
                      setDecompose={setDecompose}
                    />
                    {confirm === 'start' ? (
                      <div className="sdd-actions">
                        <span>Start this project run?</span>
                        <button
                          type="button"
                          className="button primary"
                          onClick={() => beginRun('sdd.run.start')}
                        >
                          Confirm start
                        </button>
                        <button type="button" onClick={() => setConfirm('')}>
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="button primary"
                        disabled={busy || Boolean(waiting)}
                        onClick={() => setConfirm('start')}
                      >
                        <Play size={14} /> Start run
                      </button>
                    )}
                  </div>
                )}
              </>
            )}
          </main>
          <aside className="sdd-aside">
            <span className="eyebrow">PROJECT CONTEXT</span>
            <h3>Specification</h3>
            {spec['title'] ? (
              <>
                <strong>{text(spec['title'])}</strong>
                <p>{text(spec['overview'], '')}</p>
                <ul>
                  {entries(spec['requirements']).map((row, i) => (
                    <li key={i}>
                      <span>{readable(row['priority'])}</span>
                      {text(row['description'], '')}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p>Requirements appear here as the interview develops.</p>
            )}
            <div className="sdd-aside-metrics">
              <span>
                Questions <strong>{num(snapshot['questionCount'])}</strong>
              </span>
              <span>
                Tasks <strong>{num(snapshot['taskCount'])}</strong>
              </span>
            </div>
          </aside>
        </div>
      ) : view === 'specs' ? (
        <div className="sdd-spec-layout">
          <div className="sdd-list">
            <h2>Specifications</h2>
            {!state.results['specs.list'] ? (
              <p>Loading specifications…</p>
            ) : specs.length ? (
              specs.map((item) => (
                <button
                  type="button"
                  key={String(item['id'])}
                  aria-pressed={selectedSpec === item['id']}
                  onClick={() => {
                    const id = String(item['id']);
                    setSelectedSpec(id);
                    setConfirm('');
                    void send('specs.get', { specId: id }).catch((e) => setError(String(e)));
                  }}
                >
                  <FileText size={17} />
                  <span>
                    <strong>{text(item['title'], 'Untitled specification')}</strong>
                    <small>
                      {readable(item['status'])} · {num(item['completed'])} / {num(item['total'])}{' '}
                      tasks
                    </small>
                  </span>
                </button>
              ))
            ) : (
              <p>No specifications have been recorded for this project.</p>
            )}
          </div>
          <div className="sdd-spec-detail">
            {!selectedSpec ? (
              <div className="sdd-empty">
                <FileText size={26} />
                <h2>Select a specification</h2>
                <p>Explore its task graph and dependencies.</p>
              </div>
            ) : !detail ? (
              <div className="sdd-empty">
                <LoaderCircle className="spin" size={22} />
                <p>Loading specification…</p>
              </div>
            ) : detail['notFound'] ? (
              <div className="sdd-empty">
                <h2>Task graph unavailable</h2>
                <p>The engine could not find this specification and its task graph.</p>
              </div>
            ) : (
              <>
                <button type="button" className="goal-back" onClick={() => setSelectedSpec('')}>
                  <ArrowLeft size={14} /> All specifications
                </button>
                <h2>{text(detail['title'], 'Specification')}</h2>
                <p>{text(detail['overview'], '')}</p>
                <nav className="sdd-graph-controls" aria-label="Specification view">
                  <button
                    type="button"
                    className="button secondary"
                    aria-pressed={specView === 'list'}
                    onClick={() => setSpecView('list')}
                  >
                    Task list
                  </button>
                  <button
                    type="button"
                    className="button secondary"
                    aria-pressed={specView === 'graph'}
                    onClick={() => setSpecView('graph')}
                  >
                    Dependency graph
                  </button>
                </nav>
                {specView === 'graph' ? (
                  <SddDependencyGraph columns={columns} />
                ) : (
                  <div className="sdd-task-columns">
                    {columns.map((column, i) => (
                      <section key={i}>
                        <h3>{text(column['label'], 'Phase')}</h3>
                        {entries(column['tasks']).map((item) => (
                          <article key={String(item['id'])}>
                            <strong>{text(item['title'], 'Task')}</strong>
                            <p>{text(item['description'], '')}</p>
                            <small>
                              {readable(item['displayStatus'] ?? item['status'])} ·{' '}
                              {readable(item['priority'])}
                            </small>
                            {Array.isArray(item['deps']) && item['deps'].length > 0 && (
                              <small>
                                Depends on:{' '}
                                {item['deps'].filter((x) => typeof x === 'string').join(', ')}
                              </small>
                            )}
                          </article>
                        ))}
                      </section>
                    ))}
                  </div>
                )}
                <div className="sdd-run-config">
                  <h3>Run this specification</h3>
                  <RunOptions
                    slots={slots}
                    setSlots={setSlots}
                    isolate={isolate}
                    setIsolate={setIsolate}
                    decompose={decompose}
                    setDecompose={setDecompose}
                  />
                  {confirm === 'run-spec' ? (
                    <div className="sdd-actions">
                      <span>Start this project run?</span>
                      <button
                        type="button"
                        className="button primary"
                        onClick={() => beginRun('sdd.run.from_spec', selectedSpec)}
                      >
                        Confirm start
                      </button>
                      <button type="button" onClick={() => setConfirm('')}>
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="button primary"
                      disabled={Boolean(waiting)}
                      onClick={() => setConfirm('run-spec')}
                    >
                      <Play size={14} /> Run as SDD
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      ) : (
        <div className="sdd-runs">
          <div className="sdd-list">
            <h2>Project runs</h2>
            {!state.results['sdd.board.list'] ? (
              <p>Loading runs…</p>
            ) : boards.length ? (
              boards.map((item) => (
                <article key={String(item['runId'])}>
                  <strong>{text(item['title'], 'SDD run')}</strong>
                  <small>
                    {readable(item['status'])} · {num(item['completed'])} / {num(item['total'])}{' '}
                    tasks
                  </small>
                  <small>
                    {item['runId'] === runId ? 'Current board shown' : 'Historical run'}
                  </small>
                </article>
              ))
            ) : (
              <p>No SDD runs have been recorded.</p>
            )}
          </div>
          <div className="sdd-board">
            {!runId ? (
              <div className="sdd-empty">
                <Workflow size={26} />
                <h2>No current run</h2>
                <p>Start a run from an interview or specification to see its board.</p>
              </div>
            ) : (
              <>
                <span className="eyebrow">CURRENT BOARD</span>
                <h2>{text(board['title'], 'SDD run')}</h2>
                <div className="sdd-actions">
                  <span className="sdd-chip">{readable(board['status'])}</span>
                  {onKanban && (
                    <button
                      type="button"
                      className="button secondary"
                      title="Open the Kanban board that mirrors this run"
                      onClick={() => onKanban({ system: 'sdd', runId })}
                    >
                      Open run board
                    </button>
                  )}
                  {board['status'] === 'running' && (
                    <button
                      type="button"
                      className="button secondary"
                      onClick={() => void request('sdd.board.pause', { runId }, 'Pause')}
                    >
                      Pause
                    </button>
                  )}
                  {board['status'] === 'paused' && (
                    <button
                      type="button"
                      className="button secondary"
                      onClick={() => void request('sdd.board.resume', { runId }, 'Resume')}
                    >
                      Resume
                    </button>
                  )}
                  {['running', 'paused'].includes(String(board['status'])) &&
                    (confirm === 'stop' ? (
                      <>
                        <span>Stop this run?</span>
                        <button
                          type="button"
                          className="button secondary"
                          onClick={() => {
                            setConfirm('');
                            void request('sdd.board.stop', { runId }, 'Stop');
                          }}
                        >
                          Confirm stop
                        </button>
                        <button type="button" onClick={() => setConfirm('')}>
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="button secondary"
                        onClick={() => setConfirm('stop')}
                      >
                        Stop
                      </button>
                    ))}
                </div>
                <div className="sdd-progress">
                  <strong>
                    {num(record(board['progress'])['completed'])} /{' '}
                    {num(record(board['progress'])['total'])}
                  </strong>
                  <span>tasks completed</span>
                  <strong>{num(record(board['progress'])['percentComplete'])}%</strong>
                </div>
                <div className="sdd-board-tasks">
                  {tasks.map((item) => (
                    <button
                      type="button"
                      key={String(item['id'])}
                      aria-pressed={selectedTask === item['id']}
                      onClick={() => setSelectedTask(String(item['id']))}
                    >
                      <strong>{text(item['title'], 'Task')}</strong>
                      <span>{readable(item['displayStatus'] ?? item['status'])}</span>
                    </button>
                  ))}
                </div>
                {task && (
                  <SddTaskDetails
                    key={`${runId}:${String(task['id'])}`}
                    task={task}
                    tasks={tasks}
                    board={board}
                    waiting={Boolean(waiting)}
                    request={request}
                    onSelect={setSelectedTask}
                  />
                )}
              </>
            )}
          </div>
          <SddLifecycle state={state} board={board} boards={boards} send={send} />
        </div>
      )}
    </section>
  );
}

function RunOptions({
  slots,
  setSlots,
  isolate,
  setIsolate,
  decompose,
  setDecompose,
}: {
  slots: number;
  setSlots: (n: number) => void;
  isolate: boolean;
  setIsolate: (v: boolean) => void;
  decompose: boolean;
  setDecompose: (v: boolean) => void;
}) {
  return (
    <div className="sdd-options">
      <label>
        Parallel workers
        <input
          type="number"
          min={1}
          max={16}
          value={slots}
          onChange={(e) => setSlots(Math.max(1, Math.min(16, Number(e.target.value) || 1)))}
        />
      </label>
      <label>
        <input type="checkbox" checked={isolate} onChange={(e) => setIsolate(e.target.checked)} />{' '}
        Isolate work in Git worktrees
      </label>
      <label>
        <input
          type="checkbox"
          checked={decompose}
          onChange={(e) => setDecompose(e.target.checked)}
        />{' '}
        Decompose plan before execution
      </label>
    </div>
  );
}
