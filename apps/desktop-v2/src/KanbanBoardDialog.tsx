import { Plus, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useDesktopText } from './desktop-i18n';

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
  const { t } = useDesktopText();
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
    <dialog
      ref={ref}
      className="modal"
      aria-label={t('kanbanBoard.createLabel')}
      onCancel={onClose}
    >
      <header>
        <div>
          <span className="eyebrow">{t('kanbanBoard.eyebrow')}</span>
          <h2>{t('kanbanBoard.title')}</h2>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label={t('kanbanBoard.cancelLabel')}
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
          <legend>{t('kanbanBoard.startWith')}</legend>
          <label>
            <input
              type="radio"
              name="board-create-mode"
              checked={mode === 'empty'}
              onChange={() => setMode('empty')}
            />
            {t('kanbanBoard.empty')}
          </label>
          <label>
            <input
              type="radio"
              name="board-create-mode"
              checked={mode === 'list'}
              onChange={() => setMode('list')}
            />
            {t('kanbanBoard.list')}
          </label>
        </fieldset>
        <label>
          {t('kanbanBoard.name')}
          <input
            aria-label={t('kanbanBoard.name')}
            required
            autoFocus
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={t('kanbanBoard.namePlaceholder')}
          />
        </label>
        {mode === 'empty' ? (
          <label>
            {t('kanbanBoard.description')}
            <textarea
              aria-label={t('kanbanBoard.descriptionLabel')}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={3}
              placeholder={t('kanbanBoard.descriptionPlaceholder')}
            />
          </label>
        ) : (
          <>
            <label>
              {t('kanbanBoard.tasks')}
              <textarea
                aria-label={t('kanbanBoard.tasksLabel')}
                value={list}
                onChange={(event) => setList(event.target.value)}
                rows={8}
                placeholder={t('kanbanBoard.tasksPlaceholder')}
              />
            </label>
            <p className="field-help">{t('kanbanBoard.tasksHelp')}</p>
            {tasks.length > 0 && (
              <section aria-label={t('kanbanBoard.preview')} className="board-create-preview">
                <strong>
                  {tasks.length === 1
                    ? t('kanbanBoard.taskOne')
                    : t('kanbanBoard.taskMany', { number: tasks.length })}
                </strong>
                <ol>
                  {tasks.slice(0, PREVIEW).map((task, index) => (
                    <li key={`${index}:${task}`}>{task}</li>
                  ))}
                </ol>
                {tasks.length > PREVIEW && (
                  <p>{t('kanbanBoard.more', { number: tasks.length - PREVIEW })}</p>
                )}
              </section>
            )}
          </>
        )}
        <footer>
          <button type="button" className="button secondary" onClick={onClose}>
            {t('kanbanBoard.cancel')}
          </button>
          <button
            type="submit"
            className="button primary"
            disabled={busy || !title.trim() || (mode === 'list' && tasks.length === 0)}
          >
            <Plus size={14} />
            {mode === 'list'
              ? t('kanbanBoard.createWith', { count: tasks.length })
              : t('kanbanBoard.create')}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
