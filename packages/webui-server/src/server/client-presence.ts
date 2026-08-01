import * as crypto from 'node:crypto';
import * as path from 'node:path';
import {
  getSharedProjectMailbox,
  type RemoteMailbox,
  resolveProjectDir,
} from '@wrongstack/core/coordination';
import { startSessionTelemetryBridge } from '@wrongstack/core/hq';
import { wstackGlobalRoot } from '@wrongstack/core/utils';
import type { Config } from '@wrongstack/core/types';
import type {
  CreateHqPublisherOptions,
  HqClientCapability,
  HqPublisher,
} from '@wrongstack/core/hq';
import type { EventBus } from '@wrongstack/core/kernel';

const CLIENT_HEARTBEAT_MS = 15_000;

export interface WebuiHqConnection {
  getPublisher(): HqPublisher | undefined;
  stop(): void;
}

export type WebuiHqConnectionOptions = Omit<CreateHqPublisherOptions, 'socketFactory'> & {
  onConnect?: ((publisher: HqPublisher) => void) | undefined;
};

export interface WebuiClientPresenceDeps {
  projectRoot: string | undefined;
  appConfig: Config | undefined;
  events: EventBus;
  hqSessionId: string;
  getSessionId: () => string;
  startHqConnection: (options: WebuiHqConnectionOptions) => WebuiHqConnection;
  createCommandHandler?:
    | ((mailbox: RemoteMailbox) => NonNullable<CreateHqPublisherOptions['onCommand']>)
    | undefined;
}

export interface WebuiClientPresence {
  register(): Promise<string | null>;
  unregister(): void;
}

export function createWebuiClientPresence(deps: WebuiClientPresenceDeps): WebuiClientPresence {
  let clientId: string | null = null;
  let mailbox: RemoteMailbox | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let stopTelemetry: (() => void) | undefined;
  let hqConnection: WebuiHqConnection | undefined;
  let closed = false;

  const register = async (): Promise<string | null> => {
    if (!deps.projectRoot) return null;
    try {
      const projectRoot = deps.projectRoot;
      const projectName = path.basename(projectRoot);
      const nextMailbox = getSharedProjectMailbox(
        resolveProjectDir(projectRoot, wstackGlobalRoot()),
        deps.events,
        () => hqConnection?.getPublisher(),
      );
      mailbox = nextMailbox;

      const onCommand = deps.createCommandHandler?.(nextMailbox);
      const capabilities: HqClientCapability[] = [
        'telemetry.publish',
        'mailbox.summary',
        'fleet.summary',
        'session.summary',
      ];
      if (onCommand) capabilities.push('control.receive');

      hqConnection = deps.startHqConnection({
        clientKind: 'webui',
        projectRoot,
        projectName,
        appConfig: deps.appConfig,
        capabilities,
        ...(onCommand ? { onCommand } : {}),
        onConnect: (publisher) => {
          stopTelemetry?.();
          stopTelemetry = startSessionTelemetryBridge({
            publisher,
            events: deps.events,
            sessionId: deps.hqSessionId,
            projectRoot,
            projectName,
            startedAt: new Date().toISOString(),
          });
        },
      });

      clientId = `webui@${crypto.randomUUID().slice(0, 8)}`;
      closed = false;
      await nextMailbox.registerClient({
        clientId,
        sessionId: deps.getSessionId(),
        name: `WebUI [${projectName}]`,
        source: 'webui',
        pid: process.pid,
      });

      if (closed) {
        nextMailbox.deregisterClient(clientId!).catch(() => undefined);
        return null;
      }

      heartbeatTimer = setInterval(() => {
        nextMailbox
          .clientHeartbeat({ clientId: clientId!, sessionId: deps.getSessionId() })
          .catch(() => undefined);
      }, CLIENT_HEARTBEAT_MS);
      heartbeatTimer.unref();
      return clientId;
    } catch {
      return null;
    }
  };

  const unregister = (): void => {
    closed = true;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    stopTelemetry?.();
    stopTelemetry = undefined;
    hqConnection?.stop();
    hqConnection = undefined;
    const previousClientId = clientId;
    const previousMailbox = mailbox;
    clientId = null;
    mailbox = undefined;
    if (previousMailbox && previousClientId) {
      void previousMailbox.deregisterClient(previousClientId).catch(() => undefined);
    }
  };

  return { register, unregister };
}
