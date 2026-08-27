import type { Context } from '@wrongstack/core/agent';
import type { JournalEntry } from '@wrongstack/core/goal';
import type { EventBus } from '@wrongstack/core/kernel';
import type { SecretScrubber } from '@wrongstack/core/types';
import {
  createEternalSubscription,
  type PendingConfirm,
  setupEvents as setupCanonicalEvents,
} from '@wrongstack/webui-server';
import type { StreamCoalescer } from './stream-coalescer.js';

export interface SetupEventsDeps {
  events: EventBus;
  agent: { ctx: Context };
  /**
   * The Context of a NAMED session, without creating one.
   *
   * Event payloads describe the session that produced them, and the iteration
   * ceiling they carry is a per-tab setting — read off the leader it told a
   * background tab it was capped at a number the user set in another tab.
   */
  sessionContext?: ((sessionId: string) => Context | undefined) | undefined;
  subscribeEternalIteration?: ((fn: (entry: JournalEntry) => void) => () => void) | undefined;
  broadcast: (msg: { type: string; payload: unknown }) => void;
  sessionPayload: <T extends Record<string, unknown>>(payload: T) => T & { sessionId: string };
  currentSessionId: () => string;
  queueTextDelta: StreamCoalescer['queueTextDelta'];
  queueThinkingDelta: StreamCoalescer['queueThinkingDelta'];
  queueToolProgress: StreamCoalescer['queueToolProgress'];
  flushThinkingDelta: StreamCoalescer['flushThinkingDelta'];
  flushAllStreamBuffers: StreamCoalescer['flushAllStreamBuffers'];
  pendingConfirms: Map<string, PendingConfirm>;
  secretScrubber: SecretScrubber;
  getClients: Parameters<typeof createEternalSubscription>[2];
  eventUnsubscribers: Array<() => void>;
  globalConfigPath?: string | undefined;
  onFleetBroadcaster?: ((fn: () => Promise<void>) => void) | undefined;
  /**
   * Live fleet budget snapshot (issue #323). Merged into
   * `fleet.concurrency_update` so the WebUI can show used/remaining spawns
   * without a probe spawn.
   */
  getFleetBudget?:
    | (() => {
        maxSpawns?: number | undefined;
        usedSpawns?: number | undefined;
        remainingSpawns?: number | undefined;
        maxConcurrent?: number | undefined;
        activeAgents?: number | undefined;
        maxSpawnsSource?: string | undefined;
        maxConcurrentSource?: string | undefined;
        effectiveSource?: string | undefined;
        checkpointMaxSpawns?: number | undefined;
        ceilingMismatch?: boolean | undefined;
      } | null)
    | undefined;
}

/** CLI adapter around the canonical EventBus→WebSocket subscription graph. */
export function createSetupEvents(deps: SetupEventsDeps): () => void {
  let fleetConcurrency = 0;
  let fleetConcurrencyMax = 4;
  const emitConcurrency = (): void => {
    const budget = deps.getFleetBudget?.() ?? null;
    deps.broadcast({
      type: 'fleet.concurrency_update',
      payload: deps.sessionPayload({
        fleetConcurrency: budget?.activeAgents ?? fleetConcurrency,
        fleetConcurrencyMax: budget?.maxConcurrent ?? fleetConcurrencyMax,
        ...(budget
          ? {
              maxSpawns: budget.maxSpawns,
              usedSpawns: budget.usedSpawns,
              remainingSpawns: budget.remainingSpawns,
              maxSpawnsSource: budget.maxSpawnsSource,
              maxConcurrentSource: budget.maxConcurrentSource,
              effectiveSource: budget.effectiveSource,
              checkpointMaxSpawns: budget.checkpointMaxSpawns,
              ceilingMismatch: budget.ceilingMismatch,
            }
          : {}),
      }),
    });
  };

  return function setupEvents(): void {
    for (const unsubscribe of deps.eventUnsubscribers) unsubscribe();
    deps.eventUnsubscribers.length = 0;

    // Lightweight embedders and server tests may provide only the provider/model
    // portion of Context. Event projection has no need to require metadata.
    const maxIterations = deps.agent.ctx?.meta?.['maxIterations'];
    const disposeCanonical = setupCanonicalEvents({
      events: deps.events,
      broadcast: (_clients, message) => deps.broadcast(message),
      clients: deps.getClients() as never,
      config: {
        tools: {
          ...(typeof maxIterations === 'number' ? { maxIterations } : {}),
        },
      },
      context: deps.agent.ctx,
      ...(deps.sessionContext ? { sessionContext: deps.sessionContext } : {}),
      pendingConfirms: deps.pendingConfirms,
      globalConfigPath: deps.globalConfigPath,
      onFleetBroadcaster: deps.onFleetBroadcaster,
      projection: {
        scrubObject: (value) => deps.secretScrubber.scrubObject(value),
        queueTextDelta: deps.queueTextDelta,
        queueThinkingDelta: deps.queueThinkingDelta,
        queueToolProgress: (payload) => deps.queueToolProgress(payload as never),
        flushThinkingDelta: deps.flushThinkingDelta,
        flushAllStreamBuffers: deps.flushAllStreamBuffers,
      },
    });
    deps.eventUnsubscribers.push(disposeCanonical);

    deps.broadcast({
      type: 'subagent.event',
      payload: deps.sessionPayload({
        kind: 'leader_updated',
        subagentId: 'leader',
        isLeader: true,
        name: 'Leader',
        status: 'running',
      }),
    });
    emitConcurrency();

    deps.eventUnsubscribers.push(
      deps.events.on('concurrency.changed', (event) => {
        fleetConcurrencyMax = Math.max(1, event.n);
        emitConcurrency();
      }),
      deps.events.on('subagent.spawned', () => {
        fleetConcurrency += 1;
        emitConcurrency();
      }),
      deps.events.on('subagent.task_completed', () => {
        fleetConcurrency = Math.max(0, fleetConcurrency - 1);
        emitConcurrency();
      }),
    );

    if (deps.subscribeEternalIteration) {
      const subscription = createEternalSubscription(
        deps.subscribeEternalIteration,
        (_clients, message) => deps.broadcast(message),
        deps.getClients,
      );
      deps.eventUnsubscribers.push(() => subscription.dispose());
    }
  };
}
