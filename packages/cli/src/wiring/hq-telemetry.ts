import * as path from 'node:path';
import type { AgentMonitorService, RemoteMailbox } from '@wrongstack/core/coordination';
import type { HqPublisher } from '@wrongstack/core/hq';
import {
  type ApprovalRegistry,
  createApprovalRegistry,
  startApprovalTelemetryBridge,
  startBrainTelemetryBridge,
  startCostTelemetryBridge,
  startFleetTelemetryBridge,
  startSessionTelemetryBridge,
  startToolTelemetryBridge,
  startWorktreeTelemetryBridge,
} from '@wrongstack/core/hq';
import type { EventBus } from '@wrongstack/core/kernel';
import type { Config, SessionWriter } from '@wrongstack/core/types';
import type { MCPRegistry, MCPServerOperationalHealth } from '@wrongstack/mcp';
import { startGovernanceHqTelemetry } from '../governance-hq-telemetry.js';
import {
  createHqCommandDispatcher,
  createProjectKanbanAssignHandler,
  createProjectKanbanTransitionHandler,
  type HqCommandController,
} from '../hq-command-controller.js';
import { setHqLiveStatusProbe } from '../hq-live-status.js';
import { startCliHqConnection } from '../hq-publisher.js';
import type { KanbanHqSyncStats } from '../kanban-hq-sync.js';
import type { ApprovalMirrorRef } from '../permission-prompt-mirror.js';

/**
 * The registry reports epoch-ms timestamps; the HQ wire contract carries ISO
 * strings, and HQ rejects a snapshot whose `lastSuccessAt`/`lastFailureAt` is
 * a number. projectId/clientId are stamped by HQ from the connection.
 */
function toHqMcpServers(servers: readonly MCPServerOperationalHealth[]) {
  return servers.map((server) => ({
    ...server,
    lastSuccessAt:
      server.lastSuccessAt === undefined ? undefined : new Date(server.lastSuccessAt).toISOString(),
    lastFailureAt:
      server.lastFailureAt === undefined ? undefined : new Date(server.lastFailureAt).toISOString(),
  }));
}

/**
 * Mutable holder for the HQ publisher reference. The ref is created in
 * cli-main.ts before `brainMailbox` (which captures it via closure) and
 * populated by `setupHqTelemetry` once the HQ connection establishes.
 */
export interface HqPublisherRef {
  current: HqPublisher | undefined;
  getKanbanSyncStats?: (() => KanbanHqSyncStats | undefined) | undefined;
}

interface SetupHqTelemetryDeps {
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
  brainMailbox: RemoteMailbox;
  teardownHandlers: (() => void)[];
  mailboxSessionTag: (sessionId: string) => string;
  hqPublisherRef: HqPublisherRef;
  /**
   * Late-bound handle the plain REPL's prompt delegate reads through. Populated
   * here because this is where the registry is created; until then the REPL
   * prompt simply runs unmirrored.
   */
  approvalMirror?: ApprovalMirrorRef | undefined;
  mcpRegistry: Pick<MCPRegistry, 'onOperation' | 'operationalHealth'>;
  /**
   * The LIVE conversation writer. An in-process `/resume` and an in-place
   * project switch replace `ctx.session`; `session` above is only the boot
   * writer. Defaults to it for hosts that never swap.
   */
  liveSession?: (() => SessionWriter) | undefined;
  /** The LIVE project root (an in-place project switch re-roots the process). */
  liveProjectRoot?: (() => string) | undefined;
  /** How often the live session/project is compared to what HQ is bound to. */
  scopeCheckIntervalMs?: number | undefined;
  /** The LIVE app config, so `/hq` changes re-point the running connection. */
  getConfig?: (() => Config) | undefined;
}

const DEFAULT_SCOPE_CHECK_INTERVAL_MS = 1_000;
/** Below HQ's MCP snapshot staleness window (5 min), so an idle terminal stays listed. */
const MCP_HEALTH_KEEPALIVE_MS = 2 * 60_000;

