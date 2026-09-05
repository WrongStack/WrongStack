import type { CreateHqPublisherOptions, HqPublisher, HqSocketLike } from '@wrongstack/core/hq';
import { createHqPublisherFromEnv, resolveHqConfig } from '@wrongstack/core/hq';
import { WebSocket } from 'ws';
import { createKanbanHqSync, type KanbanHqSyncStats } from './kanban-hq-sync.js';

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
  retryIntervalMs?: number | undefined;
}

/** Sentinel connection key for same-machine auto-discovery (see below). */
const HQ_DISCOVERY_CONNECTION_KEY = '<discover>';

function nodeWsSocketFactory(url: string): HqSocketLike {
  return new WebSocket(url) as unknown as HqSocketLike;
}

export function createCliHqPublisher(options: CliHqPublisherOptions): HqPublisher | undefined {
  return createHqPublisherFromEnv({
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
  if (options.config !== undefined) {
    if (options.config.enabled === false) return undefined;
    return options.config.discover === true
      ? HQ_DISCOVERY_CONNECTION_KEY
      : `${options.config.url}\n${options.config.token ?? ''}`;
  }
  const config = resolveHqConfig({ config: options.appConfig?.hq });
  if (config === undefined) return undefined;
  return config.discover === true
    ? HQ_DISCOVERY_CONNECTION_KEY
    : `${config.url}\n${config.token ?? ''}`;
}

export function startCliHqConnection(options: CliHqConnectionOptions): CliHqConnection {
  const shouldOwnKanbanSync = options.onKanbanSnapshot === undefined;
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

  const tryConnect = (): void => {
    const nextKey = resolvedHqConnectionKey(options);
    if (nextKey === undefined) return;
    if (publisher !== undefined && publisherKey === nextKey) {
      // Same endpoint identity — keep the publisher. In discovery mode the
      // marker underneath may still have repointed (HQ restarted on another
      // port), so let the publisher move itself: that keeps its clientId and
      // its queued telemetry, where a rebuild would mint a new client and drop
      // the queue.
      if (nextKey === HQ_DISCOVERY_CONNECTION_KEY) publisher.refreshEndpoint();
      return;
    }

    publisher?.close();
    publisher = undefined;
    publisherKey = undefined;

    const next = createCliHqPublisher(publisherOptions);
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
  if (!hqExplicitlyDisabled(options)) {
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
