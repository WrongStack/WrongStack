import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { EngineCommand } from './engine-operations';
import { entries, record } from './engine-values';
import {
  type BoundaryPolicy,
  type BoundarySelector,
  boundaryErrors,
  boundaryPayload,
  boundaryPolicy,
  emptySelector,
  newBoundary,
  SELECTOR_ACCESS,
  SELECTOR_KINDS,
  sameBoundary,
} from './kanban-boundary-model';

const ACCESS_LABELS = { read_write: 'Read & write', write: 'Write', read: 'Read' } as const;

function SelectorRows({
  list,
  items,
  disabled,
  onChange,
}: {
  list: 'Allow' | 'Deny';
  items: BoundarySelector[];
  disabled: boolean;
  onChange: (items: BoundarySelector[]) => void;
}) {
  const set = (index: number, patch: Partial<BoundarySelector>) =>
    onChange(items.map((item, at) => (at === index ? { ...item, ...patch } : item)));
  return (
    <fieldset className="kanban-boundary-list" disabled={disabled}>
      <legend>
        {list} <small>{items.length}</small>
      </legend>
      {items.map((item, index) => (
        <div className="kanban-boundary-row" key={index}>
          <select
            aria-label={`${list} ${index + 1} kind`}
            value={item.kind}
            onChange={(event) =>
              set(index, { kind: event.target.value as BoundarySelector['kind'] })
            }
          >
            {SELECTOR_KINDS.map((kind) => (
              <option key={kind}>{kind}</option>
            ))}
          </select>
          <input
            aria-label={`${list} ${index + 1} path`}
            placeholder="src/feature"
            value={item.path}
            onChange={(event) => set(index, { path: event.target.value })}
          />
          <select
            aria-label={`${list} ${index + 1} access`}
            value={item.access}
            onChange={(event) =>
              set(index, { access: event.target.value as BoundarySelector['access'] })
            }
          >
            {SELECTOR_ACCESS.map((access) => (
              <option key={access} value={access}>
                {ACCESS_LABELS[access]}
              </option>
            ))}
          </select>
          <input
            aria-label={`${list} ${index + 1} note`}
            placeholder="Note (optional)"
            value={item.note}
            onChange={(event) => set(index, { note: event.target.value })}
          />
          <button
            type="button"
            aria-label={`Remove ${list.toLowerCase()} ${index + 1}`}
            onClick={() => onChange(items.filter((_, at) => at !== index))}
          >
            <Trash2 size={13} />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="button secondary small"
        onClick={() => onChange([...items, emptySelector()])}
      >
        <Plus size={12} /> Add {list.toLowerCase()} path
      </button>
    </fieldset>
  );
}

/**
 * A task's filesystem boundary, or the board's when no task is given. Board and task boundaries
 * are both evaluated, so a task can narrow its board's scope but not widen it. Saving re-reads
 * the stored boundary first and refuses to overwrite one another window changed; the engine
 * validates and normalizes every path.
 */
export function KanbanBoundaryEditor({
  task,
  board,
  boardId,
  command,
  disabled,
  onSaved,
}: {
  task?: Record<string, unknown>;
  board: Record<string, unknown>;
  boardId: string;
  command: EngineCommand;
  disabled: boolean;
  onSaved: () => Promise<void>;
}) {
  const owner = task ?? board;
  const [baseline, setBaseline] = useState(() => owner['boundary']);
  const [draft, setDraft] = useState<BoundaryPolicy | null>(() =>
    boundaryPolicy(owner['boundary']),
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const subject = task ? 'task' : 'board';
  const boardPolicy = boundaryPolicy(board['boundary']);
  const problems = draft ? boundaryErrors(draft) : [];
  const changed = !sameBoundary(draft && boundaryPayload(draft), baseline);
  const save = async () => {
    setBusy(true);
    setError('');
    setNotice('');
    const stored = async () => {
      const data = record((await command('kanban.get', { boardId }, ['kanban.get']))['data']);
      return task ? entries(data['tasks']).find((item) => item['id'] === task['id']) : data;
    };
    const boundary = draft ? boundaryPayload(draft) : null;
    try {
      const current = await stored();
      if (!current)
        throw Error(`This ${subject} was removed in another window. Nothing was saved.`);
      if (!sameBoundary(current['boundary'], baseline))
        throw Error(
          `The boundary was changed in another window since you opened this ${subject}. Reopen it to review the change before saving.`,
        );
      if (task)
        await command('kanban.task.update', { boardId, taskId: task['id'], boundary }, [
          'kanban.task.update',
        ]);
      else await command('kanban.update', { boardId, boundary }, ['kanban.update']);
      // Show what the engine stored (it normalizes paths) and compare later saves against it.
      const saved = (await stored())?.['boundary'];
      setBaseline(saved);
      setDraft(boundaryPolicy(saved));
      setNotice(
        draft
          ? `${task ? 'Task' : 'Board'} boundary saved.`
          : task
            ? 'Task boundary removed; only the board boundary applies.'
            : 'Board boundary removed; task boundaries still apply.',
      );
      await onSaved();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="kanban-boundary"
      aria-label={task ? 'Task resource boundary' : 'Board resource boundary'}
    >
      {task ? (
        <p className="field-help">
          Board boundary:{' '}
          {boardPolicy?.enabled
            ? `${boardPolicy.enforcement} · ${boardPolicy.allow.length} allow · ${boardPolicy.deny.length} deny · shell ${boardPolicy.shellAccess}`
            : 'unrestricted'}
          . Both are evaluated; this task can narrow the board's scope but not widen it.
        </p>
      ) : (
        <p className="field-help">
          Applies to every task on this board, together with each task's own boundary.
        </p>
      )}
      {draft ? (
        <>
          <label className="kanban-boundary-toggle">
            <input
              type="checkbox"
              checked={draft.enabled}
              disabled={disabled || busy}
              onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
            />
            Enforce this {subject} boundary
          </label>
          <div className="kanban-boundary-options">
            <label>
              Outside the boundary
              <select
                value={draft.enforcement}
                disabled={disabled || busy}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    enforcement: event.target.value as BoundaryPolicy['enforcement'],
                  })
                }
              >
                <option value="confirm">Ask before acting</option>
                <option value="block">Block</option>
              </select>
            </label>
            <label>
              Shell and opaque tools
              <select
                value={draft.shellAccess}
                disabled={disabled || busy}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    shellAccess: event.target.value as BoundaryPolicy['shellAccess'],
                  })
                }
              >
                <option value="allow">Allow</option>
                <option value="confirm">Ask</option>
                <option value="block">Block</option>
              </select>
            </label>
          </div>
          <SelectorRows
            list="Allow"
            items={draft.allow}
            disabled={disabled || busy}
            onChange={(allow) => setDraft({ ...draft, allow })}
          />
          {!draft.allow.length && (
            <p className="field-help">An empty allow list means no allowlist; deny rules apply.</p>
          )}
          <SelectorRows
            list="Deny"
            items={draft.deny}
            disabled={disabled || busy}
            onChange={(deny) => setDraft({ ...draft, deny })}
          />
        </>
      ) : (
        <p className="quiet-state">This {subject} has no boundary of its own.</p>
      )}
      {problems.length > 0 && (
        <ul className="session-error">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
      {error && (
        <p className="session-error" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <div className="feature-actions">
        {draft ? (
          <button
            type="button"
            className="button secondary small"
            disabled={disabled || busy}
            onClick={() => setDraft(null)}
          >
            Remove {subject} boundary
          </button>
        ) : (
          <button
            type="button"
            className="button secondary small"
            disabled={disabled || busy}
            onClick={() => setDraft(newBoundary())}
          >
            Add a {subject} boundary
          </button>
        )}
        <button
          type="button"
          className="button primary small"
          disabled={disabled || busy || !changed || problems.length > 0}
          onClick={() => void save()}
        >
          {busy ? 'Saving…' : 'Save boundary'}
        </button>
      </div>
    </section>
  );
}
