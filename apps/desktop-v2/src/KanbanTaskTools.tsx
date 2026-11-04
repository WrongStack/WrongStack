import type { KanbanBoard, KanbanTask } from '@wrongstack/kanban';
import { useKanbanStore } from '@wrongstack/project-surfaces/kanban/kanban-store';
import { useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';
import { KanbanTaskTransfer } from './KanbanTaskTransfer';

/**
 * Task tools the desktop keeps beside the shared inspector: chaining, merging, metrics and
 * moving the card to another board, and releasing a worker's claim.
 */
export function KanbanTaskTools({
  command,
  board,
  task,
}: {
  command: EngineCommand;
  board: KanbanBoard;
  task: KanbanTask;
}) {
  const { t } = useDesktopText();
  const boards = useKanbanStore((state) => state.boards);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const claimed = ['queued', 'running'].includes(String(task.assignment?.status ?? ''));
  const release = async () => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await command(
        'kanban.task.release',
        {
          boardId: board.id,
          taskId: task.id,
          reason: 'Released explicitly from desktop.',
          status: 'ready',
        },
        ['kanban.task.release'],
        { timeoutMs: 45000 },
      );
      setNotice(t('kanbanTask.released'));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="kanban-desktop-task-tools" aria-label={t('kanbanTask.tools')}>
      <KanbanTaskTransfer
        command={command}
        board={board as unknown as Record<string, unknown>}
        task={task as unknown as Record<string, unknown>}
        boards={boards as unknown as Record<string, unknown>[]}
        disabled={busy}
        onDone={async () => undefined}
      />
      {claimed && (
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={() => void release()}
        >
          {t('kanbanTask.release')}
        </button>
      )}
      {notice && <p className="field-help">{notice}</p>}
      {error && (
        <p role="alert" className="session-error">
          {error}
        </p>
      )}
    </section>
  );
}
