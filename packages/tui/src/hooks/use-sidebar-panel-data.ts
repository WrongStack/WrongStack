/**
 * Data hooks for sidebar panel twins.
 *
 * These hooks lift the data sources used by the bottom-region panels
 * (ProcessList, Kanban, Connections) into the shared `app-view.tsx`
 * runtime scope so the sidebar twins can receive real data instead of
 * hardcoded empty arrays.
 *
 * Each hook is self-contained: it manages its own refresh interval and
 * cleanup. The hooks must be called unconditionally (rules of hooks), but
 * polling is gated by the `enabled` flag — app-view passes whether the
 * twin currently occupies a visible sidebar slot. While a panel is closed
 * or routed to the bottom region no polling runs (the bottom panels run
 * their own polling when open), so the session pays no IPC probes or disk
 * reads for panels nobody is looking at. Each hook performs an immediate
 * first read when enabled, so data is fresh the moment the twin mounts.
 */

import { getProcessRegistry } from '@wrongstack/tools';
import { useEffect, useState } from 'react';

// ─────────────────────────────────────────────────────────────────────────
// ProcessList data
// ─────────────────────────────────────────────────────────────────────────

export interface SidebarProcess {
  pid: number;
  name: string;
  status: string;
}

/**
 * Read the live process registry. Refreshes every 2 seconds (only while
 * `enabled`) so elapsed times and newly spawned/killed processes are
 * reflected.
 */
export function useSidebarProcessList(enabled = true): {
  activeCount: number;
  totalCount: number;
  processes: readonly SidebarProcess[];
} {
  const [data, setData] = useState<{
    activeCount: number;
    totalCount: number;
    processes: readonly SidebarProcess[];
  }>({ activeCount: 0, totalCount: 0, processes: [] });

  useEffect(() => {
    if (!enabled) return;
    const read = () => {
      const registry = getProcessRegistry();
      const all = registry.list();
      const processes: SidebarProcess[] = all.slice(0, 10).map((p) => ({
        pid: p.pid,
        name: p.command?.split(' ')[0]?.split(/[\\/]/).pop() ?? `pid:${p.pid}`,
        status: p.killed ? 'killed' : 'running',
      }));
      const activeCount = all.filter((p) => !p.killed).length;
      setData({ activeCount, totalCount: all.length, processes });
    };
    read();
    const id = setInterval(read, 2000);
    return () => clearInterval(id);
  }, [enabled]);

  return data;
}

// ─────────────────────────────────────────────────────────────────────────
// Connections health data
// ─────────────────────────────────────────────────────────────────────────

export interface SidebarConnection {
  name: string;
  status: 'ok' | 'warn' | 'down' | 'unknown';
  latencyMs?: number | undefined;
}

/**
 * Poll connections health every 8 seconds (only while `enabled`). The
 * collection function lives in `connections-health.ts` and mirrors the
 * WebUI server's shape. We map the richer `ConnectionHealthService` status
 * into the sidebar's 4-state enum so the sidebar twin stays simple.
 */
export function useSidebarConnections(
  projectRoot: string,
  enabled = true,
): readonly SidebarConnection[] {
  const [connections, setConnections] = useState<readonly SidebarConnection[]>([]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const { collectConnectionsHealth } = await import('../connections-health.js');
        const report = await collectConnectionsHealth(projectRoot);
        if (cancelled) return;
        const mapped: SidebarConnection[] = report.services.map((s) => ({
          name: s.label,
          status:
            s.status === 'healthy'
              ? 'ok'
              : s.status === 'degraded'
                ? 'warn'
                : s.status === 'offline' || s.status === 'error'
                  ? 'down'
                  : 'unknown',
          latencyMs: s.latencyMs,
        }));
        setConnections(mapped);
      } catch {
        if (!cancelled) setConnections([]);
      }
    };
    poll();
    const id = setInterval(poll, 8000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [projectRoot, enabled]);

  return connections;
}

// ─────────────────────────────────────────────────────────────────────────
// Kanban board data
// ─────────────────────────────────────────────────────────────────────────

export interface SidebarKanbanColumn {
  name: string;
  count: number;
}

/**
 * Load the kanban board summary for the sidebar. Uses `listBoards()` to
 * find the most recently used board, then fetches its column counts.
 * Refreshes every 10 seconds (only while `enabled`).
 */
export function useSidebarKanban(
  projectRoot: string,
  enabled = true,
): {
  columns: readonly SidebarKanbanColumn[];
  totalActive: number;
  activeCardTitles: readonly string[];
} {
  const [data, setData] = useState<{
    columns: readonly SidebarKanbanColumn[];
    totalActive: number;
    activeCardTitles: readonly string[];
  }>({ columns: [], totalActive: 0, activeCardTitles: [] });

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const { listBoards, getBoard } = await import('@wrongstack/kanban');
        const boards = await listBoards(projectRoot);
        if (cancelled || boards.length === 0) return;
        // Pick the first board (most recently created).
        const boardId = boards[0]?.id;
        if (!boardId) return;
        const board = await getBoard(projectRoot, boardId);
        if (cancelled || !board) return;
        // Aggregate column counts.
        const columnMap = new Map<string, number>();
        let totalActive = 0;
        const activeTitles: string[] = [];
        for (const col of board.columns ?? []) {
          const tasks = board.tasks?.filter((t) => t.columnId === col.id) ?? [];
          const count = tasks.length;
          columnMap.set(col.title, count);
          totalActive += count;
          // Collect titles from non-done columns.
          if (col.title.toLowerCase() !== 'done') {
            for (const t of tasks.slice(0, 3)) {
              if (t.title) activeTitles.push(t.title);
            }
          }
        }
        const columns: SidebarKanbanColumn[] = [...columnMap.entries()].map(([name, count]) => ({
          name,
          count,
        }));
        setData({ columns, totalActive, activeCardTitles: activeTitles.slice(0, 6) });
      } catch {
        if (!cancelled) setData({ columns: [], totalActive: 0, activeCardTitles: [] });
      }
    };
    poll();
    const id = setInterval(poll, 10000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [projectRoot, enabled]);

  return data;
}
