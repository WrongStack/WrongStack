import type { Context } from '@wrongstack/core/agent';
import type { EventBus, EventName, Listener } from '@wrongstack/core/kernel';
import type { SessionEventBridge } from '@wrongstack/core/storage';
import type { WstackPaths } from '@wrongstack/core/utils';
import type { WebSocket } from 'ws';
import type { PendingConfirm } from './pending-confirms.js';
import { startProjectWatcher } from './project-watcher.js';
import type { SetupEventProjection } from './setup-event-projection.js';
import {
  registerSetupEventsClientStatusWriter,
  registerSetupEventsCoreWatchers,
} from './setup-events-core-watchers.js';
import { registerSetupEventsFleetBroadcaster } from './setup-events-fleet-broadcaster.js';
import { registerSetupEventsPatternHandlers } from './setup-events-pattern-handlers.js';
import { registerSetupEventsProviderHandlers } from './setup-events-provider-handlers.js';
import { createSetupEventSessionHelpers } from './setup-events-session-helpers.js';
import { registerSetupEventsStatusWatcher } from './setup-events-status-watcher.js';
import { registerSetupEventsSubagentHandlers } from './setup-events-subagent-handlers.js';
import { registerSetupEventsToolHandlers } from './setup-events-tool-handlers.js';
import type { FileWatcherMetrics } from './setup-events-watcher.js';
import type { ConnectedClient, WSServerMessage } from './types.js';

export type { FileWatcherMetrics } from './setup-events-watcher.js';

export interface SetupEventsDeps {
  events: EventBus;
  broadcast: (
    clients: Map<WebSocket, ConnectedClient>,
    msg: WSServerMessage,
    /** Deliver to the tab that owns this session, overriding the id on the
     *  payload. Needed when the payload names a SUBAGENT's session, which no
     *  tab subscribes to. */
    targetSessionId?: string,
  ) => void;
  clients: Map<WebSocket, ConnectedClient>;
  config: { tools?: { maxIterations?: number | undefined } };
  context: Context;
  pendingConfirms: Map<string, PendingConfirm>;
  /** Optional global config dir (~/.wrongstack) — enables SessionRegistry poll for fleet view. */
  globalConfigPath?: string | undefined;
  /**
   * Audit-level-aware session log bridge. When provided, tool/error/provider
   * events are persisted to the session JSONL (same contract as the CLI) —
   * without it, standalone-WebUI sessions carry no audit events and resume
   * with no tool history.
   */
  sessionBridge?: SessionEventBridge | undefined;
  /**
   * Resolve an audit bridge for a NAMED session. Hosts that serve several
   * sessions at once (the WebUI, four tabs on one runtime) pass this so a
   * background tab's tool and error history lands in its own journal instead
   * of being dropped for not being the session in front.
   */
  bridgeForSession?: ((sessionId: string) => SessionEventBridge | undefined) | undefined;
  /**
   * The Context of a NAMED session, without creating one.
   *
   * Event payloads describe the session that produced them, and some of what
   * they carry is a per-tab setting — the iteration ceiling above all. Reading
   * it off the shared root context told a background tab it was on "3 / 500"
   * when its own cap was something else entirely.
   */
  sessionContext?: ((sessionId: string) => Context | undefined) | undefined;
  /** Optional wpaths for writing status.json file. */
  wpaths?: WstackPaths | undefined;
  /** Optional live file-watcher metrics sink. */
  watcherMetrics?: FileWatcherMetrics | undefined;
  /**
   * Receives the internal `broadcastSessions` fn so the HTTP layer can trigger
   * an immediate fleet re-broadcast on `POST /api/fleet/ping` (push-on-write
   * from a TUI/REPL), instead of waiting on the registry file-watch/poll.
   */
  onFleetBroadcaster?: ((fn: () => Promise<void>) => void) | undefined;
  /** Optional high-volume/sensitive event adapter used by embedded hosts. */
  projection?: SetupEventProjection | undefined;
}

export { statusProjectHashFromWatchFilename } from './setup-events-watcher.js';

