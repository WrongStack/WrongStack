import { Plus, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

/** Tasks the engine's `kanban.generate` makes from a list: one per non-empty line. */
export function boardListTasks(text: string): string[] {
  // Mirrors `parseLinesIntoTasks` in @wrongstack/kanban: a leading "-", "*" or "#" is dropped.
  return text
    .split('\n')
    .map((line) => line.replace(/^\s*[-*#]\s*/, '').trim())
    .filter(Boolean);
}

const PREVIEW = 50;

/**
 * Creates an empty board, or a board whose tasks come from a pasted list (`kanban.generate`):
 * each line becomes a task in the first column with medium priority. Nothing is inferred.
 */
export function BoardDialog({
  busy,
  onClose,
  onCreate,
  onGenerate,
}: {
  busy: boolean;
  onClose: () => void;
  onCreate: (title: string, description: string) => void;
  onGenerate: (title: string, list: string) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  const [mode, setMode] = useState<'empty' | 'list'>('empty'),
    [title, setTitle] = useState(''),
    [description, setDescription] = useState(''),
    [list, setList] = useState('');
  const tasks = boardListTasks(list);
  return (
    <dialog ref={ref} className="modal" aria-label="Create project board" onCancel={onClose}>
      <header>
        <div>
          <span className="eyebrow">PROJECT PLANNING</span>
          <h2>A place for the work.</h2>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="Cancel board creation"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </header>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (mode === 'list') onGenerate(title.trim(), list);
          else onCreate(title.trim(), description);
        }}
      >
        <fieldset className="board-create-mode">
          <legend>Start with</legend>
          <label>
            <input
              type="radio"
              name="board-create-mode"
              checked={mode === 'empty'}
              onChange={() => setMode('empty')}
            />
            An empty board
          </label>
          <label>
            <input
              type="radio"
              name="board-create-mode"
              checked={mode === 'list'}
              onChange={() => setMode('list')}
            />
            Tasks from a list
          </label>
        </fieldset>
        <label>
          Board name
          <input
            aria-label="Board name"
            required
            autoFocus
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Product roadmap"
          />
        </label>
        {mode === 'empty' ? (
          <label>
            Description
            <textarea
              aria-label="Board description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={3}
              placeholder="What does this board help your project accomplish?"
            />
          </label>
        ) : (
          <>
            <label>
              Tasks, one per line
              <textarea
                aria-label="Board task list"
                value={list}
                onChange={(event) => setList(event.target.value)}
                rows={8}
                placeholder={'- Design the schema\n- Write the migration\n- Add the API route'}
              />
            </label>
            <p className="field-help">
              Each non-empty line becomes one task in the first column with medium priority; a
              leading "-", "*" or "#" is removed. Nothing else is inferred: add details, checks and
              dependencies on the board afterwards. The list is also kept as the board description.
            </p>
            {tasks.length > 0 && (
              <section aria-label="Tasks to create" className="board-create-preview">
                <strong>
                  {tasks.length} {tasks.length === 1 ? 'task' : 'tasks'}
                </strong>
                <ol>
                  {tasks.slice(0, PREVIEW).map((task, index) => (
                    <li key={`${index}:${task}`}>{task}</li>
                  ))}
                </ol>
                {tasks.length > PREVIEW && <p>…and {tasks.length - PREVIEW} more.</p>}
              </section>
            )}
          </>
        )}
        <footer>
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="button primary"
            disabled={busy || !title.trim() || (mode === 'list' && tasks.length === 0)}
          >
            <Plus size={14} />
            {mode === 'list' ? `Create board with ${tasks.length} tasks` : 'Create board'}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
