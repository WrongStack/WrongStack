import { useEffect, useRef, useState } from 'react';
import type { TodoCounts } from '../components/status-bar-types.js';

const TODOS_CLEAR_DELAY_MS = 3000;

export function useTodosAutoClear(todos: TodoCounts | undefined): boolean {
  const [todosCleared, setTodosCleared] = useState(false);
  const todosClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const hasActive = todos && (todos.pending > 0 || todos.inProgress > 0);

    if (hasActive) {
      if (todosClearTimerRef.current) {
        clearTimeout(todosClearTimerRef.current);
        todosClearTimerRef.current = null;
      }
      setTodosCleared(false);
      return;
    }

    if (todos && todos.completed > 0) {
      if (!todosClearTimerRef.current) {
        todosClearTimerRef.current = setTimeout(() => {
          setTodosCleared(true);
          todosClearTimerRef.current = null;
        }, TODOS_CLEAR_DELAY_MS);
      }
      return () => {
        if (todosClearTimerRef.current) {
          clearTimeout(todosClearTimerRef.current);
          todosClearTimerRef.current = null;
        }
      };
    }

    setTodosCleared(true);
    return;
  }, [todos]);

  return todosCleared;
}
