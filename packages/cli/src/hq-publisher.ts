import type { CreateHqPublisherOptions, HqPublisher, HqSocketLike } from '@wrongstack/core/hq';
import { createHqPublisherFromEnv, resolveHqConfig } from '@wrongstack/core/hq';
import { WebSocket } from 'ws';
import { createKanbanHqSync, type KanbanHqSyncStats } from './kanban-hq-sync.js';
import { CLI_VERSION } from './version.js';

type CliHqPublisherOptions = Omit<CreateHqPublisherOptions, 'socketFactory'> & {
  socketFactory?: CreateHqPublisherOptions['socketFactory'];
};

export interface CliHqConnection {
  getPublisher(): HqPublisher | undefined;
  getKanbanSyncStats(): KanbanHqSyncStats | undefined;
  stop(): void;
}

interface CliHqConnectionOptions extends CliHqPublisherOptions {
  onConnect?: ((publisher: HqPublisher) => void) | undefined;
  /**
   * Called when a publisher is retired without an immediate replacement —
   * HQ was turned off (or its endpoint removed) in the live config. Hosts
   * stop the bridges they bound in `onConnect`.
   */
  onDisconnect?: (() => void) | undefined;
  retryIntervalMs?: number | undefined;
  /**
   * The LIVE app config. `appConfig` is a snapshot taken at boot; with this
   * set, `/hq set|token|on|off|clear` take effect on the running connection
   * within one retry interval instead of at the next session start.
   */
  getAppConfig?: (() => CliHqPublisherOptions['appConfig']) | undefined;
  /**
   * `false` for an AUXILIARY connection in a process whose host connection
   * already syncs the project's Kanban boards. Two syncs in one process are
   * two writers applying the same remote snapshots to the same board files.
   */
  ownKanbanSync?: boolean | undefined;
}

/** Sentinel connection key for same-machine auto-discovery (see below). */
const HQ_DISCOVERY_CONNECTION_KEY = '<discover>';

function nodeWsSocketFactory(url: string): HqSocketLike {
  return new WebSocket(url) as unknown as HqSocketLike;
}

export function createCliHqPublisher(options: CliHqPublisherOptions): HqPublisher | undefined {
  return createHqPublisherFromEnv({
    clientVersion: options.clientVersion ?? options.version ?? CLI_VERSION,
    ...options,
    socketFactory: options.socketFactory ?? nodeWsSocketFactory,
  });
}

function hqExplicitlyDisabled(options: CliHqPublisherOptions): boolean {
  const envEnabled = process.env['WRONGSTACK_HQ_ENABLED']?.trim();
  if (envEnabled !== undefined && envEnabled.length > 0) return envEnabled === '0';
  if (options.config?.enabled !== undefined) return options.config.enabled === false;
  return options.appConfig?.hq?.enabled === false;
}

/**
 * Identity of the HQ endpoint this connection is for. A change means the
 * publisher must be torn down and rebuilt; a stable value means leave it alone.
 *
 * Auto-discovery is deliberately ONE key. In that mode the resolved url/token
 * come from `runtime.json` + `auth.json`, which move on their own: HQ starting,
 * restarting on another port, or minting the first client token all rewrite
 * them. Keying on the resolved values made this poll rebuild the publisher —
 * and a rebuild mints a NEW clientId, so HQ saw a fresh client (plus a ghost of
 * the old one until its socket dropped) for what is one process. The publisher
 * already follows those moves itself: `resolveEndpoint` re-reads the marker
 * before EVERY connect attempt, which is both cheaper and lossless (the bounded
 * outbound queue survives, a rebuild discards it).
 */
function resolvedHqConnectionKey(options: CliHqPublisherOptions): string | undefined {
  const config =
    options.config !== undefined
      ? options.config.enabled === false
        ? undefined
        : options.config
      : resolveHqConfig({ config: options.appConfig?.hq });
  if (config === undefined) return undefined;
  const endpoint =
    config.discover === true ? HQ_DISCOVERY_CONNECTION_KEY : `${config.url}\n${config.token ?? ''}`;
  // The redaction policy is fixed when a publisher is built, so a `/hq raw`
  // toggle only takes effect through a rebuild. It comes from config/env, not
  // from the discovery marker, so it cannot cause discovery churn.
  return `${endpoint}\nraw=${String(config.rawContent)}`;
}

export function startCliHqConnection(options: CliHqConnectionOptions): CliHqConnection {
  const shouldOwnKanbanSync =
    options.ownKanbanSync !== false && options.onKanbanSnapshot === undefined;
  let kanbanSync: ReturnType<typeof createKanbanHqSync> | undefined;
  const publisherOptions: CliHqConnectionOptions = shouldOwnKanbanSync
    ? {
        ...options,
        onKanbanSnapshot: (snapshot) => kanbanSync?.handleRemote(snapshot),
      }
    : options;
  let publisher: HqPublisher | undefined;
  let publisherKey: string | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  const liveOptions = (): CliHqConnectionOptions =>
    options.getAppConfig === undefined
      ? publisherOptions
      : { ...publisherOptions, appConfig: options.getAppConfig() };

  const retire = (): void => {
    if (publisher === undefined) return;
    kanbanSync?.stop();
    kanbanSync = undefined;
    publisher.close();
    publisher = undefined;
    publisherKey = undefined;
    options.onDisconnect?.();
  };

  const tryConnect = (): void => {
    const current = liveOptions();
    const nextKey = resolvedHqConnectionKey(current);
    if (nextKey === undefined) {
      // Disabled or unconfigured NOW. Returning early here used to leave a
      // publisher built from an earlier config streaming on, so `/hq off`
      // could not stop a running session.
      retire();
      return;
    }
    if (publisher !== undefined && publisherKey === nextKey) {
      // Same endpoint identity — keep the publisher. In discovery mode the
      // marker underneath may still have repointed (HQ restarted on another
      // port), so let the publisher move itself: that keeps its clientId and
      // its queued telemetry, where a rebuild would mint a new client and drop
      // the queue.
      if (nextKey.startsWith(`${HQ_DISCOVERY_CONNECTION_KEY}\n`)) publisher.refreshEndpoint();
      return;
    }

    publisher?.close();
    publisher = undefined;
    publisherKey = undefined;

    const next = createCliHqPublisher(current);
    if (next === undefined) return;
    publisher = next;
    publisherKey = nextKey;
    if (shouldOwnKanbanSync) {
      kanbanSync?.stop();
      kanbanSync = createKanbanHqSync(options.projectRoot, next.project.projectId);
    }
    next.connect();
    if (kanbanSync !== undefined) {
      kanbanSync.attachPublisher(next).catch((error: unknown) => {
        process.emitWarning(
          `WrongStack kanban HQ sync attach failed (best-effort, retried on reconnect): ${
            error instanceof Error ? error.message : String(error)
          }`,
          { code: 'WRONGSTACK_HQ_KANBAN_SYNC_FAILED' },
        );
      });
    }
    options.onConnect?.(next);
  };

  tryConnect();
  // With a live config the poll must run even when HQ starts disabled —
  // otherwise `/hq on` has nothing to act on until the next session.
  if (options.getAppConfig !== undefined || !hqExplicitlyDisabled(options)) {
    timer = setInterval(tryConnect, options.retryIntervalMs ?? 2_500);
    timer.unref?.();
  }

  return {
    getPublisher: () => publisher,
    getKanbanSyncStats: () => kanbanSync?.getStats(),
    stop: () => {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
      kanbanSync?.stop();
      publisher?.close();
      publisher = undefined;
      publisherKey = undefined;
    },
  };
}
