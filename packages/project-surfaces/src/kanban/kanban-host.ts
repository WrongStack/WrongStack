import type { KanbanBoard, KanbanTask } from '@wrongstack/kanban';
import type { ComponentType } from 'react';

export interface ModelCandidate {
  provider: string;
  /** Catalog provider type; `provider` remains the auth profile alias. */
  providerType?: string | undefined;
  model: string;
  label: string;
  description?: string | undefined;
  contextWindow?: number | undefined;
  outputModalities?: string[] | undefined;
  isFavorite?: boolean | undefined;
}

/** An agent of the fleet, as far as the board's live-session split needs it. */
export interface KanbanFleetAgent {
  id: string;
  name: string;
  status: string;
  sessionId?: string | undefined;
}

/** The live Goal or SDD run a mirror board follows. */
export interface KanbanRunTarget {
  engine: 'sdd' | 'goal';
  runId?: string | undefined;
}

/**
 * What the Kanban surfaces need from the application around them. The WebUI answers from
 * its WebSocket client and stores; the desktop from one project's engine connection.
 */
export interface KanbanHost {
  /** Sends a request on the surface's engine connection (`payload` left out when absent). */
  send(type: string, payload?: Record<string, unknown>): void;
  /** Listens for one frame type; returns the unsubscribe. */
  on(type: string, handler: (message: { payload: unknown }) => void): () => void;
  /** The conversation the board is opened from, stamped on its writes; null for none. */
  useSessionId(): string | null;
  /** Fleet agents; a running agent's session counts as live for the active/orphaned split. */
  useFleetAgents(): ReadonlyMap<string, KanbanFleetAgent>;
  /** The provider × model choices for pickers; `active` gates fetching them. */
  useModelCandidates(active: boolean): ModelCandidate[];
  /** The provider and model a task without its own runs on, when `kanban.meta` has none. */
  useDefaultModel(): { provider: string; model: string };
  /** Opens the live run a mirror board follows; when absent the board offers no link. */
  openRun?: ((run: KanbanRunTarget) => void) | undefined;
  /** Panels the application adds to a board (its own board tools). */
  BoardExtras?: ComponentType<{ board: KanbanBoard }> | undefined;
  /** Panels the application adds to the task inspector. */
  TaskExtras?: ComponentType<{ board: KanbanBoard; task: KanbanTask }> | undefined;
}
