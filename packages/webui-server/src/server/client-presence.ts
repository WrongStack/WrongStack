import * as crypto from 'node:crypto';
import * as path from 'node:path';
import {
  getSharedProjectMailbox,
  type RemoteMailbox,
  resolveProjectDir,
} from '@wrongstack/core/coordination';
import type {
  CreateHqPublisherOptions,
  HqClientCapability,
  HqPublisher,
} from '@wrongstack/core/hq';
import type { EventBus } from '@wrongstack/core/kernel';
import type { Config } from '@wrongstack/core/types';
import { wstackGlobalRoot } from '@wrongstack/core/utils';
import {
  startWebuiHqSessionTelemetry,
  type WebuiHqSessionTelemetry,
} from './hq-session-telemetry.js';

const CLIENT_HEARTBEAT_MS = 15_000;
/** How often the set of displayed sessions is reconciled against HQ. */
const SESSION_SYNC_MS = 2_000;

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
  /**
   * The boot session. Used as the HQ fallback when no browser is displaying
   * anything yet, and as the mailbox client's session stamp.
   */
  hqSessionId: string;
  getSessionId: () => string;
  /**
   * Session ids the connected browsers currently display — one per open tab.
   *
   * Absent means "just the boot session", which is what every caller did
   * before per-tab telemetry existed.
   */
  listSessions?: (() => readonly string[]) | undefined;
  /** Sessions another publisher in this process already announces to HQ. */
  isSessionOwnedElsewhere?: ((sessionId: string) => boolean) | undefined;
  /** A tab's own session writer, when the host holds one. */
  getSessionWriter?:
    | ((sessionId: string) => import('@wrongstack/core/types').SessionWriter | undefined)
    | undefined;
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
  let sessionTelemetry: WebuiHqSessionTelemetry | undefined;
  let syncTimer: ReturnType<typeof setInterval> | null = null;
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
        onConnect: () => {
          // Every open tab is its own session; HQ used to hear about only the
          // boot one. The manager keeps a bridge alive per displayed session
          // and reconciles on each sync.
          sessionTelemetry?.stop();
          sessionTelemetry = startWebuiHqSessionTelemetry({
            events: deps.events,
            projectRoot,
            projectName,
            globalRoot: wstackGlobalRoot(),
            getPublisher: () => hqConnection?.getPublisher(),
            listSessions: () => {
              const live = deps.listSessions?.() ?? [];
              // Nothing on screen yet (no browser attached, or a surface that
              // never reports tabs): fall back to the boot session so HQ still
              // sees this host.
              return live.length > 0 ? live : [deps.hqSessionId];
            },
            ...(deps.isSessionOwnedElsewhere
              ? { isOwnedElsewhere: deps.isSessionOwnedElsewhere }
              : {}),
            ...(deps.getSessionWriter ? { getWriter: deps.getSessionWriter } : {}),
          });
          sessionTelemetry.sync();
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

      // Tabs open and close without this layer being told, so reconcile on a
      // cheap timer: `sync` diffs a handful of ids and does nothing when the
      // set is unchanged.
      syncTimer = setInterval(() => sessionTelemetry?.sync(), SESSION_SYNC_MS);
      syncTimer.unref();
      return clientId;
    } catch {
      return null;
    }
  };

  const unregister = (): void => {
    closed = true;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    if (syncTimer) clearInterval(syncTimer);
    syncTimer = null;
    sessionTelemetry?.stop();
    sessionTelemetry = undefined;
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
