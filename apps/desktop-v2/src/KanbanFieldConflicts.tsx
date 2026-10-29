import type { FieldConflict } from './task-definition-model';

const show = (value: unknown) =>
  value === null || value === ''
    ? '(empty)'
    : Array.isArray(value)
      ? value.join(', ') || '(none)'
      : String(value);

/** Same-field changes made elsewhere since the inspector opened, with an explicit choice. */
export function KanbanFieldConflicts({
  conflicts,
  busy,
  onKeepMine,
  onKeepTheirs,
}: {
  conflicts: FieldConflict[];
  busy: boolean;
  onKeepMine: () => void;
  onKeepTheirs: () => void;
}) {
  return (
    <section className="kanban-field-conflicts" aria-label="Changed elsewhere" role="alert">
      <strong>Changed in another window since you opened this task</strong>
      <ul>
        {conflicts.map((conflict) => (
          <li key={conflict.field}>
            <span>{conflict.field}</span>
            <span>
              Theirs: <code>{show(conflict.theirs)}</code>
            </span>
            <span>
              Yours: <code>{show(conflict.mine)}</code>
            </span>
          </li>
        ))}
      </ul>
      <div className="feature-actions">
        <button
          type="button"
          className="button secondary small"
          disabled={busy}
          onClick={onKeepTheirs}
        >
          Keep theirs for these fields
        </button>
        <button type="button" className="button primary small" disabled={busy} onClick={onKeepMine}>
          Save mine for these fields
        </button>
      </div>
    </section>
  );
}