/**
 * Wire kernel events to WS broadcasts and (when wpaths/globalConfigPath are
 * given) start the status-file watcher and session-poll interval.
 *
 * Returns a disposer that stops the watcher, clears the metrics/poll
 * intervals, and flushes pending debounce timers. Callers MUST invoke it on
 * shutdown — the watcher is `persistent: true` and the metrics interval is not
 * `unref`'d, so without disposal they keep the process alive and leak across
 * server restarts.
 */
export function setupEvents(deps: SetupEventsDeps): () => void {
  const {
    events,
    broadcast,
    clients,
    config,
    context,
    pendingConfirms,
    globalConfigPath,
    sessionBridge,
    wpaths,
    watcherMetrics,
    onFleetBroadcaster,
    projection,
  } = deps;
  const disposers: Array<() => void> = [];
  let disposed = false;
  const on = <E extends EventName>(event: E, listener: Listener<E>): void => {
    disposers.push(events.on(event, listener));
  };
  disposers.push(
    ...registerSetupEventsCoreWatchers({ events, broadcast, clients, context, wpaths }),
  );

  // ── Project source-tree watcher ────────────────────────────────
  if (context.projectRoot) {
    disposers.push(
      startProjectWatcher({
        projectRoot: context.projectRoot,
        broadcast,
        clients,
      }),
    );
  }

  const { sessionPayload, appendForCurrentSession } = createSetupEventSessionHelpers(
    context,
    sessionBridge,
    { bridgeForSession: deps.bridgeForSession },
  );

  on('iteration.started', (e) => {
    // The ceiling belongs to the session that started the iteration, not to
    // whichever session the runtime is currently pointing at.
    const iterMeta =
      (e.sessionId ? deps.sessionContext?.(e.sessionId)?.meta : undefined) ?? context.meta;
    const maxIt =
      typeof iterMeta['maxIterations'] === 'number'
        ? iterMeta['maxIterations']
        : (config.tools?.maxIterations ?? 100);
    broadcast(clients, {
      type: 'iteration.started',
      payload: sessionPayload({ sessionId: e.sessionId, index: e.index, maxIterations: maxIt }),
    });
  });

  on('iteration.completed', (e) => {
    broadcast(clients, {
      type: 'iteration.completed',
      payload: sessionPayload({
        sessionId: e.sessionId,
        index: e.index,
        totalIterations: e.index + 1,
      }),
    });
  });

  on('iteration.limit_reached', (e) => {
    broadcast(clients, {
      type: 'iteration.limit_reached',
      payload: sessionPayload({
        sessionId: e.sessionId,
        currentIterations: e.currentIterations,
        currentLimit: e.currentLimit,
      }),
    });
  });

  on('provider.text_delta', (e) => {
    if (projection?.queueTextDelta) {
      projection.flushThinkingDelta?.();
      projection.queueTextDelta(e.text, e.sessionId);
      return;
    }
    broadcast(clients, {
      type: 'provider.text_delta',
      payload: sessionPayload({ sessionId: e.sessionId, text: e.text, messageId: 'current' }),
    });
  });

  on('provider.thinking_delta', (e) => {
    if (projection?.queueThinkingDelta) {
      projection.queueThinkingDelta(e.text, e.sessionId);
      return;
    }
    broadcast(clients, {
      type: 'provider.thinking_delta',
      payload: sessionPayload({ sessionId: e.sessionId, text: e.text }),
    });
  });

  on('provider.stream_error', (e) => {
    broadcast(clients, {
      type: 'provider.stream_error',
      payload: sessionPayload({ sessionId: e.sessionId, eventType: e.eventType, message: e.msg }),
    });
  });

  registerSetupEventsToolHandlers({
    on,
    broadcast,
    clients,
    context,
    pendingConfirms,
    projection,
    sessionPayload,
    appendForCurrentSession,
  });

  registerSetupEventsProviderHandlers({
    on,
    broadcast,
    clients,
    projection,
    sessionPayload,
  });

  on('error', (e) => {
    broadcast(clients, {
      type: 'error',
      payload: sessionPayload({
        sessionId: e.sessionId,
        phase: e.phase,
        message: e.err instanceof Error ? e.err.message : String(e.err),
      }),
    });
    appendForCurrentSession(e.sessionId, {
      type: 'error',
      ts: new Date().toISOString(),
      message: e.err instanceof Error ? e.err.message : String(e.err),
      phase: e.phase,
    });
  });

  on('session.damaged', (e) => {
    broadcast(clients, {
      type: 'session.damaged',
      payload: { sessionId: e.sessionId, detail: e.detail },
    });
  });

  on('session.rewound', (e) => {
    broadcast(clients, {
      type: 'session.rewound',
      payload: sessionPayload({
        sessionId: e.sessionId,
        toPromptIndex: e.toPromptIndex,
        revertedFiles: e.revertedFiles,
        removedEvents: e.removedEvents,
      }),
    });
  });

  on('checkpoint.written', (e) => {
    broadcast(clients, {
      type: 'checkpoint.written',
      payload: sessionPayload({
        sessionId: e.sessionId,
        promptIndex: e.promptIndex,
        promptPreview: e.promptPreview,
        ts: e.ts,
        fileCount: e.fileCount,
      }),
    });
  });

  on('in_flight.started', (e) => {
    broadcast(clients, {
      type: 'in_flight.started',
      payload: sessionPayload({ sessionId: e.sessionId, context: e.context, ts: e.ts }),
    });
  });

  on('in_flight.ended', (e) => {
    broadcast(clients, {
      type: 'in_flight.ended',
      payload: sessionPayload({ sessionId: e.sessionId, reason: e.reason, ts: e.ts }),
    });
  });

  // Provider visibility — retry storms and provider failures in the JSONL
  // for forensics, mirroring the CLI's bridge wiring.
  on('provider.retry', (e) => {
    broadcast(clients, {
      type: 'provider.retry',
      payload: sessionPayload({
        sessionId: e.sessionId,
        providerId: e.providerId,
        attempt: e.attempt,
        delayMs: e.delayMs,
        status: e.status,
        description: e.description,
        ...(e.errorBody ? { errorBody: e.errorBody } : {}),
      }),
    });
    appendForCurrentSession(e.sessionId, {
      type: 'provider_retry',
      ts: new Date().toISOString(),
      providerId: e.providerId,
      attempt: e.attempt,
      delayMs: e.delayMs,
      status: e.status,
      description: e.description,
      ...(e.errorBody ? { errorBody: e.errorBody } : {}),
    });
  });

  on('provider.status_changed', (e) => {
    broadcast(clients, {
      type: 'provider.status_changed',
      payload: sessionPayload({
        providerId: e.providerId,
        model: e.model,
        oldState: e.oldState,
        newState: e.newState,
        reason: e.reason,
        timestamp: e.timestamp,
        stateExpiresAt: e.stateExpiresAt,
      }),
    });
  });

  on('provider.active_blocked', (e) => {
    broadcast(clients, {
      type: 'provider.active_blocked',
      payload: sessionPayload({
        sessionId: e.sessionId,
        providerId: e.providerId,
        model: e.model,
        state: e.state,
        fallbackProviderId: e.fallbackProviderId,
        fallbackModel: e.fallbackModel,
        lastError: e.lastError,
        timestamp: e.timestamp,
      }),
    });
  });

  on('provider.error', (e) => {
    broadcast(clients, {
      type: 'provider.error',
      payload: sessionPayload({
        sessionId: e.sessionId,
        providerId: e.providerId,
        status: e.status,
        description: e.description,
        retryable: e.retryable,
        ...(e.errorBody ? { errorBody: e.errorBody } : {}),
      }),
    });
    appendForCurrentSession(e.sessionId, {
      type: 'provider_error',
      ts: new Date().toISOString(),
      providerId: e.providerId,
      status: e.status,
      description: e.description,
      retryable: e.retryable,
      ...(e.errorBody ? { errorBody: e.errorBody } : {}),
    });
  });

  on('provider.fallback', (e) => {
    broadcast(clients, {
      type: 'provider.fallback',
      payload: sessionPayload({
        sessionId: e.sessionId,
        from: e.from,
        to: e.to,
        status: e.status,
        providerSwitched: e.providerSwitched,
        ...(e.requestId ? { requestId: e.requestId } : {}),
      }),
    });
  });

  on('provider.model_switched', (e) => {
    broadcast(clients, {
      type: 'provider.model_switched',
      payload: sessionPayload({
        sessionId: e.sessionId,
        from: e.from,
        to: e.to,
        timestamp: e.timestamp,
      }),
    });
  });

  on('provider.fallback_pending', (e) => {
    broadcast(clients, {
      type: 'provider.fallback_pending',
      payload: sessionPayload({
        sessionId: e.sessionId,
        from: e.from,
        status: e.status,
        candidates: e.candidates,
        autoSwitchSeconds: e.autoSwitchSeconds,
        requestId: e.requestId,
        timestamp: e.timestamp,
      }),
    });
  });

  on('compaction.fired', (e) => {
    broadcast(clients, {
      type: 'context.compacted',
      payload: sessionPayload({
        sessionId: e.sessionId,
        before: e.report.before,
        after: e.report.after,
        saved: Math.max(0, e.report.before - e.report.after),
        reductions: e.report.reductions,
      }),
    });
  });

  on('compaction.failed', (e) => {
    broadcast(clients, {
      type: 'compaction.failed',
      payload: sessionPayload({
        sessionId: e.sessionId,
        message: e.err.message,
        aggressive: e.aggressive,
        level: e.level,
        tokens: e.tokens,
        maxContext: e.maxContext,
        load: e.load,
        fatal: e.fatal,
      }),
    });
  });

  on('mcp.server.connected', (e) => {
    broadcast(clients, {
      type: 'mcp.server.connected',
      payload: { name: e.name, toolCount: e.toolCount },
    });
  });

  on('mcp.server.reconnected', (e) => {
    broadcast(clients, {
      type: 'mcp.server.reconnected',
      payload: { name: e.name, toolCount: e.toolCount },
    });
  });

  on('mcp.server.disconnected', (e) => {
    broadcast(clients, {
      type: 'mcp.server.disconnected',
      payload: { name: e.name, reason: e.reason },
    });
  });

  on('coordinator.stats', (e) => {
    broadcast(clients, {
      type: 'coordinator.stats',
      payload: sessionPayload({
        sessionId: e.sessionId,
        total: e.total,
        running: e.running,
        idle: e.idle,
        stopped: e.stopped,
        inFlight: e.inFlight,
        pending: e.pending,
        completed: e.completed,
        subagentStatuses: e.subagentStatuses.map((s) => ({
          id: s.subagentId,
          name: s.subagentId,
          status: s.status,
          currentTask: s.taskId,
        })),
      }),
    });
  });

  disposers.push(
    ...registerSetupEventsPatternHandlers({
      events,
      broadcast,
      clients,
      sessionPayload,
    }),
  );

  registerSetupEventsSubagentHandlers({
    on,
    broadcast,
    clients,
    context,
    projection,
    sessionPayload,
  });

  disposers.push(
    registerSetupEventsClientStatusWriter({ events, broadcast, clients, context, wpaths }),
  );

  const statusWatcherDispose = registerSetupEventsStatusWatcher({
    wpaths,
    watcherMetrics,
    clients,
    broadcast,
    on,
    isDisposed: () => disposed,
  });
  if (statusWatcherDispose) disposers.push(statusWatcherDispose);

  const fleetBroadcasterDispose = registerSetupEventsFleetBroadcaster({
    globalConfigPath,
    wpaths,
    context,
    clients,
    broadcast,
    onFleetBroadcaster,
    isDisposed: () => disposed,
  });
  if (fleetBroadcasterDispose) disposers.push(fleetBroadcasterDispose);

  return () => {
    if (disposed) return;
    disposed = true;
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        /* best-effort teardown */
      }
    }
  };
}
