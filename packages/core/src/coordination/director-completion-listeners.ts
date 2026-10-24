import { randomUUID } from 'node:crypto';
import type { BridgeMessage } from '@wrongstack/contracts/types/agent-bridge';
import type { Logger } from '@wrongstack/contracts/types/logger';
import type { TaskResult, TaskSpec } from '@wrongstack/contracts/types/multi-agent';
import type { SessionWriter } from '@wrongstack/contracts/types/session';
import type { DirectorStateCheckpoint } from '../storage/director-state.js';
import { toErrorMessage } from '../utils/error.js';
import type { InMemoryAgentBridge } from './agent-bridge.js';
import type { DirectorBudgetPolicy } from './director/director-budget-policy.js';
import type { DirectorTaskRegistry } from './director/director-task-registry.js';
import type { DirectorOptions } from './director-options.js';
import { completeDirectorTask } from './director-task-completion.js';
import type { FleetUsageAggregator } from './fleet-bus.js';
import type { FleetManager } from './fleet-manager.js';
import type { DefaultMultiAgentCoordinator } from './multi-agent-coordinator.js';
export interface DirectorCompletionListenersHost {
  tasks: DirectorTaskRegistry;
  subagentIdleDelayMs: Map<string, number | undefined>;
  subagentIdleTimeoutMs: number | undefined;
  taskResultNotifier: DirectorOptions['taskResultNotifier'];
  manifestEntries: Map<string, unknown>;
  logger: Logger | undefined;
  stateCheckpoint: DirectorStateCheckpoint | null;
  usage: FleetUsageAggregator;
  fleetManager: FleetManager | undefined;
  retireSubagentOnTaskComplete: boolean;
  armSubagentIdleRetirement(subagentId: string, delayMs: number | undefined): void;
  appendSessionEvent(event: Parameters<SessionWriter['append']>[0]): Promise<void>;
  scheduleManifest(): void;
  budgetPolicy: DirectorBudgetPolicy;
  subagentBridges: Map<string, InMemoryAgentBridge>;
  id: string;
  bridge: InMemoryAgentBridge;
  coordinator: DefaultMultiAgentCoordinator;
}

export function handleTaskCompleted(
  host: DirectorCompletionListenersHost,
  payload: { task: TaskSpec; result: TaskResult },
): void {
  completeDirectorTask(
    {
      tasks: host.tasks,
      subagentIdleDelayMs: host.subagentIdleDelayMs,
      subagentIdleTimeoutMs: host.subagentIdleTimeoutMs,
      taskResultNotifier: host.taskResultNotifier,
      manifestEntries: host.manifestEntries,
      logger: host.logger,
      stateCheckpoint: host.stateCheckpoint,
      usage: host.usage,
      fleetManager: host.fleetManager,
      retireSubagentOnTaskComplete: host.retireSubagentOnTaskComplete,
      armSubagentIdleRetirement: (id, delay) => host.armSubagentIdleRetirement(id, delay),
      appendSessionEvent: (event) => host.appendSessionEvent(event),
      scheduleManifest: () => host.scheduleManifest(),
    },
    payload,
  );
}

export function extensionsFor(host: DirectorCompletionListenersHost, subagentId: string): number {
  return host.budgetPolicy.extensionsFor(subagentId);
}

export async function ask<T = unknown>(
  host: DirectorCompletionListenersHost,
  subagentId: string,
  payload: unknown,
  timeoutMs?: number,
): Promise<T> {
  if (!host.subagentBridges.has(subagentId)) {
    throw new Error(
      `ask: unknown subagent "${subagentId}" (spawn() it first; current fleet: ${Array.from(host.subagentBridges.keys()).join(', ') || '(empty)'})`,
    );
  }
  const msg: BridgeMessage = {
    id: randomUUID(),
    type: 'task',
    from: host.id,
    to: subagentId,
    payload,
    timestamp: Date.now(),
    priority: 'normal',
  };
  const reply = await host.bridge.request<T>(msg, timeoutMs);
  return reply.payload;
}

export function on(
  host: DirectorCompletionListenersHost,
  event: 'task.completed',
  handler: (payload: { task: TaskSpec; result: TaskResult }) => void,
): () => void {
  host.coordinator.on(event, handler);
  return () => {
    host.coordinator.off(event, handler);
  };
}

export function logShutdownError(
  _host: DirectorCompletionListenersHost,
  phase: string,
  err: unknown,
): void {
  const detail = toErrorMessage(err);
  process.emitWarning(
    `Director shutdown phase "${phase}" failed: ${detail}`,
    'DirectorShutdownWarning',
  );
}
