import type { KanbanVerificationReport } from '@wrongstack/webui-server';
import {
  CheckCircle2,
  Clock3,
  Maximize2,
  MessageSquare,
  Minimize2,
  Save,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { EngineCommand } from './engine-operations';
import { entries, record } from './engine-values';
import { KanbanBoundaryEditor } from './KanbanBoundaryEditor';
import { KanbanBreakdown } from './KanbanBreakdown';
import { KanbanExecution } from './KanbanExecution';
import { KanbanFieldConflicts } from './KanbanFieldConflicts';
import { MarkdownContent } from './MarkdownContent';
import {
  type FieldConflict,
  sameFieldConflicts,
  taskDefinitionPatch,
} from './task-definition-model';

type Row = Record<string, unknown>;
const text = (value: unknown) => (typeof value === 'string' ? value : '');
const words = (value: unknown) => (Array.isArray(value) ? value.map(String) : []);
const date = (value: unknown) =>
  value ? new Date(String(value)).toLocaleString() : 'Not recorded';
export function KanbanTaskInspector({
  task,
  board,
  columns,
  columnId,
  busy,
  command,
  onRefresh,
  onSelect,
  onClose,
  onMove,
  onSave,
  onDelete,
}: {
  task: Row | null;
  board: Row;
  columns: Row[];
  columnId: string;
  busy: boolean;
  command: EngineCommand;
  onRefresh: () => Promise<void>;
  onSelect: (task: Row) => void;
  onClose: () => void;
  onMove: (id: string) => void;
  onSave: (draft: Row) => void;
  onDelete: () => void;
}) {
  const [title, setTitle] = useState(text(task?.['title']));
  const [baseline] = useState(task);
  const [description, setDescription] = useState(text(task?.['description']));
  const [priority, setPriority] = useState(text(task?.['priority']) || 'medium');
  const [type, setType] = useState(text(task?.['type']) || 'chore');
  const [status, setStatus] = useState(text(task?.['status']) || 'pending');
  const [labels, setLabels] = useState(words(task?.['labels']).join(', '));
  const [due, setDue] = useState(text(task?.['dueDate']).slice(0, 10));
  const [estimate, setEstimate] = useState(String(task?.['estimatedHours'] ?? ''));
  const [actual, setActual] = useState(String(task?.['actualHours'] ?? ''));
  const [dependencies, setDependencies] = useState(words(task?.['dependsOn']));
  const [retry, setRetry] = useState(text(task?.['retryPolicy']) || 'off');
  const [ceiling, setCeiling] = useState(String(task?.['costCeilingUsd'] ?? ''));
  const [removing, setRemoving] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [conflicts, setConflicts] = useState<{
    fields: FieldConflict[];
    patch: Row;
  } | null>(null);
  /**
   * Re-reads the task before saving an edit: fields someone else changed to another value since
   * this inspector opened are shown for an explicit choice instead of being overwritten.
   */
  const saveChecked = async (patch: Row) => {
    setError('');
    setConflicts(null);
    try {
      const result = await command('kanban.get', { boardId: board['id'] }, ['kanban.get']);
      const current = entries(record(result['data'])['tasks']).find(
        (item) => item['id'] === baseline?.['id'],
      );
      if (!current) {
        setError('This task was removed in another window. Nothing was saved.');
        return;
      }
      const fields = baseline ? sameFieldConflicts(baseline, current, patch) : [];
      // The engine refuses the write atomically if the task changes again after this read.
      const versioned =
        typeof current['updatedAt'] === 'string'
          ? { ...patch, expectedUpdatedAt: current['updatedAt'] }
          : patch;
      if (fields.length) setConflicts({ fields, patch: versioned });
      else onSave(versioned);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };
  const [check, setCheck] = useState('');
  const [note, setNote] = useState('');
  const [events, setEvents] = useState<Row[]>([]);
  const [activityError, setActivityError] = useState('');
  const [lens, setLens] = useState('definition');
  const [expanded, setExpanded] = useState(false);
  const [checkType, setCheckType] = useState('manual');
  const disabled = busy || working;
  const taskId = text(task?.['id']);
  const boardId = text(board['id']);
  const managed = record(board['lifecycle'])['mode'] === 'managed';
  const allTasks = entries(board['tasks']);
  const checks = entries(task?.['successCriteria']);
  const report = record(task?.['verificationReport']) as Partial<KanbanVerificationReport>;
  const loadActivity = useCallback(async () => {
    if (!taskId) return;
    try {
      const reply = await command('kanban.task.activity', { boardId, taskId, limit: 80 }, [
        'kanban.task.activity',
      ]);
      setEvents(entries(record(reply['data'])['events']));
      setActivityError('');
    } catch (e) {
      setActivityError(String(e instanceof Error ? e.message : e));
    }
  }, [command, boardId, taskId]);
  useEffect(() => {
    void loadActivity();
  }, [loadActivity]);
  const mutate = async (action: string, payload: Row, clear?: () => void) => {
    setWorking(true);
    setError('');
    try {
      await command(action, { boardId, taskId, ...payload }, [action], {
        timeoutMs: action === 'kanban.task.verify' ? 360000 : 45000,
      });
      clear?.();
      await onRefresh();
      await loadActivity();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  };
  return (
    <aside
      className={`task-inspector task-inspector-rich ${expanded ? 'task-inspector-expanded' : ''}`}
      aria-label="Task details"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && expanded) {
          e.preventDefault();
          setExpanded(false);
        }
      }}
    >
      <header>
        <div className="task-inspector-heading">
          <span className="eyebrow">{task ? 'TASK DETAILS' : 'NEW TASK'}</span>
          <strong>{String(task?.['title'] ?? 'A new piece of work')}</strong>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label={expanded ? 'Restore task panel' : 'Expand task details'}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Close task details"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </header>
      {task && (
        <div className="task-status-spine">
          <span className={`task-priority priority-${task['priority']}`}>
            {String(task['priority'])}
          </span>
          <strong>
            {text(record(task['lifecycle'])['currentStage']) ||
              text(task['status']).replaceAll('_', ' ')}
          </strong>
          <small>
            {checks.filter((c) => c['status'] === 'passed').length}/{checks.length} checks passed
          </small>
        </div>
      )}
      {error && (
        <p className="session-error" role="alert">
          {error}
        </p>
      )}
      {task && (
        <nav className="task-detail-nav" aria-label="Task detail sections">
          {['definition', 'execution', 'boundary', 'evidence', 'breakdown', 'history'].map(
            (section) => (
              <button
                type="button"
                key={section}
                aria-current={lens === section ? 'page' : undefined}
                onClick={() => setLens(section)}
              >
                {section[0]!.toUpperCase() + section.slice(1)}
              </button>
            ),
          )}
        </nav>
      )}
      <form
        hidden={lens !== 'definition'}
        onSubmit={(event) => {
          event.preventDefault();
          const draft = {
            title: title.trim(),
            description,
            priority,
            labels: labels
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean),
            dueDate: due || null,
            ...(task
              ? {
                  type,
                  ...(managed ? {} : { status }),
                  dependsOn: dependencies,
                  estimatedHours: Number(estimate || 0),
                  actualHours: Number(actual || 0),
                  retryPolicy: retry,
                  costCeilingUsd: ceiling ? Number(ceiling) : null,
                  activityNote: 'Task definition updated in desktop.',
                }
              : {}),
          };
          if (baseline) void saveChecked(taskDefinitionPatch(baseline, draft));
          else onSave(draft);
        }}
      >
        <label>
          Title
          <input
            aria-label="Task title"
            required
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label>
          Description
          <textarea
            aria-label="Task description"
            rows={5}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Outcome, context, and acceptance expectations"
          />
        </label>
        <div className="inspector-two-fields">
          <label>
            Priority
            <select
              aria-label="Task priority"
              value={priority}
              onChange={(e) => setPriority(e.target.value)}
            >
              {['low', 'medium', 'high', 'critical'].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </label>
          <label>
            Move to
            <select
              aria-label="Task column"
              disabled={!task || disabled}
              value={String(task?.['columnId'] ?? columnId)}
              onChange={(e) => onMove(e.target.value)}
            >
              {columns.map((c) => (
                <option value={String(c['id'])} key={String(c['id'])}>
                  {String(c['title'])}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label>
          Labels
          <input
            aria-label="Task labels"
            value={labels}
            onChange={(e) => setLabels(e.target.value)}
            placeholder="release, frontend"
          />
        </label>
        <label>
          Due date
          <input
            type="date"
            aria-label="Task due date"
            value={due}
            onChange={(e) => setDue(e.target.value)}
          />
        </label>
        {task && (
          <details className="task-detail-section" open>
            <summary>Contract & dependencies</summary>
            <div className="inspector-two-fields">
              <label>
                Work type
                <select
                  aria-label="Task type"
                  value={type}
                  onChange={(e) => setType(e.target.value)}
                >
                  {['feature', 'bugfix', 'refactor', 'docs', 'test', 'chore'].map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </label>
              {managed ? (
                <div>
                  <span className="field-help">Status</span>
                  <p>Managed by lifecycle transitions</p>
                </div>
              ) : (
                <label>
                  Status
                  <select
                    aria-label="Task status"
                    value={status}
                    onChange={(e) => setStatus(e.target.value)}
                  >
                    {[
                      'pending',
                      'ready',
                      'in_progress',
                      'blocked',
                      'review',
                      'completed',
                      'failed',
                      'archived',
                    ].map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            <div className="inspector-two-fields">
              <label>
                Estimated hours
                <input
                  type="number"
                  min="0"
                  step="0.25"
                  aria-label="Task estimated hours"
                  value={estimate}
                  onChange={(e) => setEstimate(e.target.value)}
                />
              </label>
              <label>
                Actual hours
                <input
                  type="number"
                  min="0"
                  step="0.25"
                  aria-label="Task actual hours"
                  value={actual}
                  onChange={(e) => setActual(e.target.value)}
                />
              </label>
            </div>
            <fieldset className="task-dependencies">
              <legend>Blocked by</legend>
              {allTasks
                .filter((t) => t['id'] !== taskId)
                .map((t) => (
                  <label key={String(t['id'])}>
                    <input
                      type="checkbox"
                      checked={dependencies.includes(String(t['id']))}
                      onChange={(e) =>
                        setDependencies(
                          e.target.checked
                            ? [...dependencies, String(t['id'])]
                            : dependencies.filter((id) => id !== t['id']),
                        )
                      }
                    />
                    <span>
                      {String(t['title'])}
                      <small>{String(t['status']).replaceAll('_', ' ')}</small>
                    </span>
                  </label>
                ))}
              {allTasks.length < 2 && <p>No other tasks on this board.</p>}
            </fieldset>
            <div className="inspector-two-fields">
              <label>
                Retry policy
                <select
                  aria-label="Task retry policy"
                  value={retry}
                  onChange={(e) => setRetry(e.target.value)}
                >
                  {['off', 'incremental', 'exponential'].map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </label>
              <label>
                Cost ceiling (USD)
                <input
                  aria-label="Task cost ceiling"
                  type="number"
                  min="0"
                  step="0.01"
                  value={ceiling}
                  onChange={(e) => setCeiling(e.target.value)}
                  placeholder="No ceiling"
                />
              </label>
            </div>
          </details>
        )}
        {conflicts && (
          <KanbanFieldConflicts
            conflicts={conflicts.fields}
            busy={disabled}
            onKeepMine={() => {
              const { patch } = conflicts;
              setConflicts(null);
              onSave(patch);
            }}
            onKeepTheirs={() => {
              const keep = Object.fromEntries(
                Object.entries(conflicts.patch).filter(
                  ([field]) => !conflicts.fields.some((item) => item.field === field),
                ),
              );
              setConflicts(null);
              // Only the activity note left: nothing of mine remains to save.
              if (
                Object.keys(keep).some(
                  (field) => field !== 'activityNote' && field !== 'expectedUpdatedAt',
                )
              )
                onSave(keep);
              else void onRefresh().then(onClose);
            }}
          />
        )}
        <button type="submit" className="button primary full" disabled={disabled || !title.trim()}>
          <Save size={14} />
          {busy ? 'Saving…' : 'Save task'}
        </button>
      </form>
      {task && (
        <>
          <details className="task-detail-section" open hidden={lens !== 'evidence'}>
            <summary>
              <CheckCircle2 size={15} />
              Acceptance checks <small>{checks.length}</small>
            </summary>
            {checks.map((c) => (
              <div className="task-check-row" key={String(c['id'])}>
                <div>
                  <strong>{String(c['description'])}</strong>
                  <small>
                    {String(c['type'])}
                    {c['checkedBy'] ? ` · ${c['checkedBy']}` : ''}
                  </small>
                  {Boolean(c['notes']) && <p>{String(c['notes'])}</p>}
                </div>
                <select
                  aria-label={`Check status: ${c['description']}`}
                  disabled={disabled}
                  value={String(c['status'])}
                  onChange={(e) =>
                    void mutate('kanban.task.check.update', {
                      checkId: c['id'],
                      status: e.target.value,
                      activityNote: 'Check reviewed in desktop.',
                    })
                  }
                >
                  {['pending', 'passed', 'failed', 'skipped'].map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </div>
            ))}
            {!checks.length && (
              <p>No acceptance checks yet. Define observable outcomes before execution.</p>
            )}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void mutate(
                  'kanban.task.check.add',
                  {
                    description: check.trim(),
                    checkType,
                    activityNote: 'Acceptance check added in desktop.',
                  },
                  () => setCheck(''),
                );
              }}
            >
              <label>
                New acceptance check
                <input
                  aria-label="New acceptance check"
                  value={check}
                  onChange={(e) => setCheck(e.target.value)}
                  required
                />
              </label>
              <label>
                Check type
                <select
                  aria-label="Acceptance check type"
                  value={checkType}
                  onChange={(e) => setCheckType(e.target.value)}
                >
                  {[
                    'manual',
                    'test',
                    'review',
                    'command',
                    'file_exists',
                    'file_matches',
                    'git_diff',
                    'metric',
                    'agent',
                    'council',
                  ].map((type) => (
                    <option key={type} value={type}>
                      {type.replaceAll('_', ' ')}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="submit"
                className="button secondary"
                disabled={disabled || !check.trim()}
              >
                Add check
              </button>
            </form>
          </details>
          <details className="task-detail-section" open hidden={lens !== 'evidence'}>
            <summary>
              <ShieldCheck size={15} />
              Verification & scope
            </summary>
            <div className="task-verdict">
              <strong>{text(report['verdict']).replaceAll('_', ' ') || 'Unverified'}</strong>
              <small>
                {report['completedAt']
                  ? date(report['completedAt'])
                  : 'No completion verification has been recorded.'}
              </small>
            </div>
            <p className="field-help">
              Verification executes the configured acceptance checks against this project and
              persists its report.
            </p>
            <button
              type="button"
              className="button primary"
              disabled={disabled}
              onClick={() => void mutate('kanban.task.verify', {})}
            >
              <ShieldCheck size={14} />
              {working
                ? 'Verifying…'
                : report['verdict']
                  ? 'Re-run verification'
                  : 'Run verification'}
            </button>
            {Boolean(report['markdownSummary']) && (
              <MarkdownContent text={String(report['markdownSummary'])} />
            )}
            {entries(report['checks']).map((c, i) => (
              <div className="task-proof" key={String(c['checkId'] ?? i)}>
                <strong>{String(c['description'])}</strong>
                <span>{String(c['status'])}</span>
                {Boolean(c['error']) && <p>{String(c['error'])}</p>}
                {entries(c['backingRefs']).map((ref, j) => (
                  <p key={j}>
                    <code>{String(ref['path'])}</code> — {String(ref['summary'])}
                  </p>
                ))}
              </div>
            ))}
            {entries(report['attachments']).map((attachment, i) => (
              <details className="task-proof-attachment" key={i}>
                <summary>{String(attachment['label'] ?? attachment['kind'])}</summary>
                <pre>{String(attachment['content'] ?? attachment['path'] ?? 'No content')}</pre>
              </details>
            ))}
            {entries(task['expectedFileChanges']).map((f, i) => (
              <p className="task-file-scope" key={i}>
                <span>{String(f['operation'])}</span>
                <code>{String(f['path'])}</code>
              </p>
            ))}
            {entries(record(report['fileScope'])['files']).map((f, i) => (
              <p className="task-file-scope" key={i}>
                <span>{f['expected'] ? 'in scope' : 'outside scope'}</span>
                <code>{String(f['path'])}</code>
                <small>{String(f['linesChanged'] ?? 0)} lines</small>
              </p>
            ))}
            {Boolean(task['park']) && (
              <p className="session-error">
                Parked:{' '}
                {String(record(task['park'])['reason'] ?? 'Verification refusal budget reached')}
              </p>
            )}
            {Boolean(task['atomicityAssessment']) && (
              <p>
                Atomicity:{' '}
                {String(record(task['atomicityAssessment'])['verdict']).replaceAll('_', ' ')}
              </p>
            )}
            {entries(task['goalMetrics']).map((m, i) => (
              <p key={i}>
                {String(m['name'])} · {String(m['current'] ?? '—')} / {String(m['target'] ?? '—')}{' '}
                {String(m['unit'] ?? '')} · {String(m['status'])}
              </p>
            ))}
            {allTasks
              .filter(
                (t) =>
                  t['parentTaskId'] === taskId ||
                  t['id'] === task['parentTaskId'] ||
                  words(task['childTaskIds']).includes(String(t['id'])),
              )
              .map((t) => (
                <button
                  type="button"
                  className="task-related"
                  key={String(t['id'])}
                  onClick={() => onSelect(t)}
                >
                  {String(t['title'])}
                  <small>{String(t['status'])}</small>
                </button>
              ))}
          </details>
          <section hidden={lens !== 'execution'}>
            <KanbanExecution
              key={taskId}
              task={task}
              boardId={boardId}
              command={command}
              disabled={disabled}
              onRefresh={async () => {
                await onRefresh();
                await loadActivity();
              }}
            />
          </section>
          <section hidden={lens !== 'boundary'}>
            <KanbanBoundaryEditor
              key={taskId}
              task={task}
              board={board}
              boardId={boardId}
              command={command}
              disabled={disabled}
              onSaved={onRefresh}
            />
          </section>
          <section hidden={lens !== 'breakdown'}>
            <KanbanBreakdown
              key={`${taskId}-${record(task['decomposition'])['id'] ?? 'manual'}`}
              task={task}
              board={board}
              command={command}
              onRefresh={onRefresh}
              onSelect={onSelect}
              disabled={disabled}
            />
          </section>
          <details className="task-detail-section" open hidden={lens !== 'history'}>
            <summary>
              <MessageSquare size={15} />
              Notes <small>{entries(task['notes']).length}</small>
            </summary>
            {entries(task['notes']).map((n) => (
              <article className="task-note" key={String(n['id'])}>
                <header>
                  <strong>{String(n['author'])}</strong>
                  <time>{date(n['createdAt'])}</time>
                </header>
                <p>{String(n['content'])}</p>
              </article>
            ))}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void mutate(
                  'kanban.task.note.add',
                  { content: note.trim(), author: 'desktop-user' },
                  () => setNote(''),
                );
              }}
            >
              <label>
                Add context
                <textarea
                  aria-label="New task note"
                  rows={3}
                  value={note}
                  required
                  onChange={(e) => setNote(e.target.value)}
                />
              </label>
              <button
                type="submit"
                className="button secondary"
                disabled={disabled || !note.trim()}
              >
                Add note
              </button>
            </form>
          </details>
          <details className="task-detail-section" open hidden={lens !== 'history'}>
            <summary>
              <Clock3 size={15} />
              Activity & provenance <small>{events.length}</small>
            </summary>
            {activityError && <p role="alert">{activityError}</p>}
            <button type="button" className="button secondary" onClick={() => void loadActivity()}>
              Refresh activity
            </button>
            <ol className="task-timeline">
              {events.map((e) => (
                <li key={String(e['id'])}>
                  <strong>
                    {text(e['type'])
                      .replace(/^kanban\./, '')
                      .replaceAll('.', ' ')
                      .replaceAll('_', ' ')}
                  </strong>
                  <p>{text(e['note']) || 'Task state updated'}</p>
                  <small>
                    {String(e['actor'] ?? 'engine')} · {date(e['ts'])}
                  </small>
                </li>
              ))}
            </ol>
            <dl className="task-facts">
              <div>
                <dt>Created</dt>
                <dd>{date(task['createdAt'])}</dd>
              </div>
              <div>
                <dt>Updated</dt>
                <dd>{date(task['updatedAt'])}</dd>
              </div>
              <div>
                <dt>Task ID</dt>
                <dd>
                  <code>{taskId}</code>
                </dd>
              </div>
            </dl>
          </details>
          <div className="task-danger-zone" hidden={lens !== 'definition'}>
            {removing ? (
              <>
                <p>Remove this task from the project board?</p>
                <button
                  type="button"
                  className="button secondary danger"
                  disabled={disabled}
                  onClick={onDelete}
                >
                  Remove task
                </button>
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => setRemoving(false)}
                >
                  Keep task
                </button>
              </>
            ) : (
              <button
                type="button"
                className="button secondary danger full"
                onClick={() => setRemoving(true)}
              >
                <Trash2 size={13} />
                Delete task
              </button>
            )}
          </div>
        </>
      )}
    </aside>
  );
}