interface HqTelemetryResult {
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
    mcpRegistry,
  } = deps;
  const liveSession = deps.liveSession ?? (() => session);
  const liveProjectRoot = deps.liveProjectRoot ?? (() => projectRoot);

  // Mutable state owned entirely within this function — no references
  // escape to the caller's scope except through the hqPublisherRef.
  let stopHqSessionBridge: (() => void) | undefined;
  const stopHqAuxBridges: Array<() => void> = [];

  // The approval registry outlives any single HQ connection on purpose: it
  // holds the resolver closures for prompts currently on screen, and dropping
  // them on a reconnect would strand the run waiting on an answer nobody can
  // give. The BRIDGE is what restarts with each connection; it republishes
  // whatever the registry still holds.
  const approvalRegistry: ApprovalRegistry = createApprovalRegistry(events);
  teardownHandlers.push(() => approvalRegistry.dispose());
  if (deps.approvalMirror) {
    deps.approvalMirror.current = approvalRegistry;
    // The LIVE session, read per prompt: an in-process `/resume` or
    // `session.new` swaps the writer, and a captured id would address an
    // HQ answer to a conversation that is no longer on screen.
    deps.approvalMirror.sessionId = () => liveSession().id;
    teardownHandlers.push(() => {
      if (deps.approvalMirror?.current === approvalRegistry) {
        deps.approvalMirror.current = undefined;
        deps.approvalMirror.sessionId = undefined;
      }
    });
  }

  // ── Phase 4 control plane — HQ command dispatch holder ──────────────────
  const hqCommandController: HqCommandController = {
    steerMailbox: brainMailbox as never,
    interruptLeader: () => false,
    sessionTag: () => mailboxSessionTag(liveSession().id),
    // `setupCommandHostState` rebinds both to the LIVE writer ref too, because
    // an in-process resume / session.new swaps `ctx.session` for a new writer
    // object and a captured one goes stale.
    sessionId: () => liveSession().id,
    allowRunCommand: () => flags['hq-allow-exec'] === true,
    resolveApproval: (toolUseId, decision, commandSessionId) =>
      approvalRegistry.resolve(toolUseId, decision, commandSessionId),
    resolveUserInput: (requestId, response, commandSessionId) =>
      approvalRegistry.resolveUserInput?.(requestId, response, commandSessionId) ?? false,
    // Resolved per command: an in-place project switch must not leave HQ's
    // Kanban moves writing into the project this terminal just left.
    kanbanTransition: (request) => createProjectKanbanTransitionHandler(liveProjectRoot())(request),
    kanbanAssign: (request) => createProjectKanbanAssignHandler(liveProjectRoot())(request),
  };
  const hqOnCommand = createHqCommandDispatcher(hqCommandController);

  const stopSessionScope = (): void => {
    stopHqSessionBridge?.();
    stopHqSessionBridge = undefined;
    // Drain every auxiliary bridge of the previous binding before
    // re-establishing, so a reconnect or a re-scope never double-subscribes.
    for (const stop of stopHqAuxBridges) {
      try {
        stop();
      } catch {
        /* best-effort */
      }
    }
    stopHqAuxBridges.length = 0;
  };

  // The session the bridges are currently bound to. Every bridge below stamps
  // a session id and several scope by project, so both are read from the LIVE
  // accessors at bind time and re-checked by the scope watcher further down.
  let boundSessionId: string | undefined;

  const bindSessionScope = (publisher: HqPublisher): void => {
    stopSessionScope();
    const writer = liveSession();
    const sessionId = writer.id;
    const root = liveProjectRoot();
    boundSessionId = sessionId;
    try {
      stopHqSessionBridge = startSessionTelemetryBridge({
        publisher,
        events,
        sessionId,
        projectRoot: root,
        projectName: path.basename(root),
        globalRoot,
        writer,
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
        startFleetTelemetryBridge({ events, publisher, runId: sessionId, sessionId }),
      );
    } catch {
      /* optional */
    }
    try {
      stopHqAuxBridges.push(startGovernanceHqTelemetry({ publisher, projectRoot: root }));
    } catch {
      /* optional advisory telemetry */
    }
    try {
      const publishMcpHealth = (): void => {
        publisher.publishEvent({
          type: 'mcp.health.snapshot',
          payload: { servers: toHqMcpServers(mcpRegistry.operationalHealth()) },
          sessionId,
        });
      };
      publishMcpHealth();
      // HQ keeps the MCP snapshot per SOCKET and ages it out, so one publish
      // per binding left the MCP panel empty after any reconnect (fresh
      // server-side client state) and after the staleness window on an idle
      // terminal. Re-seed on every socket open, and keep it warm.
      stopHqAuxBridges.push(publisher.onConnected(publishMcpHealth));
      const mcpKeepAlive = setInterval(publishMcpHealth, MCP_HEALTH_KEEPALIVE_MS);
      mcpKeepAlive.unref?.();
      stopHqAuxBridges.push(() => clearInterval(mcpKeepAlive));
      stopHqAuxBridges.push(
        mcpRegistry.onOperation((operation) => {
          publisher.publishEvent({
            type: 'mcp.operation',
            payload: {
              operation,
              servers: toHqMcpServers(mcpRegistry.operationalHealth()),
            },
            sessionId,
          });
        }),
      );
    } catch {
      /* optional */
    }
    try {
      stopHqAuxBridges.push(startBrainTelemetryBridge({ events, publisher, sessionId }));
    } catch {
      /* optional */
    }
    try {
      stopHqAuxBridges.push(startWorktreeTelemetryBridge({ events, publisher, sessionId }));
    } catch {
      /* optional */
    }
    try {
      stopHqAuxBridges.push(
        startToolTelemetryBridge({ events, publisher, projectRoot: root, sessionId }),
      );
    } catch {
      /* optional */
    }
    try {
      stopHqAuxBridges.push(startCostTelemetryBridge({ events, publisher, sessionId }));
    } catch {
      /* optional */
    }
    try {
      stopHqAuxBridges.push(
        startApprovalTelemetryBridge({
          registry: approvalRegistry,
          publisher,
          projectRoot: root,
          sessionId,
        }),
      );
    } catch {
      /* optional */
    }
  };

  const connect = (root: string) =>
    startCliHqConnection({
      clientKind: tuiOwnsScreen ? 'tui' : 'cli',
      projectRoot: root,
      projectName: path.basename(root),
      appConfig: config,
      ...(deps.getConfig !== undefined ? { getAppConfig: deps.getConfig } : {}),
      onCommand: hqOnCommand,
      capabilities: [
        'telemetry.publish',
        'mailbox.summary',
        'fleet.summary',
        'session.summary',
        'control.receive',
        'control.approve',
        'kanban.dispatch',
      ],
      onConnect: (publisher) => {
        hqPublisherRef.current = publisher;
        bindSessionScope(publisher);
      },
      // `/hq off` (or clearing the endpoint) retired the publisher: stop the
      // bridges bound to it so nothing keeps queueing into a closed socket.
      onDisconnect: () => {
        stopSessionScope();
        boundSessionId = undefined;
        hqPublisherRef.current = undefined;
      },
    });

  let boundProjectRoot = projectRoot;
  let hqConnection = connect(boundProjectRoot);
  hqPublisherRef.getKanbanSyncStats = () => hqConnection.getKanbanSyncStats();

  // Populate the publisher ref from the connection so the brainMailbox
  // closure (which captured hqPublisherRef) can publish immediately.
  hqPublisherRef.current = hqConnection.getPublisher();

  // HQ follows the conversation, not the boot writer. `/resume` and an
  // in-place project switch swap `ctx.session`; before this the bridges kept
  // tailing the boot JSONL and re-announcing the boot session every 2.5 s, so
  // HQ showed a conversation that was no longer on screen, never saw the live
  // transcript, and `rejectUnknownSession` refused every command aimed at the
  // session HQ displayed.
  //
  // A project switch also changes the publisher's identity (`project` in
  // `client.hello`, the Kanban sync root), which only a new connection can
  // carry — the old one is stopped, so its session ends on HQ.
  const scopeWatcher = setInterval(() => {
    try {
      const root = liveProjectRoot();
      if (root !== boundProjectRoot) {
        boundProjectRoot = root;
        stopSessionScope();
        hqConnection.stop();
        hqConnection = connect(root);
        hqPublisherRef.current = hqConnection.getPublisher();
        return;
      }
      const publisher = hqPublisherRef.current;
      if (publisher !== undefined && liveSession().id !== boundSessionId) {
        bindSessionScope(publisher);
      }
    } catch {
      /* best-effort: a failed re-scope retries on the next tick */
    }
  }, deps.scopeCheckIntervalMs ?? DEFAULT_SCOPE_CHECK_INTERVAL_MS);
  scopeWatcher.unref?.();

  teardownHandlers.push(() => clearInterval(scopeWatcher));
  teardownHandlers.push(
    setHqLiveStatusProbe(() => {
      const publisher = hqPublisherRef.current;
      if (publisher === undefined) return undefined;
      return {
        clientId: publisher.identity.clientId,
        projectId: publisher.project.projectId,
        connected: publisher.connected,
        queuedFrames: publisher.getQueueStats().entries,
        sessionId: boundSessionId,
      };
    }),
  );
  teardownHandlers.push(() => stopSessionScope());
  teardownHandlers.push(() => {
    hqPublisherRef.getKanbanSyncStats = undefined;
    hqConnection.stop();
  });

  // ── Agent Monitor → HQ Bridge ───────────────────────────────────
  if (agentMonitor) {
    const offMsg = events.on('agent.timeline.message', (payload) => {
      try {
        hqPublisherRef.current?.publishEvent({
          type: 'agent.message',
          payload,
          timestamp: payload.ts,
        });
      } catch {
        /* best-effort */
      }
    });
    const offStatus = events.on('agent.status_changed', (payload) => {
      try {
        hqPublisherRef.current?.publishEvent({
          type: 'agent.status',
          payload,
          timestamp: payload.ts,
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
