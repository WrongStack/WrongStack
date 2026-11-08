import type { EventBus } from '@wrongstack/contracts/kernel';
import type { SecretScrubber } from '@wrongstack/contracts/types';
import { mailboxSessionTag } from '@wrongstack/coordination';
import type { Context } from '@wrongstack/core/agent';
import type { JournalEntry } from '@wrongstack/goal';
import {
  createEternalSubscription,
  installFleetConcurrencyFrames,
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
  /**
   * `targetSessionId` names the tab a frame belongs to when the payload's own
   * `sessionId` is somebody else's (a subagent's). Optional so single-session
   * embedders can keep passing a one-argument broadcaster.
   */
  broadcast: (msg: { type: string; payload: unknown }, targetSessionId?: string) => void;
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
  return function setupEvents(): void {
    for (const unsubscribe of deps.eventUnsubscribers) unsubscribe();
    deps.eventUnsubscribers.length = 0;

    // Lightweight embedders and server tests may provide only the provider/model
    // portion of Context. Event projection has no need to require metadata.
    const maxIterations = deps.agent.ctx?.meta?.['maxIterations'];
    const disposeCanonical = setupCanonicalEvents({
      events: deps.events,
      // The third argument is not decoration: it names the tab that OWNS a
      // subagent, and the frames that pass it carry the subagent's own
      // session on the payload. Dropping it here routed every subagent
      // codemap frame at a session no tab subscribes to.
      broadcast: (_clients, message, targetSessionId) =>
        targetSessionId !== undefined
          ? deps.broadcast(message, targetSessionId)
          : deps.broadcast(message),
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

    // The boot conversation's leader. Every other conversation gets its own
    // when its tab declares itself (`session.subscribe`); the id must match
    // the one that path derives, or the boot tab would end up with two leader
    // rows. `leader@<sessionTag>` is the address the leader already answers to
    // everywhere else — a bare `leader` was one row shared by four tabs.
    deps.broadcast({
      type: 'subagent.event',
      payload: deps.sessionPayload({
        kind: 'leader_updated',
        subagentId: `leader@${mailboxSessionTag(deps.currentSessionId())}`,
        isLeader: true,
        name: 'Leader',
        status: 'running',
      }),
    });
    // The fleet gauge, shared with the standalone engine: sent now and on every change.
    const concurrency = installFleetConcurrencyFrames({
      events: deps.events,
      broadcast: (message) => deps.broadcast(message),
      getBudget: deps.getFleetBudget,
    });
    deps.eventUnsubscribers.push(() => concurrency.dispose());

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
