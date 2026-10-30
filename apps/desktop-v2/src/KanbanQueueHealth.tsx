import { Activity, Wrench } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { EngineCommand } from './engine-operations';
import { record } from './engine-values';
import { auditMessage, auditOutcome, type BoardHealth, boardHealth } from './kanban-health';
import { Modal } from './Modal';

/**
 * Queue health of one board, read without changing it. An audit is a separate, confirmed
 * action: it reconciles card states and returns expired assignments to the queue.
 */
export function KanbanQueueHealth({
  command,
  boardId,
  revision,
  disabled,
  onOpenTask,
  onAudited,
}: {
  command: EngineCommand;
  boardId: string;
  /** Changes whenever the board was reloaded, so health is read again. */
  revision: unknown;
  disabled: boolean;
  onOpenTask: (taskId: string) => void;
  onAudited: () => Promise<void>;
}) {
  const [health, setHealth] = useState<BoardHealth | null>(null);
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [auditing, setAuditing] = useState(false);
  const [outcome, setOutcome] = useState('');
  const generation = useRef(0);
  const load = useCallback(async () => {
    const run = ++generation.current;
    try {
      const reply = await command('kanban.health', { boardId }, ['kanban.health']);
      if (run !== generation.current) return;
      setHealth(boardHealth(reply['data']));
      setError('');
    } catch (failure) {
      if (run !== generation.current) return;
      setHealth(null);
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }, [boardId, command]);
  useEffect(() => {
    void revision;
    void load();
  }, [load, revision]);
  useEffect(() => setOutcome(''), [boardId]);
  const audit = async () => {
    setAuditing(true);
    setOutcome('');
    try {
      const reply = await command('kanban.supervisor.audit', { boardId }, [
        'kanban.supervisor.audit',
      ]);
      const observed = auditOutcome(record(reply)['data']);
      setOutcome(
        observed
          ? auditMessage(observed)
          : 'The engine finished the audit without reporting what it did.',
      );
      setConfirm(false);
      await onAudited();
      await load();
    } catch (failure) {
      setOutcome(
        `Audit did not complete: ${failure instanceof Error ? failure.message : String(failure)}`,
      );
      setConfirm(false);
    } finally {
      setAuditing(false);
    }
  };
  return (
    <section className="kanban-health" aria-label="Queue health">
      <header>
        <Activity size={14} />
        <strong>Queue health</strong>
        {health && (
          <ul className="kanban-health-counts">
            {health.counts.map((item) => (
              <li key={item.label}>
                {item.label} <b>{item.value}</b>
              </li>
            ))}
          </ul>
        )}
        <button
          type="button"
          className="button secondary small"
          disabled={disabled || auditing}
          title="Reconcile card states and return expired assignments to the queue"
          onClick={() => setConfirm(true)}
        >
          <Wrench size={13} />
          Audit queue…
        </button>
      </header>
      {error && (
        <p role="alert" className="session-error">
          Queue health could not be read: {error}
        </p>
      )}
      {outcome && <p role="status">{outcome}</p>}
      {health?.issues.map((issue) => (
        <details key={issue.key} className="kanban-health-issue">
          <summary title={issue.hint}>
            {issue.label} · {issue.count}
          </summary>
          <p>{issue.hint}</p>
          {issue.tasks.map((task) => (
            <button
              type="button"
              key={task.id}
              className="kanban-health-task"
              onClick={() => onOpenTask(task.id)}
            >
              {task.title}
            </button>
          ))}
          {issue.count > issue.tasks.length && (
            <small>{issue.count - issue.tasks.length} more not listed by the engine.</small>
          )}
        </details>
      ))}
      {confirm && (
        <Modal title="Audit this board’s queue" onClose={() => !auditing && setConfirm(false)}>
          <p>
            The audit moves cards to the state their assignment implies and, using this board’s
            recovery mode, returns cards whose worker lease has expired to the queue. Cards with a
            live lease keep their assignment; managed boards change only through their own
            transitions.
          </p>
          <div className="modal-actions">
            <button
              type="button"
              className="button secondary"
              disabled={auditing}
              onClick={() => setConfirm(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="button primary"
              disabled={auditing}
              onClick={() => void audit()}
            >
              {auditing ? 'Auditing…' : 'Audit and repair'}
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
