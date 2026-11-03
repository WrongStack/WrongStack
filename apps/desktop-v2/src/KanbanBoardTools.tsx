import type { KanbanBoard } from '@wrongstack/kanban';
import { Download, ListPlus, Network } from 'lucide-react';
import { useState } from 'react';
import type { EngineCommand } from './engine-operations';
import { record } from './engine-values';
import { BoardDialog } from './KanbanBoardDialog';
import { KanbanContractMap } from './KanbanContractMap';

/** Saves the board as a task graph JSON file (`kanban.taskgraph.export`; read-only). */
async function exportTaskGraph(command: EngineCommand, boardId: string, title: string) {
  const reply = await command('kanban.taskgraph.export', { boardId }, ['kanban.taskgraph.export']);
  const graph = record(reply['data'])['taskGraph'];
  if (!graph) throw Error('The engine did not return a task graph.');
  const link = document.createElement('a');
  link.href = URL.createObjectURL(
    new Blob([JSON.stringify(graph, null, 2)], { type: 'application/json' }),
  );
  link.download = `${title.replace(/[^a-z0-9-]+/gi, '-') || 'board'}.taskgraph.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

/**
 * Board tools the desktop keeps beside the shared board: editing the contract map, exporting
 * the task graph and starting a board from a list of tasks.
 */
export function KanbanBoardTools({
  command,
  board,
  onSelectBoard,
}: {
  command: EngineCommand;
  board: KanbanBoard;
  onSelectBoard: (boardId: string) => void;
}) {
  const [dialog, setDialog] = useState<'contracts' | 'generate' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  const created = (reply: Record<string, unknown>) => {
    const id = record(reply['data'])['id'];
    if (typeof id === 'string') onSelectBoard(id);
    setDialog(null);
  };
  return (
    <div className="kanban-desktop-tools" role="toolbar" aria-label="Board tools">
      <button type="button" className="button secondary" onClick={() => setDialog('contracts')}>
        <Network size={13} /> Contract map…
      </button>
      <button
        type="button"
        className="button secondary"
        title="Cards, dependencies and status as a task graph JSON file; the board is not changed."
        disabled={busy}
        onClick={() => void run(() => exportTaskGraph(command, board.id, board.title))}
      >
        <Download size={13} /> Export task graph
      </button>
      <button type="button" className="button secondary" onClick={() => setDialog('generate')}>
        <ListPlus size={13} /> New board from a list…
      </button>
      {error && (
        <p role="alert" className="session-error">
          {error}
        </p>
      )}
      {dialog === 'contracts' && (
        <KanbanContractMap
          command={command}
          board={board as unknown as Record<string, unknown>}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'generate' && (
        <BoardDialog
          busy={busy}
          onClose={() => setDialog(null)}
          onCreate={(title, description) =>
            void run(async () =>
              created(await command('kanban.create', { title, description }, ['kanban.create'])),
            )
          }
          onGenerate={(title, list) =>
            void run(async () =>
              created(
                await command('kanban.generate', { title, description: list }, ['kanban.generate']),
              ),
            )
          }
        />
      )}
    </div>
  );
}
