import * as path from 'node:path';
import {
  type Config,
  type EventBus,
  type GlobalMailbox,
  type SessionWriter,
  startCostTelemetryBridge,
  startSessionTelemetryBridge,
  startFleetTelemetryBridge,
  startBrainTelemetryBridge,
  startWorktreeTelemetryBridge,
  startToolTelemetryBridge,
} from '@wrongstack/core';
import type { AgentMonitorService } from '@wrongstack/core/coordination';
import { startCliHqConnection } from '../hq-publisher.js';
import { createHqCommandDispatcher, type HqCommandController } from '../hq-command-controller.js';

/**
 * Mutable holder for the HQ publisher reference. The ref is created in
 * cli-main.ts before `brainMailbox` (which captures it via closure) and
 * populated by `setupHqTelemetry` once the HQ connection establishes.
 */
export interface HqPublisherRef {
  // biome-ignore lint/suspicious/noExplicitAny: publisher shape from hq-publisher.ts
  current: any | undefined;
}

export interface SetupHqTelemetryDeps {
  events: EventBus;
  session: SessionWriter;
  config: Config;
  flags: Record<string, string | boolean>;
  tuiOwnsScreen: boolean;
  projectRoot: string;
  globalRoot: string;
  // biome-ignore lint/suspicious/noExplicitAny: tracker type from AgentStatusTracker
  tracker: any | undefined;
  agentMonitor: AgentMonitorService | undefined;
  brainMailbox: GlobalMailbox;
  teardownHandlers: (() => void)[];
  mailboxSessionTag: (sessionId: string) => string;
  hqPublisherRef: HqPublisherRef;
}

export interface HqTelemetryResult {
  hqCommandController: HqCommandController;
  hqOnCommand: ReturnType<typeof createHqCommandDispatcher>;
}

/**
 * Wire the HQ command dispatch controller and the HQ WebSocket connection
 * with its auxiliary telemetry bridges (session, fleet, brain, worktree,
 * tool, cost). Also forwards agent-monitor events to HQ.
 *
 * The `hqPublisherRef` is populated once the connection establishes so
 * the `brainMailbox` (which captured the ref earlier) can publish to HQ.
 *
 * Teardown handlers are pushed into `deps.teardownHandlers` internally.
 */
export function setupHqTelemetry(deps: SetupHqTelemetryDeps): HqTelemetryResult {
  const {
    events,
    session,
    config,
    flags,
    tuiOwnsScreen,
    projectRoot,
    globalRoot,
    tracker,
    agentMonitor,
    brainMailbox,
    teardownHandlers,
    mailboxSessionTag,
    hqPublisherRef,
  } = deps;

  // Mutable state owned entirely within this function — no references
  // escape to the caller's scope except through the hqPublisherRef.
  let stopHqSessionBridge: (() => void) | undefined;
  const stopHqAuxBridges: Array<() => void> = [];

  // ── Phase 4 control plane — HQ command dispatch holder ──────────────────
  const hqCommandController: HqCommandController = {
    steerMailbox: brainMailbox as never,
    interruptLeader: () => false,
    sessionTag: () => mailboxSessionTag(session.id),
    allowRunCommand: () => flags['hq-allow-exec'] === true,
  };
  const hqOnCommand = createHqCommandDispatcher(hqCommandController);

  const hqConnection = startCliHqConnection({
    clientKind: tuiOwnsScreen ? 'tui' : 'cli',
    projectRoot,
    projectName: path.basename(projectRoot),
    appConfig: config,
    onCommand: hqOnCommand,
    capabilities: [
      'telemetry.publish',
      'mailbox.summary',
      'fleet.summary',
      'session.summary',
      'control.receive',
    ],
    onConnect: (publisher) => {
      hqPublisherRef.current = publisher;
      stopHqSessionBridge?.();
      stopHqSessionBridge = undefined;
      // Drain any auxiliary bridges from a previous connection before
      // re-establishing, so a reconnect never double-subscribes.
      for (const stop of stopHqAuxBridges) {
        try {
          stop();
        } catch {
          /* best-effort */
        }
      }
      stopHqAuxBridges.length = 0;
      try {
        stopHqSessionBridge = startSessionTelemetryBridge({
          publisher,
          events,
          sessionId: session.id,
          projectRoot,
          projectName: path.basename(projectRoot),
          globalRoot,
          // biome-ignore lint/suspicious/noExplicitAny: initialAgents shape
          initialAgents: (tracker as any)?.getAgents?.() as any,
          startedAt: new Date().toISOString(),
        });
      } catch {
        // HQ session telemetry is optional.
      }
      // ── Auxiliary telemetry bridges ──
      try {
        stopHqAuxBridges.push(
          startFleetTelemetryBridge({
            events,
            publisher,
            runId: session.id,
            sessionId: session.id,
          }),
        );
      } catch {
        /* optional */
      }
      try {
        stopHqAuxBridges.push(
          startBrainTelemetryBridge({ events, publisher, sessionId: session.id }),
        );
      } catch {
        /* optional */
      }
      try {
        stopHqAuxBridges.push(
          startWorktreeTelemetryBridge({ events, publisher, sessionId: session.id }),
        );
      } catch {
        /* optional */
      }
      try {
        stopHqAuxBridges.push(
          startToolTelemetryBridge({
            events,
            publisher,
            projectRoot,
            sessionId: session.id,
          }),
        );
      } catch {
        /* optional */
      }
      try {
        stopHqAuxBridges.push(
          startCostTelemetryBridge({ events, publisher, sessionId: session.id }),
        );
      } catch {
        /* optional */
      }
    },
  });

  // Populate the publisher ref from the connection so the brainMailbox
  // closure (which captured hqPublisherRef) can publish immediately.
  hqPublisherRef.current = hqConnection.getPublisher();

  teardownHandlers.push(() => stopHqSessionBridge?.());
  teardownHandlers.push(() => {
    for (const stop of stopHqAuxBridges) {
      try {
        stop();
      } catch {
        /* best-effort */
      }
    }
  });
  teardownHandlers.push(() => hqConnection.stop());

  // ── Agent Monitor → HQ Bridge ───────────────────────────────────
  if (agentMonitor) {
    const offMsg = events.on('agent.timeline.message', (payload) => {
      try {
        (hqPublisherRef.current as any)?.publishEvent?.({
          type: 'agent.message',
          payload,
          timestamp: (payload as any).ts,
        });
      } catch {
        /* best-effort */
      }
    });
    const offStatus = events.on('agent.status_changed', (payload) => {
      try {
        (hqPublisherRef.current as any)?.publishEvent?.({
          type: 'agent.status',
          payload,
          timestamp: (payload as any).ts,
        });
      } catch {
        /* best-effort */
      }
    });
    teardownHandlers.push(() => {
      offMsg();
      offStatus();
    });
  }

  return { hqCommandController, hqOnCommand };
}
