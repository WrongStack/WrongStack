import type { EventBus } from '@wrongstack/contracts/kernel';
import type { Logger } from '@wrongstack/contracts/types';
import type { Agent, Context } from '@wrongstack/core/agent';
import type { AgentFactory } from '@wrongstack/core/coordination';
import type {
  GoalRunPersistence,
  PhaseGraph,
  PhaseNode,
  PhaseOrchestrator,
  PhaseStore,
  PhaseTemplate,
} from '@wrongstack/goal';
import type { WorktreeManager } from '@wrongstack/core/worktree';
import type { WebSocket } from 'ws';
import type { GoalWsRunControlsHost } from './goal-ws-run-controls.js';

export interface WSClient {
  ws: WebSocket;
  id: string;
  cleanup: () => void;
}

export interface GoalWSMessage {
  type: string;
  payload?: Record<string, unknown>;
}

/**
 * The live `GoalWebSocketHandler` instance as seen by its extracted helper
 * modules (message dispatch, multi-Goal routing, host builders). The handler
 * hands out `this` cast to this shape after a compile-time `satisfies` check,
 * so helpers read and write the owner's real fields and call its real methods.
 */
export interface GoalWsHandlerInternals extends GoalWsRunControlsHost {
  readonly goals: Map<string, GoalWsHandlerInternals>;
  readonly selections: WeakMap<WebSocket, string>;
  readonly clients: Set<WSClient>;
  catalogInFlight: boolean;
  catalogTimer: ReturnType<typeof setInterval> | null;
  disposed: boolean;
  broadcastInterval: ReturnType<typeof setInterval> | null;
  lastGraphFingerprint: string;
  lastProgressJson: string;
  readOnly: boolean;
  stopGeneration: number;
  assessSeq: number;
  readonly agent: Agent;
  readonly context: Context;
  readonly logger: Logger;
  readonly events: EventBus | undefined;
  readonly taskAgentFactory: AgentFactory | undefined;
  readonly onBoardState: ((graphId: string, state: Record<string, unknown>) => void) | undefined;
  store: PhaseStore;
  persistence: GoalRunPersistence;
  worktrees: WorktreeManager | null;
  addClient(ws: WebSocket): void;
  dispose(): void;
  handleMessage(ws: WebSocket, msg: GoalWSMessage): Promise<void>;
  handleAssess(ws: WebSocket, payload?: Record<string, unknown>): Promise<void>;
  handleStart(payload?: Record<string, unknown>): Promise<void>;
  handleResumeGraph(graphId: string): Promise<void>;
  handleClear(): Promise<void>;
  handleRevert(): Promise<void>;
  planPhases(goal: string, signal?: AbortSignal): Promise<PhaseTemplate[]>;
  executeTaskWithAgent(
    task: import('@wrongstack/contracts/types').TaskNode,
    phaseId: string,
    env?: { cwd?: string | undefined; branch?: string | undefined },
    signal?: AbortSignal | undefined,
  ): Promise<unknown>;
  runRepairPhase(
    phase: PhaseNode,
    failure: string,
    attempt: number,
    env?: { cwd?: string | undefined; branch?: string | undefined },
  ): Promise<void>;
  runChimeraReview(
    task: import('@wrongstack/contracts/types').TaskNode,
    phaseId: string,
    result: unknown,
    cwd?: string | undefined,
  ): Promise<void>;
  persistDetached(graph: PhaseGraph): void;
  afterBoardMutation(): void;
  startBroadcast(): void;
  sendState(client: WSClient): void;
  broadcastCatalog(): Promise<void>;
  orchestrator: PhaseOrchestrator | null;
}
