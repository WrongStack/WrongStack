import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import type { EventBus } from '@wrongstack/contracts/kernel';
import type { Config } from '@wrongstack/contracts/types';
import { RemoteMailbox, resolveProjectDir } from '@wrongstack/core/coordination';
import {
  createHqPublisherFromEnv,
  startBrainTelemetryBridge,
  startCostTelemetryBridge,
  startFleetTelemetryBridge,
  startSessionTelemetryBridge,
  startToolTelemetryBridge,
  startWorktreeTelemetryBridge,
} from '@wrongstack/hq';
import { wstackGlobalRoot } from '@wrongstack/core/utils';
import type { TuiMailboxSnapshot } from './mailbox-view-model-types.js';

interface RunTuiClientRegistrationOptions {
  projectRoot?: string | undefined;
  events: EventBus;
  appConfig?: Config | undefined;
  hqTelemetryOwnedExternally?: boolean | undefined;
  getSessionId?: (() => string | undefined) | undefined;
  /** Current project mailbox identity used for actor-specific receipts/unread. */
  getAgentId?: (() => string | undefined) | undefined;
  isCleaned: () => boolean;
}

interface RunTuiClientRegistration {
  register(): Promise<string | null>;
  unregister(): void;
}

const CLIENT_HEARTBEAT_MS = 15_000;
/** Sync client counts from the shared registry every 30s so closed clients disappear promptly. */
const CLIENT_SYNC_MS = 30_000;
/**
 * Trailing-edge coalesce for mailbox-event → snapshot publishes. Every
 * `publishSnapshot` costs FIVE IPC round-trips and a 50-message payload;
 * publishing per mailbox event was the producer half of the measured
 * mailbox.snapshot storm (a burst of sends/receipts triggered one full
 * snapshot each). 300ms matches the process registry's coalesce window —
 * same "burst of events, one refresh" question.
 */
const SNAPSHOT_COALESCE_MS = 300;

