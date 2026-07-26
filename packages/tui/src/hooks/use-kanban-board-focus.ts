import { useRef, useState } from 'react';

export function useKanbanBoardFocus(): {
  focusedBoardId: string | null;
  setFocusedBoardId: React.Dispatch<React.SetStateAction<string | null>>;
  boardFocusRef: React.MutableRefObject<{ current: (boardId: string) => boolean } | null>;
} {
  // Board id captured by `/kanban use <boardId>` or the Goal -> Kanban
  // bridge. The KanbanPanel reads it as `initialBoardId` so the panel
  // opens on the requested board rather than the session-tag fallback.
  const [focusedBoardId, setFocusedBoardId] = useState<string | null>(null);
  // Stable ref-shaped bridge so the slash command can call it through
  // `deps.onBoardFocus.current(boardId)` regardless of re-renders.
  const boardFocusRef = useRef<{ current: (boardId: string) => boolean } | null>(null);
  if (!boardFocusRef.current) {
    boardFocusRef.current = {
      current: (boardId: string) => {
        setFocusedBoardId(boardId);
        return true;
      },
    };
  }

  return { focusedBoardId, setFocusedBoardId, boardFocusRef };
}
