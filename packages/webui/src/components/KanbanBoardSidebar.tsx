import { useAppTranslation } from '@/i18n';
import type { KanbanBoardSummary } from '@wrongstack/kanban';
import { ArrowLeft, Columns3, Plus, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Pagination } from './ui/pagination';

type KanbanBoardSidebarProps = {
  boardTotal: number;
  activeBoardTotal: number;
  orphanedBoardTotal: number;
  activeBoardId: string | null;
  activeBoards: KanbanBoardSummary[];
  orphanedBoards: KanbanBoardSummary[];
  boardPage: number;
  boardPageSize: number;
  loading: boolean;
  newBoardTitle: string;
  onClose?: (() => void) | undefined;
  onRefresh: () => void;
  onNewBoardTitleChange: (title: string) => void;
  onCreateBoard: () => void;
  onBoardSelect: (boardId: string) => void;
  onBoardPageChange: (page: number) => void;
};

export function KanbanBoardSidebar({
  boardTotal,
  activeBoardTotal,
  orphanedBoardTotal,
  activeBoardId,
  activeBoards,
  orphanedBoards,
  boardPage,
  boardPageSize,
  loading,
  newBoardTitle,
  onClose,
  onRefresh,
  onNewBoardTitleChange,
  onCreateBoard,
  onBoardSelect,
  onBoardPageChange,
}: KanbanBoardSidebarProps) {
  const { t } = useAppTranslation();
  return (
    <aside className="flex max-h-[45dvh] w-full shrink-0 flex-col border-b bg-card/40 md:max-h-none md:w-[280px] md:border-b-0 md:border-r">
      <div className="flex h-12 items-center gap-2 border-b px-3">
        <button
          type="button"
          title={t('common:action.back')}
          onClick={onClose}
          className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <ArrowLeft size={16} />
        </button>
        <Columns3 size={17} className="text-primary" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{t('activity:kanban.kanban')}</div>
          <div className="truncate text-[11px] text-muted-foreground">
            {boardTotal} boards · {activeBoardTotal} active · {orphanedBoardTotal} orphaned
          </div>
        </div>
        <button
          type="button"
          title={t('common:action.refresh')}
          onClick={onRefresh}
          className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <RefreshCw size={15} className={loading ? 'animate-spin' : undefined} />
        </button>
      </div>

      <div className="flex gap-1 border-b p-2">
        <input
          value={newBoardTitle}
          onChange={(event) => onNewBoardTitleChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') onCreateBoard();
          }}
          placeholder={t('activity:kanban.newBoard')}
          className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1.5 text-sm outline-none focus:border-primary"
        />
        <button
          type="button"
          title={t('activity:kanban.createBoard')}
          onClick={onCreateBoard}
          className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground hover:bg-primary/90"
        >
          <Plus size={16} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
        {/* Section headings count the list rendered under them. The
            server-wide totals (activeBoardTotal / orphanedBoardTotal) use
            the server's live-session knowledge and pagination scope, so
            printing them here made the heading disagree with the visible
            rows ("Active session · 3" over 2 items). They stay on the
            summary line in the header, where server-wide is the point. */}
        {activeBoards.length > 0 && (
          <div className="mb-1 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-success">
            Active session · {activeBoards.length}
          </div>
        )}
        {activeBoards.map((board) => (
          <BoardListItem
            key={board.id}
            board={board}
            active={activeBoardId === board.id}
            dotClassName="bg-success"
            onSelect={onBoardSelect}
          />
        ))}
        {orphanedBoards.length > 0 && (
          <div className="mb-1 mt-2 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            No active session · {orphanedBoards.length}
          </div>
        )}
        {orphanedBoards.map((board) => (
          <BoardListItem
            key={board.id}
            board={board}
            active={activeBoardId === board.id}
            dotClassName="bg-muted-foreground/45"
            onSelect={onBoardSelect}
          />
        ))}
      </div>
      <Pagination
        page={boardPage}
        pageSize={boardPageSize}
        totalItems={boardTotal}
        onPageChange={onBoardPageChange}
        compact
        itemLabel="boards"
      />
    </aside>
  );
}

function BoardListItem({
  board,
  active,
  dotClassName,
  onSelect,
}: {
  board: KanbanBoardSummary;
  active: boolean;
  dotClassName: string;
  onSelect: (boardId: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(board.id)}
      className={cn(
        'mb-1 w-full rounded-md px-2 py-2 text-left transition-colors',
        active
          ? 'bg-primary/10 text-foreground'
          : 'text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      <div className="truncate text-sm font-medium">{board.title}</div>
      <div className="mt-0.5 flex items-center justify-between text-[11px]">
        <span className="inline-flex items-center gap-1">
          <span className={cn('h-1.5 w-1.5 rounded-full', dotClassName)} />
          {board.taskCount} tasks
        </span>
        <span>{board.completedTaskCount} done</span>
      </div>
    </button>
  );
}