export function createRunTuiClientRegistration(
  opts: RunTuiClientRegistrationOptions,
): RunTuiClientRegistration {
  let clientHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let clientSyncTimer: ReturnType<typeof setInterval> | null = null;
  let initialClientSyncTimer: ReturnType<typeof setTimeout> | null = null;
  let registeredMailbox: RemoteMailbox | null = null;
  let registeredClientId: string | null = null;
  let unsubscribeMailboxEvents: (() => void) | null = null;
  let snapshotCoalesceTimer: ReturnType<typeof setTimeout> | null = null;
  let tuiHqPublisher: ReturnType<typeof createHqPublisherFromEnv>;
  let registrationGeneration = 0;
  const stopHqAuxBridges: Array<() => void> = [];
  const bestEffort = (cleanup: (() => void) | null | undefined): void => {
    try {
      cleanup?.();
    } catch {
      // Cleanup must never turn optional presence registration into a startup failure.
    }
  };

  const register = async (): Promise<string | null> => {
    if (!opts.projectRoot) return null;
    const generation = ++registrationGeneration;
    let mailbox: RemoteMailbox | null = null;
    let clientId: string | null = null;
    let clientRegistered = false;
    let unsubscribe: (() => void) | null = null;
    let localSnapshotCoalesceTimer: ReturnType<typeof setTimeout> | null = null;
    let localHqPublisher: ReturnType<typeof createHqPublisherFromEnv>;
    try {
      const projectDir = resolveProjectDir(opts.projectRoot, wstackGlobalRoot());
      const attemptMailbox = new RemoteMailbox({ projectDir, events: opts.events });
      mailbox = attemptMailbox;
      const attemptClientId = `tui@${randomUUID().slice(0, 8)}`;
      clientId = attemptClientId;
      await attemptMailbox.initialize();

      const publishSnapshot = async (): Promise<void> => {
        if (opts.isCleaned() || generation !== registrationGeneration) return;
        try {
          const actorId = opts.getAgentId?.();
          const [messages, agents, clients, service, unread] = await Promise.all([
            attemptMailbox.query({ limit: 50 }),
            attemptMailbox.getAgentStatuses(),
            attemptMailbox.getClientStatuses(),
            attemptMailbox.status(),
            actorId === undefined ? Promise.resolve(0) : attemptMailbox.unreadCount(actorId),
          ]);
          if (opts.isCleaned() || generation !== registrationGeneration) return;
          const clientCounts = { tui: 0, webui: 0, repl: 0 };
          for (const client of clients) {
            if (client.online && client.source in clientCounts) {
              clientCounts[client.source as keyof typeof clientCounts]++;
            }
          }
          const snapshot: TuiMailboxSnapshot = {
            actorId,
            messages,
            agents,
            unread,
            clients: clientCounts,
            service: {
              state: 'online',
              protocolVersion: service.protocolVersion,
              pid: service.pid,
              clients: service.clients,
              pendingRequests: service.pendingRequests,
              storageKind: service.storageKind,
            },
          };
          opts.events.emitCustom('mailbox.snapshot', snapshot);
        } catch (error) {
          if (opts.isCleaned() || generation !== registrationGeneration) return;
          opts.events.emitCustom('mailbox.snapshot', {
            messages: [],
            agents: [],
            unread: 0,
            clients: { tui: 0, webui: 0, repl: 0 },
            service: {
              state: 'offline',
              error: error instanceof Error ? error.message : String(error),
            },
          } satisfies TuiMailboxSnapshot);
        }
      };

      const scheduleSnapshot = (): void => {
        if (opts.isCleaned() || generation !== registrationGeneration) return;
        if (localSnapshotCoalesceTimer) return;
        const timer = setTimeout(() => {
          localSnapshotCoalesceTimer = null;
          if (snapshotCoalesceTimer === timer) snapshotCoalesceTimer = null;
          void publishSnapshot();
        }, SNAPSHOT_COALESCE_MS);
        localSnapshotCoalesceTimer = timer;
        snapshotCoalesceTimer = timer;
        timer.unref?.();
      };

      // Held in a local so the abort branch below can remove exactly THIS
      // subscription: two register() calls racing (F1 project switch) both
      // write the shared `unsubscribeMailboxEvents` slot, and the loser's
      // subscription used to leak — a live listener publishing snapshots
      // for a project the TUI had already left.
      unsubscribe = opts.events.onPattern('mailbox.*', (event) => {
        if (event === 'mailbox.snapshot' || event === 'mailbox.sync_clients') return;
        scheduleSnapshot();
      });
      unsubscribeMailboxEvents = unsubscribe;
      await attemptMailbox.registerClient({
        clientId: attemptClientId,
        sessionId: opts.getSessionId?.() ?? opts.projectRoot,
        name: `TUI [${path.basename(opts.projectRoot)}]`,
        source: 'tui',
        pid: process.pid,
      });
      clientRegistered = true;
      if (opts.isCleaned() || generation !== registrationGeneration) {
        // Mirror the unregister path: drop the listener AND close the
        // named-pipe connection. Leaving the pipe open here was what put
        // the NEXT startup on the "zombie pipe" recovery path after an F1
        // project switch aborted a registration mid-flight.
        bestEffort(unsubscribe);
        if (unsubscribeMailboxEvents === unsubscribe) unsubscribeMailboxEvents = null;
        await attemptMailbox.deregisterClient(attemptClientId).catch(() => undefined);
        bestEffort(() => attemptMailbox.close());
        return null;
      }
      registeredMailbox = attemptMailbox;
      registeredClientId = attemptClientId;
      await publishSnapshot();

      // The CLI host already owns the single session/fleet publisher. Standalone
      // TUI consumers still get a local publisher, which cleanup closes below.
      if (!opts.hqTelemetryOwnedExternally) {
        localHqPublisher = createHqPublisherFromEnv({
          clientKind: 'tui',
          projectRoot: opts.projectRoot,
          projectName: path.basename(opts.projectRoot),
          appConfig: opts.appConfig,
        } as never as Parameters<typeof createHqPublisherFromEnv>[0]);
        tuiHqPublisher = localHqPublisher;
        tuiHqPublisher?.connect();
        const tuiSessionId = opts.getSessionId?.() ?? opts.projectRoot;
        if (tuiHqPublisher) {
          try {
            stopHqAuxBridges.push(
              startSessionTelemetryBridge({
                publisher: tuiHqPublisher,
                events: opts.events,
                sessionId: tuiSessionId,
                projectRoot: opts.projectRoot,
                projectName: path.basename(opts.projectRoot),
              }),
            );
          } catch {
            /* optional */
          }
          try {
            stopHqAuxBridges.push(
              startFleetTelemetryBridge({
                events: opts.events,
                publisher: tuiHqPublisher,
                runId: tuiSessionId,
                sessionId: tuiSessionId,
              }),
            );
          } catch {
            /* optional */
          }
          try {
            stopHqAuxBridges.push(
              startBrainTelemetryBridge({
                events: opts.events,
                publisher: tuiHqPublisher,
                sessionId: tuiSessionId,
              }),
            );
          } catch {
            /* optional */
          }
          try {
            stopHqAuxBridges.push(
              startWorktreeTelemetryBridge({
                events: opts.events,
                publisher: tuiHqPublisher,
                sessionId: tuiSessionId,
              }),
            );
          } catch {
            /* optional */
          }
          try {
            stopHqAuxBridges.push(
              startToolTelemetryBridge({
                events: opts.events,
                publisher: tuiHqPublisher,
                projectRoot: opts.projectRoot,
                sessionId: tuiSessionId,
              }),
            );
          } catch {
            /* optional */
          }
          try {
            stopHqAuxBridges.push(
              startCostTelemetryBridge({
                events: opts.events,
                publisher: tuiHqPublisher,
                sessionId: tuiSessionId,
              }),
            );
          } catch {
            /* optional */
          }
        }
      }

      clientHeartbeatTimer = setInterval(() => {
        attemptMailbox
          .clientHeartbeat({
            clientId: attemptClientId,
            sessionId: opts.getSessionId?.() ?? opts.projectRoot,
          })
          .catch(() => {
            // best-effort — ignore heartbeat failures during shutdown
          });
      }, CLIENT_HEARTBEAT_MS);
      clientHeartbeatTimer.unref();

      const syncClients = async (): Promise<void> => {
        try {
          const statuses = await attemptMailbox.getClientStatuses();
          const counts = { tui: 0, webui: 0, repl: 0 };
          for (const s of statuses) {
            if (s.online && s.source in counts) counts[s.source as keyof typeof counts]++;
          }
          opts.events.emitCustom('mailbox.sync_clients', counts);
          await publishSnapshot();
        } catch {
          // best-effort — sync failures should not affect TUI operation
        }
      };
      initialClientSyncTimer = setTimeout(() => {
        initialClientSyncTimer = null;
        void syncClients();
      }, 5_000);
      initialClientSyncTimer.unref?.();
      clientSyncTimer = setInterval(() => void syncClients(), CLIENT_SYNC_MS);
      clientSyncTimer.unref();

      return attemptClientId;
    } catch {
      // best-effort — client registration errors should not block TUI startup
      bestEffort(unsubscribe);
      if (unsubscribeMailboxEvents === unsubscribe) unsubscribeMailboxEvents = null;
      if (localSnapshotCoalesceTimer) {
        clearTimeout(localSnapshotCoalesceTimer);
        if (snapshotCoalesceTimer === localSnapshotCoalesceTimer) snapshotCoalesceTimer = null;
      }
      if (mailbox) {
        if (clientRegistered && clientId) {
          await mailbox.deregisterClient(clientId).catch(() => undefined);
        }
        bestEffort(() => mailbox?.close());
      }
      if (registeredMailbox === mailbox) registeredMailbox = null;
      if (registeredClientId === clientId) registeredClientId = null;
      if (tuiHqPublisher === localHqPublisher) {
        bestEffort(() => localHqPublisher?.close());
        tuiHqPublisher = undefined;
      }
      return null;
    }
  };

  const unregister = (): void => {
    registrationGeneration++;
    if (clientHeartbeatTimer) {
      clearInterval(clientHeartbeatTimer);
      clientHeartbeatTimer = null;
    }
    if (clientSyncTimer) {
      clearInterval(clientSyncTimer);
      clientSyncTimer = null;
    }
    if (initialClientSyncTimer) {
      clearTimeout(initialClientSyncTimer);
      initialClientSyncTimer = null;
    }
    bestEffort(unsubscribeMailboxEvents);
    unsubscribeMailboxEvents = null;
    if (snapshotCoalesceTimer) {
      clearTimeout(snapshotCoalesceTimer);
      snapshotCoalesceTimer = null;
    }
    for (const stop of stopHqAuxBridges) {
      try {
        stop();
      } catch {
        /* ignore */
      }
    }
    stopHqAuxBridges.length = 0;
    bestEffort(() => tuiHqPublisher?.close());
    tuiHqPublisher = undefined;
    const mailbox = registeredMailbox;
    const clientId = registeredClientId;
    registeredMailbox = null;
    registeredClientId = null;
    if (mailbox && clientId) {
      void mailbox
        .deregisterClient(clientId)
        .catch(() => undefined)
        .finally(() => bestEffort(() => mailbox.close()));
    }
  };

  return { register, unregister };
}
