'use client';

/**
 * Loads a project's Kanban boards from `/api/projects/:id/kanban`.
 *
 * Refreshes on a slow timer AND whenever a `kanban.snapshot` event lands, so a
 * board changed on another machine appears without waiting out the poll.
 * Every request carries a sequence number: a response for a project the
 * operator has since left is dropped, never painted.
 */
import { fetchJson } from '@hq/data/api';
import { useHqStore } from '@hq/data/store/index';
import {
  type HqKanbanBoardView,
  projectKanbanBoards,
  projectKanbanUrl,
} from '@hq/domain/kanban-model';
import type { HqKanbanSnapshotPayload } from '@wrongstack/hq';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const REFRESH_INTERVAL_MS = 10_000;

export interface KanbanBoards {
  boards: readonly HqKanbanBoardView[];
  generatedAt: string | undefined;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  refresh: () => void;
}

export function useKanbanBoards(projectId: string | null): KanbanBoards {
  const kanbanEventId = useHqStore((state) => {
    for (let index = state.events.length - 1; index >= 0; index -= 1) {
      const event = state.events[index];
      if (event?.type === 'kanban.snapshot') return event.id;
    }
    return null;
  });
  const [payload, setPayload] = useState<HqKanbanSnapshotPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);
  const lastEventId = useRef(kanbanEventId);

  const load = useCallback(
    async (foreground: boolean): Promise<void> => {
      if (projectId === null) return;
      const request = ++sequence.current;
      if (foreground) setLoading(true);
      else setRefreshing(true);
      try {
        const next = await fetchJson<HqKanbanSnapshotPayload>(projectKanbanUrl(projectId));
        if (request !== sequence.current) return;
        setPayload(next);
        setError(null);
      } catch (cause) {
        if (request !== sequence.current) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (request === sequence.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [projectId],
  );

  // A different project invalidates everything on screen at once.
  useEffect(() => {
    sequence.current += 1;
    setPayload(null);
    setError(null);
    setLoading(false);
    setRefreshing(false);
    if (projectId === null) return;
    void load(true);
    const timer = window.setInterval(() => void load(false), REFRESH_INTERVAL_MS);
    return () => {
      sequence.current += 1;
      window.clearInterval(timer);
    };
  }, [load, projectId]);

  useEffect(() => {
    if (kanbanEventId === null || kanbanEventId === lastEventId.current) return;
    lastEventId.current = kanbanEventId;
    void load(false);
  }, [kanbanEventId, load]);

  const boards = useMemo(() => (payload === null ? [] : projectKanbanBoards(payload)), [payload]);
  return {
    boards,
    generatedAt: payload?.generatedAt,
    loading,
    refreshing,
    error,
    refresh: () => void load(false),
  };
}
