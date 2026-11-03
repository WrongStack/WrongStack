import { useMemo } from 'react';
import { useSurfaceHost } from '../host';
import type { KanbanHost, ModelCandidate } from './kanban-host';

export type {
  KanbanFleetAgent,
  KanbanHost,
  KanbanRunTarget,
  ModelCandidate,
} from './kanban-host';

export function useKanbanHost(): KanbanHost {
  const kanban = useSurfaceHost().kanban;
  if (!kanban) throw new Error('The Kanban surfaces rendered without a Kanban host.');
  return kanban;
}

/** The provider × model choices for pickers; `active` gates fetching them. */
export function useModelCandidates(active: boolean): ModelCandidate[] {
  return useKanbanHost().useModelCandidates(active);
}

export interface KanbanSocket {
  send(message: { type: string; payload?: unknown }): void;
  on(type: string, handler: (message: { payload: unknown }) => void): () => void;
}

/** The host's connection in the `{ type, payload }` shape the Kanban views were written for. */
export function useKanbanSocket(): KanbanSocket {
  const host = useKanbanHost();
  return useMemo(
    () => ({
      send: (message) =>
        host.send(
          message.type,
          message.payload === undefined ? undefined : (message.payload as Record<string, unknown>),
        ),
      on: (type, handler) => host.on(type, handler),
    }),
    [host],
  );
}
