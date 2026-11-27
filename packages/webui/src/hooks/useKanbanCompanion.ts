import { useCallback, useEffect, useRef } from 'react';
import { setKanbanCompanionEnabled, syncKanbanCompanionScope } from '@/lib/kanban-companion-wire';
import { useConfigStore } from '@/stores/config-store';
import { useKanbanCompanionStore } from '@/stores/kanban-companion-store';
import { useSessionStore } from '@/stores/session-store';

export interface KanbanCompanionController {
  /** Server-confirmed switch for the active project; null = not known yet. */
  enabled: boolean | null;
  /** A `kanban.companion.set` is in flight; the switch blocks while true. */
  pending: boolean;
  /** Raw failure message from the last failed get/set; null when healthy. */
  error: string | null;
  /** True while the WebSocket is open; the switch blocks while false. */
  open: boolean;
  /** Ask the server to flip the switch; state updates only on the reply. */
  toggle: () => void;
}

/**
 * Shared controller for the project-wide Kanban Companion switch. The composer
 * Companion popover and the settings CompanionAgentsSection both read the same
 * server-confirmed state through this hook, so the two menus can never
 * disagree with each other or with the server.
 *
 * Scope = (connection generation, project root): a reconnect or a project
 * switch re-syncs via `kanban.companion.get`, and `kanban.companion.status`
 * broadcasts keep every client of the project in sync afterwards. State is
 * non-optimistic — the switch only moves when the server confirms.
 */
export function useKanbanCompanion(): KanbanCompanionController {
  const wsStatus = useConfigStore((s) => s.wsStatus);
  const projectRoot = useSessionStore((s) => s.projectRoot);
  const open = wsStatus.state === 'open';

  // Count connection generations so a reconnect re-syncs even when the project
  // root is unchanged: the flag may have moved while the socket was down.
  const connectionGen = useRef(0);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) connectionGen.current += 1;
    wasOpen.current = open;
    if (!open) return;
    syncKanbanCompanionScope(`${connectionGen.current}:${projectRoot ?? ''}`);
  }, [open, projectRoot]);

  const enabled = useKanbanCompanionStore((s) => s.enabled);
  const pending = useKanbanCompanionStore((s) => s.pending);
  const error = useKanbanCompanionStore((s) => s.error);

  const toggle = useCallback(() => {
    setKanbanCompanionEnabled(!(useKanbanCompanionStore.getState().enabled ?? false));
  }, []);

  return { enabled, pending, error, open, toggle };
}
