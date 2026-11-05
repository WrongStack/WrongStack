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
import { useDesktopText } from './desktop-i18n';
import type { FormDraftStorage } from './durable-form-draft';
import type { EngineHttp } from './engine-http';
import type { EngineCommand, EngineSend } from './engine-operations';
import { type EngineState, entries, record } from './engine-state';
import type { RunFocus } from './kanban-board-source';
import { ProjectRequirements } from './ProjectRequirements';
import type { RequirementDraftStorage } from './requirement-draft';
import type { RequirementRecordDraftStorageFactory } from './requirement-record-draft';
import { SddBoardDetail } from './SddBoardDetail';
import { SddDependencyGraph, SddTaskColumns } from './SddDependencyGraph';
import { SddLifecycle } from './SddLifecycle';
import { RunOptions, runModelPayload, type SddRunModel } from './SddRunOptions';
import './project-sdd.css';

const text = (value: unknown, fallback = 'Not reported') =>
  typeof value === 'string' && value ? value : fallback;
const num = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? String(value) : '—';

/** Project SDD connects directly to the interview, specifications and run protocols. */
export function ProjectSdd({
  state,
  send,
  http,
  draftStorage,
  recordDraftStorage,
  resourceInputStorage,
  onKanban,
  command,
}: {
  state: EngineState;
  send: EngineSend;
  /** Reads the profile's providers and catalog models for the worker model choice. */
  command?: EngineCommand | undefined;
  http: EngineHttp;
  draftStorage?: RequirementDraftStorage;
  recordDraftStorage?: RequirementRecordDraftStorageFactory;
  resourceInputStorage?: (formKey: string) => FormDraftStorage;
  /** Opens Kanban on the board that mirrors an SDD run. */
  onKanban?: ((focus: RunFocus) => void) | undefined;
}) {
  const { t } = useDesktopText();
  const named = (value: unknown) =>
    typeof value === 'string' && value
      ? t(`sddView.value.${value}`, { defaultValue: value.replaceAll('_', ' ') })
      : t('sddView.notReported');
  // Board actions are answered by the next board snapshot, which clears their waiting line.
  const boardRequest = useRef(false);
  const [view, setView] = useState<'requirements' | 'interview' | 'specs' | 'runs'>('interview');
  const [transfer, setTransfer] = useState<string | null>(null);
  const [goal, setGoal] = useState('');
  const [requirementsRefresh, setRequirementsRefresh] = useState(0);
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
  const [runModel, setRunModel] = useState<SddRunModel>({ provider: '', model: '' });
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
  // A spec with a saved task graph runs that graph, as the WebUI does, instead of planning anew.
  const graphId = text(
    detail?.['graphId'] ?? specs.find((row) => row['id'] === selectedSpec)?.['graphId'],
    '',
  );
  const columns = entries(detail?.['columns']);
  const boards = entries(record(state.results['sdd.board.list'])['boards']);
  const board = record(state.results['sdd.board.snapshot']);
  const runId = text(board['runId'], '');
  const tasks = entries(board['tasks']);
  const task = tasks.find((item) => item['id'] === selectedTask);
  const request = async (type: string, payload: Record<string, unknown>, description: string) => {
    setError('');
    boardRequest.current = type.startsWith('sdd.board.');
    setWaiting(t('sddView.requested', { what: description }));
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
    if (state.results['sdd.board.snapshot'] && boardRequest.current) {
      boardRequest.current = false;
      setWaiting('');
    }
  }, [state.results['sdd.board.snapshot']]);
  useEffect(() => {
    const failure = state.results['sdd.spec.error'];
    if (failure && failure !== lastError.current) {
      setWaiting('');
      setError(text(failure['message'], t('sddView.refused')));
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
    if (goal.trim())
      void request('sdd.spec.start', { goal: goal.trim() }, t('sddView.action.interview'));
  };
  const submitReply = () => {
    if (reply.trim()) {
      submittedAnswer.current = { text: reply.trim(), previousCount: answers.length };
      void request('sdd.spec.message', { text: reply.trim() }, t('sddView.action.answer'));
    }
  };
  type RunType = 'sdd.run.start' | 'sdd.run.from_spec' | 'sdd.run.from_graph';
  const beginRun = (type: RunType, target: { specId?: string; graphId?: string } = {}) => {
    setConfirm('');
    void request(
      type,
      {
        ...target,
        parallelSlots: slots,
        worktrees: isolate,
        planDecompose: decompose,
        ...runModelPayload(runModel),
      },
      t('sddView.action.run'),
    );
  };
  return (
    <section className="project-sdd" aria-label={t('sddView.label')}>
      <header className="studio-heading">
        <div>
          <h1>SDD</h1>
          <p>{t('sddView.intro')}</p>
        </div>
        <button
          type="button"
          className="button secondary"
          onClick={() => {
            for (const type of ['sdd.spec.get', 'specs.list', 'sdd.board.list', 'sdd.board.get'])
              void send(type).catch((e) => setError(String(e)));
            setRequirementsRefresh((value) => value + 1);
          }}
        >
          <RefreshCw size={14} /> {t('sddView.refresh')}
        </button>
      </header>
      <nav className="sdd-navigation" aria-label={t('sddView.nav')}>
        <button
          type="button"
          aria-pressed={view === 'requirements'}
          onClick={() => setView('requirements')}
        >
          {t('sddView.requirements')}
        </button>
        <button
          type="button"
          aria-pressed={view === 'interview'}
          onClick={() => setView('interview')}
        >
          {t('sddView.interview')}
        </button>
        <button type="button" aria-pressed={view === 'specs'} onClick={() => setView('specs')}>
          {t('sddView.specifications')} <span>{specs.length}</span>
        </button>
        <button type="button" aria-pressed={view === 'runs'} onClick={() => setView('runs')}>
          {t('sddView.runs')} <span>{boards.length}</span>
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
          <p>{t('sddView.transferAsk')}</p>
          <div className="sdd-actions">
            <button type="button" className="button secondary" onClick={() => setTransfer(null)}>
              {t('sddView.keepDraft')}
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
              {t('sddView.useRequirement')}
            </button>
          </div>
        </div>
      )}
      <div hidden={view !== 'requirements'}>
        <ProjectRequirements
          http={http}
          refreshKey={requirementsRefresh}
          {...(draftStorage ? { draftStorage } : {})}
          {...(recordDraftStorage ? { recordDraftStorage } : {})}
          {...(resourceInputStorage ? { resourceInputStorage } : {})}
          onStartSdd={(value) => {
            if (started) {
              setError(t('sddView.interviewActive'));
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
                <h2>{t('sddView.startTitle')}</h2>
                <p>{t('sddView.startHint')}</p>
                <label>
                  {t('sddView.outcome')}
                  <textarea
                    aria-label={t('sddView.outcome')}
                    value={goal}
                    onChange={(e) => setGoal(e.target.value)}
                    placeholder={t('sddView.outcomePlaceholder')}
                  />
                </label>
                <button
                  type="button"
                  className="button primary"
                  disabled={!goal.trim() || Boolean(waiting)}
                  onClick={submitGoal}
                >
                  {t('sddView.startInterview')}
                </button>
              </div>
            ) : (
              <>
                <div className="sdd-interview-head">
                  <div>
                    <span className="eyebrow">{t('sddView.interviewEyebrow')}</span>
                    <h2>{text(snapshot['title'], t('sddView.projectInterview'))}</h2>
                    <p>{text(snapshot['goal'], '')}</p>
                  </div>
                  <span className="sdd-chip">{named(phase)}</span>
                </div>
                <div className="sdd-transcript">
                  {answers.map((answer, index) => (
                    <div className="sdd-exchange" key={index}>
                      <p>
                        <strong>WrongStack</strong>
                        {text(answer['question'], '')}
                      </p>
                      <p>
                        <strong>{t('sddView.you')}</strong>
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
                      <LoaderCircle className="spin" size={14} /> {t('sddView.working')}
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
                      {t('sddView.answer')}
                      <textarea
                        aria-label={t('sddView.answer')}
                        value={reply}
                        onChange={(e) => setReply(e.target.value)}
                        placeholder={t('sddView.answerPlaceholder')}
                      />
                    </label>
                    <button
                      type="submit"
                      className="button primary"
                      disabled={!reply.trim() || busy || Boolean(waiting)}
                    >
                      {t('sddView.sendFeedback')}
                    </button>
                    <small>{t('sddView.textStays')}</small>
                  </form>
                )}
                <div className="sdd-actions">
                  {['spec_review', 'task_review'].includes(phase) && (
                    <button
                      type="button"
                      className="button primary"
                      disabled={busy || Boolean(waiting)}
                      onClick={() =>
                        void request('sdd.spec.approve', {}, t('sddView.action.approval'))
                      }
                    >
                      <CheckCircle2 size={14} />{' '}
                      {phase === 'spec_review'
                        ? t('sddView.approveSpec')
                        : t('sddView.approveTasks')}
                    </button>
                  )}
                  {['spec_review', 'implementation', 'task_review'].includes(phase) && (
                    <button
                      type="button"
                      className="button secondary"
                      disabled={busy || Boolean(waiting)}
                      onClick={() =>
                        void request('sdd.spec.rewind', {}, t('sddView.action.rewind'))
                      }
                    >
                      {t('sddView.rewind')}
                    </button>
                  )}
                  {confirm === 'discard' ? (
                    <>
                      <span>{t('sddView.discardAsk')}</span>
                      <button
                        type="button"
                        className="button secondary"
                        onClick={() => {
                          setConfirm('');
                          void request('sdd.spec.discard', {}, t('sddView.action.discard'));
                        }}
                      >
                        {t('sddView.confirmDiscard')}
                      </button>
                      <button type="button" onClick={() => setConfirm('')}>
                        {t('sddView.cancel')}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="button secondary"
                      disabled={busy || Boolean(waiting)}
                      onClick={() => setConfirm('discard')}
                    >
                      {t('sddView.discardInterview')}
                    </button>
                  )}
                </div>
                {['task_review', 'executing'].includes(phase) && (
                  <div className="sdd-run-config">
                    <h3>{t('sddView.runGraph')}</h3>
                    <RunOptions
                      slots={slots}
                      setSlots={setSlots}
                      isolate={isolate}
                      setIsolate={setIsolate}
                      decompose={decompose}
                      setDecompose={setDecompose}
                      model={runModel}
                      setModel={setRunModel}
                      command={command}
                    />
                    {confirm === 'start' ? (
                      <div className="sdd-actions">
                        <span>{t('sddView.startAsk')}</span>
                        <button
                          type="button"
                          className="button primary"
                          onClick={() => beginRun('sdd.run.start')}
                        >
                          {t('sddView.confirmStart')}
                        </button>
                        <button type="button" onClick={() => setConfirm('')}>
                          {t('sddView.cancel')}
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="button primary"
                        disabled={busy || Boolean(waiting)}
                        onClick={() => setConfirm('start')}
                      >
                        <Play size={14} /> {t('sddView.startRun')}
                      </button>
                    )}
                  </div>
                )}
              </>
            )}
          </main>
          <aside className="sdd-aside">
            <span className="eyebrow">{t('sddView.contextEyebrow')}</span>
            <h3>{t('sddView.specification')}</h3>
            {spec['title'] ? (
              <>
                <strong>{text(spec['title'])}</strong>
                <p>{text(spec['overview'], '')}</p>
                <ul>
                  {entries(spec['requirements']).map((row, i) => (
                    <li key={i}>
                      <span>{named(row['priority'])}</span>
                      {text(row['description'], '')}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p>{t('sddView.requirementsAppear')}</p>
            )}
            <div className="sdd-aside-metrics">
              <span>
                {t('sddView.questions')} <strong>{num(snapshot['questionCount'])}</strong>
              </span>
              <span>
                {t('sddView.tasks')} <strong>{num(snapshot['taskCount'])}</strong>
              </span>
            </div>
          </aside>
        </div>
      ) : view === 'specs' ? (
        <div className="sdd-spec-layout">
          <div className="sdd-list">
            <h2>{t('sddView.specifications')}</h2>
            {!state.results['specs.list'] ? (
              <p>{t('sddView.loadingSpecs')}</p>
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
                    <strong>{text(item['title'], t('sddView.untitledSpec'))}</strong>
                    <small>
                      {t('sddView.progress', {
                        count: num(item['total']),
                        status: named(item['status']),
                        completed: num(item['completed']),
                      })}
                    </small>
                  </span>
                </button>
              ))
            ) : (
              <p>{t('sddView.noSpecs')}</p>
            )}
          </div>
          <div className="sdd-spec-detail">
            {!selectedSpec ? (
              <div className="sdd-empty">
                <FileText size={26} />
                <h2>{t('sddView.selectSpec')}</h2>
                <p>{t('sddView.selectSpecHint')}</p>
              </div>
            ) : !detail ? (
              <div className="sdd-empty">
                <LoaderCircle className="spin" size={22} />
                <p>{t('sddView.loadingSpec')}</p>
              </div>
            ) : detail['notFound'] ? (
              <div className="sdd-empty">
                <h2>{t('sddView.graphUnavailable')}</h2>
                <p>{t('sddView.graphUnavailableHint')}</p>
              </div>
            ) : (
              <>
                <button type="button" className="goal-back" onClick={() => setSelectedSpec('')}>
                  <ArrowLeft size={14} /> {t('sddView.allSpecs')}
                </button>
                <h2>{text(detail['title'], t('sddView.specification'))}</h2>
                <p>{text(detail['overview'], '')}</p>
                <nav className="sdd-graph-controls" aria-label={t('sddView.specViewLabel')}>
                  <button
                    type="button"
                    className="button secondary"
                    aria-pressed={specView === 'list'}
                    onClick={() => setSpecView('list')}
                  >
                    {t('sddView.taskList')}
                  </button>
                  <button
                    type="button"
                    className="button secondary"
                    aria-pressed={specView === 'graph'}
                    onClick={() => setSpecView('graph')}
                  >
                    {t('sddView.dependencyGraph')}
                  </button>
                </nav>
                {specView === 'graph' ? (
                  <SddDependencyGraph columns={columns} />
                ) : (
                  <SddTaskColumns columns={columns} />
                )}
                <div className="sdd-run-config">
                  <h3>{t('sddView.runSpec')}</h3>
                  {graphId && <p>{t('sddView.runsSavedGraph')}</p>}
                  <RunOptions
                    slots={slots}
                    setSlots={setSlots}
                    isolate={isolate}
                    setIsolate={setIsolate}
                    decompose={decompose}
                    setDecompose={setDecompose}
                    model={runModel}
                    setModel={setRunModel}
                    command={command}
                  />
                  {confirm === 'run-spec' ? (
                    <div className="sdd-actions">
                      <span>{t('sddView.startAsk')}</span>
                      <button
                        type="button"
                        className="button primary"
                        onClick={() =>
                          graphId
                            ? beginRun('sdd.run.from_graph', { graphId })
                            : beginRun('sdd.run.from_spec', { specId: selectedSpec })
                        }
                      >
                        {t('sddView.confirmStart')}
                      </button>
                      <button type="button" onClick={() => setConfirm('')}>
                        {t('sddView.cancel')}
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="button primary"
                      disabled={Boolean(waiting)}
                      onClick={() => setConfirm('run-spec')}
                    >
                      <Play size={14} /> {t('sddView.runAsSdd')}
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
            <h2>{t('sddView.projectRuns')}</h2>
            {!state.results['sdd.board.list'] ? (
              <p>{t('sddView.loadingRuns')}</p>
            ) : boards.length ? (
              boards.map((item) => (
                <article key={String(item['runId'])}>
                  <strong>{text(item['title'], t('sddView.sddRun'))}</strong>
                  <small>
                    {t('sddView.progress', {
                      count: num(item['total']),
                      status: named(item['status']),
                      completed: num(item['completed']),
                    })}
                  </small>
                  <small>
                    {item['runId'] === runId ? t('sddView.currentShown') : t('sddView.historical')}
                  </small>
                </article>
              ))
            ) : (
              <p>{t('sddView.noRuns')}</p>
            )}
          </div>
          <div className="sdd-board">
            {!runId ? (
              <div className="sdd-empty">
                <Workflow size={26} />
                <h2>{t('sddView.noCurrent')}</h2>
                <p>{t('sddView.noCurrentHint')}</p>
              </div>
            ) : (
              <>
                <span className="eyebrow">{t('sddView.currentBoard')}</span>
                <h2>{text(board['title'], t('sddView.sddRun'))}</h2>
                <div className="sdd-actions">
                  <span className="sdd-chip">{named(board['status'])}</span>
                  {onKanban && (
                    <button
                      type="button"
                      className="button secondary"
                      title={t('sddView.openBoardTitle')}
                      onClick={() => onKanban({ system: 'sdd', runId })}
                    >
                      {t('sddView.openBoard')}
                    </button>
                  )}
                  {board['status'] === 'running' && (
                    <button
                      type="button"
                      className="button secondary"
                      onClick={() =>
                        void request('sdd.board.pause', { runId }, t('sddView.action.pause'))
                      }
                    >
                      {t('sddView.pause')}
                    </button>
                  )}
                  {board['status'] === 'paused' && (
                    <button
                      type="button"
                      className="button secondary"
                      onClick={() =>
                        void request('sdd.board.resume', { runId }, t('sddView.action.resume'))
                      }
                    >
                      {t('sddView.resume')}
                    </button>
                  )}
                  {['running', 'paused'].includes(String(board['status'])) &&
                    (confirm === 'stop' ? (
                      <>
                        <span>{t('sddView.stopAsk')}</span>
                        <button
                          type="button"
                          className="button secondary"
                          onClick={() => {
                            setConfirm('');
                            void request('sdd.board.stop', { runId }, t('sddView.action.stop'));
                          }}
                        >
                          {t('sddView.confirmStop')}
                        </button>
                        <button type="button" onClick={() => setConfirm('')}>
                          {t('sddView.cancel')}
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="button secondary"
                        onClick={() => setConfirm('stop')}
                      >
                        {t('sddView.stop')}
                      </button>
                    ))}
                </div>
                <div className="sdd-progress">
                  <strong>
                    {num(record(board['progress'])['completed'])} /{' '}
                    {num(record(board['progress'])['total'])}
                  </strong>
                  <span>{t('sddView.tasksCompleted')}</span>
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
                      <strong>{text(item['title'], t('sddView.task'))}</strong>
                      <span>{named(item['displayStatus'] ?? item['status'])}</span>
                    </button>
                  ))}
                </div>
                <SddBoardDetail
                  task={task}
                  tasks={tasks}
                  board={board}
                  waiting={Boolean(waiting)}
                  request={request}
                  onSelect={setSelectedTask}
                />
              </>
            )}
          </div>
          <SddLifecycle state={state} board={board} boards={boards} send={send} />
        </div>
      )}
    </section>
  );
}
