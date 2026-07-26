import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { GlobalMailbox, resolveProjectDir } from '@wrongstack/core/coordination';
import type { EventBus } from '@wrongstack/core/kernel';
import type { Config } from '@wrongstack/core/types';
import { wstackGlobalRoot } from '@wrongstack/core/utils';
import {
  createHqPublisherFromEnv,
  startBrainTelemetryBridge,
  startCostTelemetryBridge,
  startFleetTelemetryBridge,
  startSessionTelemetryBridge,
  startToolTelemetryBridge,
  startWorktreeTelemetryBridge,
} from '@wrongstack/core/hq';

export interface RunTuiClientRegistrationOptions {
  projectRoot?: string | undefined;
  events: EventBus;
  appConfig?: Config | undefined;
  hqTelemetryOwnedExternally?: boolean | undefined;
  getSessionId?: (() => string | undefined) | undefined;
  isCleaned: () => boolean;
}

export interface RunTuiClientRegistration {
  register(): Promise<string | null>;
  unregister(): void;
}

const CLIENT_HEARTBEAT_MS = 15_000;
/** Sync client counts from the shared registry every 30s so closed clients disappear promptly. */
const CLIENT_SYNC_MS = 30_000;

export function createRunTuiClientRegistration(
  opts: RunTuiClientRegistrationOptions,
): RunTuiClientRegistration {
  let clientHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let clientSyncTimer: ReturnType<typeof setInterval> | null = null;
  let initialClientSyncTimer: ReturnType<typeof setTimeout> | null = null;
  let registeredMailbox: GlobalMailbox | null = null;
  let registeredClientId: string | null = null;
  let tuiHqPublisher: ReturnType<typeof createHqPublisherFromEnv>;
  let registrationGeneration = 0;
  const stopHqAuxBridges: Array<() => void> = [];

  const register = async (): Promise<string | null> => {
    if (!opts.projectRoot) return null;
    const generation = ++registrationGeneration;
    try {
      const projectDir = resolveProjectDir(opts.projectRoot, wstackGlobalRoot());
      const mailbox = new GlobalMailbox(projectDir, opts.events);
      const clientId = `tui@${randomUUID().slice(0, 8)}`;
      await mailbox.registerClient({
        clientId,
        sessionId: opts.getSessionId?.() ?? opts.projectRoot,
        name: `TUI [${path.basename(opts.projectRoot)}]`,
        source: 'tui',
        pid: process.pid,
      });
      if (opts.isCleaned() || generation !== registrationGeneration) {
        await mailbox.deregisterClient(clientId);
        return null;
      }
      registeredMailbox = mailbox;
      registeredClientId = clientId;

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
    if (mailbox && clientId) void mailbox.deregisterClient(clientId).catch(() => undefined);
  };

  return { register, unregister };
}
