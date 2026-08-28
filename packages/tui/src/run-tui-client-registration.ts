import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { RemoteMailbox, resolveProjectDir } from '@wrongstack/core/coordination';
import {
  createHqPublisherFromEnv,
  startBrainTelemetryBridge,
  startCostTelemetryBridge,
  startFleetTelemetryBridge,
  startSessionTelemetryBridge,
  startToolTelemetryBridge,
  startWorktreeTelemetryBridge,
} from '@wrongstack/core/hq';
import type { EventBus } from '@wrongstack/core/kernel';
import type { Config } from '@wrongstack/core/types';
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

  const register = async (): Promise<string | null> => {
    if (!opts.projectRoot) return null;
    const generation = ++registrationGeneration;
    try {
      const projectDir = resolveProjectDir(opts.projectRoot, wstackGlobalRoot());
      const mailbox = new RemoteMailbox({ projectDir, events: opts.events });
      const clientId = `tui@${randomUUID().slice(0, 8)}`;
      await mailbox.initialize();

      const publishSnapshot = async (): Promise<void> => {
        if (opts.isCleaned() || generation !== registrationGeneration) return;
        try {
          const actorId = opts.getAgentId?.();
          const [messages, agents, clients, service, unread] = await Promise.all([
            mailbox.query({ limit: 50 }),
            mailbox.getAgentStatuses(),
            mailbox.getClientStatuses(),
            mailbox.status(),
            actorId === undefined ? Promise.resolve(0) : mailbox.unreadCount(actorId),
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
        if (snapshotCoalesceTimer) return;
        snapshotCoalesceTimer = setTimeout(() => {
          snapshotCoalesceTimer = null;
          void publishSnapshot();
        }, SNAPSHOT_COALESCE_MS);
        snapshotCoalesceTimer.unref?.();
      };

      // Held in a local so the abort branch below can remove exactly THIS
      // subscription: two register() calls racing (F1 project switch) both
      // write the shared `unsubscribeMailboxEvents` slot, and the loser's
      // subscription used to leak — a live listener publishing snapshots
      // for a project the TUI had already left.
      const unsubscribe = opts.events.onPattern('mailbox.*', (event) => {
        if (event === 'mailbox.snapshot' || event === 'mailbox.sync_clients') return;
        scheduleSnapshot();
      });
      unsubscribeMailboxEvents = unsubscribe;
      await mailbox.registerClient({
        clientId,
        sessionId: opts.getSessionId?.() ?? opts.projectRoot,
        name: `TUI [${path.basename(opts.projectRoot)}]`,
        source: 'tui',
        pid: process.pid,
      });
      if (opts.isCleaned() || generation !== registrationGeneration) {
        // Mirror the unregister path: drop the listener AND close the
        // named-pipe connection. Leaving the pipe open here was what put
        // the NEXT startup on the "zombie pipe" recovery path after an F1
        // project switch aborted a registration mid-flight.
        unsubscribe();
        if (unsubscribeMailboxEvents === unsubscribe) unsubscribeMailboxEvents = null;
        await mailbox.deregisterClient(clientId).catch(() => undefined);
        mailbox.close();
        return null;
      }
      registeredMailbox = mailbox;
      registeredClientId = clientId;
      await publishSnapshot();

      // The CLI host already owns the single session/fleet publisher. Standalone
      // TUI consumers still get a local publisher, which cleanup closes below.
      if (!opts.hqTelemetryOwnedExternally) {
        tuiHqPublisher = createHqPublisherFromEnv({
          clientKind: 'tui',
          projectRoot: opts.projectRoot,
          projectName: path.basename(opts.projectRoot),
          appConfig: opts.appConfig,
        } as never as Parameters<typeof createHqPublisherFromEnv>[0]);
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
        mailbox
          .clientHeartbeat({ clientId, sessionId: opts.getSessionId?.() ?? opts.projectRoot })
          .catch(() => {
            // best-effort — ignore heartbeat failures during shutdown
          });
      }, CLIENT_HEARTBEAT_MS);
      clientHeartbeatTimer.unref();

      const syncClients = async (): Promise<void> => {
        try {
          const statuses = await mailbox.getClientStatuses();
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

      return clientId;
    } catch {
      // best-effort — client registration errors should not block TUI startup
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
    unsubscribeMailboxEvents?.();
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
    tuiHqPublisher?.close();
    tuiHqPublisher = undefined;
    const mailbox = registeredMailbox;
    const clientId = registeredClientId;
    registeredMailbox = null;
    registeredClientId = null;
    if (mailbox && clientId) {
      void mailbox
        .deregisterClient(clientId)
        .catch(() => undefined)
        .finally(() => mailbox.close());
    }
  };

  return { register, unregister };
}
