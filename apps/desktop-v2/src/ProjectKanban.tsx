import type { KanbanBoard, KanbanTask } from '@wrongstack/kanban';
import { bindKanbanFrames } from '@wrongstack/project-surfaces/kanban/frames';
import { KanbanView } from '@wrongstack/project-surfaces/kanban/KanbanView';
import { resetKanbanStore, useKanbanStore } from '@wrongstack/project-surfaces/kanban/kanban-store';
import { useEffect, useMemo, useRef } from 'react';
import { desktopKanbanHost } from './desktop-kanban-host';
import { desktopSurfaceHost } from './desktop-surface-host';
import type { EngineHttp } from './engine-http';
import type { EngineCommand } from './engine-operations';
import { backendStream } from './engine-stream';
import { journalTail } from './journal-tail';
import { KanbanBoardTools } from './KanbanBoardTools';
import { KanbanTaskTools } from './KanbanTaskTools';
import { type BoardSource, type RunFocus, runBoardId } from './kanban-board-source';
import { SurfaceFrame, useSurfaceConfirm } from './SurfaceFrame';
import './kanban.css';
import './kanban-tools.css';

/** A run whose mirror board should be shown; `nonce` distinguishes repeated requests. */
export type KanbanFocus = RunFocus & { nonce: number };

/**
 * A project's Kanban: the WebUI's own board (sidebar, columns, focus, tree, contracts and
 * verification views, the task inspector, supervisor and run controls) on this project's
 * engine, with the desktop's board and task tools beside it.
 */
export function ProjectKanban({
  projectId,
  http,
  command,
  focus = null,
  onOpenSource,
}: {
  projectId: string;
  http: EngineHttp;
  command: EngineCommand;
  focus?: KanbanFocus | null | undefined;
  /** Opens the Goal or SDD view that owns a mirror board's run. */
  onOpenSource?: ((source: BoardSource) => void) | undefined;
}) {
  const confirm = useSurfaceConfirm();
  const openSource = useRef(onOpenSource);
  openSource.current = onOpenSource;
  const surface = useMemo(() => {
    const base = desktopSurfaceHost(
      backendStream('project', projectId),
      journalTail(projectId),
      http,
      confirm.confirm,
    );
    const select = (boardId: string) => {
      useKanbanStore.getState().setActiveBoardId(boardId);
      base.send({ type: 'kanban.get', payload: { boardId } });
    };
    const BoardExtras = ({ board }: { board: KanbanBoard }) => (
      <KanbanBoardTools command={command} board={board} onSelectBoard={select} />
    );
    const TaskExtras = ({ board, task }: { board: KanbanBoard; task: KanbanTask }) => (
      <KanbanTaskTools command={command} board={board} task={task} />
    );
    const kanban = desktopKanbanHost({
      client: base.host.getClient(),
      send: base.send,
      openRun: (run) =>
        openSource.current?.({
          system: run.engine,
          runId: run.runId ?? '',
          phaseId: '',
          phaseName: '',
        }),
      BoardExtras,
      TaskExtras,
    });
    return { host: { ...base.host, kanban }, attach: base.attach, select };
  }, [projectId, http, command, confirm.confirm]);

  // A project shows only its own boards: the store is shared module state.
  useEffect(() => {
    resetKanbanStore();
    const detach = surface.attach();
    const unbind = bindKanbanFrames(surface.host.kanban.on);
    return () => {
      unbind();
      detach();
    };
  }, [surface]);

  // A run asked for its board: select the board mirroring it once the list has it.
  const boards = useKanbanStore((state) => state.boards);
  const handled = useRef(0);
  useEffect(() => {
    if (!focus || handled.current === focus.nonce) return;
    const boardId = runBoardId(boards as unknown as Record<string, unknown>[], focus);
    if (!boardId) return;
    handled.current = focus.nonce;
    surface.select(boardId);
  }, [focus, boards, surface]);

  return (
    <SurfaceFrame host={surface.host} confirm={confirm} fill>
      <div className="kanban-surface">
        <KanbanView />
      </div>
    </SurfaceFrame>
  );
}
