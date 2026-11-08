/**
 * A host's HQ connection: the publisher, kept pointed at the live HQ config, plus the
 * project's Kanban and SAGE sync it owns. Shared by the CLI (`hq-publisher.ts`, which adds
 * its version and socket) and the standalone engine behind WebUI/desktop.
 */
import type { Config } from '@wrongstack/contracts/types';
import type { CreateHqPublisherOptions, HqPublisher } from '@wrongstack/hq';
import { createHqPublisherFromEnv, resolveHqConfig } from '@wrongstack/hq';
import { createWrongMemoryHqSyncConnection } from '@wrongstack/sage';
import { createKanbanHqSync, type KanbanHqSyncStats } from './kanban-hq-sync.js';
import { createSageHqSync } from './sage-hq-sync.js';

/** The host supplies its own socket (each host bundles its own `ws`). */
export type HqHostPublisherOptions = Omit<CreateHqPublisherOptions, 'appConfig'> & {
  appConfig?: Pick<Config, 'hq' | 'Sage'> | undefined;
};

export interface HqHostConnection {
  getPublisher(): HqPublisher | undefined;
  getKanbanSyncStats(): KanbanHqSyncStats | undefined;
  stop(): void;
}

export interface HqHostConnectionOptions extends HqHostPublisherOptions {
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
  getAppConfig?: (() => HqHostPublisherOptions['appConfig']) | undefined;
  /**
   * `false` for an AUXILIARY connection in a process whose host connection
   * already syncs the project's Kanban boards. Two syncs in one process are
   * two writers applying the same remote snapshots to the same board files.
   */
  ownKanbanSync?: boolean | undefined;
  ownSageSync?: boolean | undefined;
}

/** Sentinel connection key for same-machine auto-discovery (see below). */
const HQ_DISCOVERY_CONNECTION_KEY = '<discover>';

export function createHqHostPublisher(options: HqHostPublisherOptions): HqPublisher | undefined {
  return createHqPublisherFromEnv({
    ...(options.version !== undefined ? { clientVersion: options.version } : {}),
    ...options,
  });
}

function hqExplicitlyDisabled(options: HqHostPublisherOptions): boolean {
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
function resolvedHqConnectionKey(options: HqHostPublisherOptions): string | undefined {
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
  return `${endpoint}\nraw=${String(config.rawContent)}\nsage=${options.appConfig?.Sage?.storage?.directory ?? ''}`;
}

export function startHqHostConnection(options: HqHostConnectionOptions): HqHostConnection {
  const shouldOwnKanbanSync =
    options.ownKanbanSync !== false && options.onKanbanSnapshot === undefined;
  let kanbanSync: ReturnType<typeof createKanbanHqSync> | undefined;
  let sageSync: ReturnType<typeof createSageHqSync> | undefined;
  const shouldOwnSageSync =
    (options.ownSageSync ?? options.ownKanbanSync !== false) &&
    options.onSageSnapshot === undefined;
  const publisherOptions: HqHostConnectionOptions = shouldOwnKanbanSync
    ? {
        ...options,
        onKanbanSnapshot: (snapshot) => kanbanSync?.handleRemote(snapshot),
      }
    : { ...options };
  if (shouldOwnSageSync)
    publisherOptions.onSageSnapshot = (snapshot) => sageSync?.handleRemote(snapshot);
  let publisher: HqPublisher | undefined;
  let publisherKey: string | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  const liveOptions = (): HqHostConnectionOptions =>
    options.getAppConfig === undefined
      ? publisherOptions
      : { ...publisherOptions, appConfig: options.getAppConfig() };

  const retire = (): void => {
    if (publisher === undefined) return;
    kanbanSync?.stop();
    kanbanSync = undefined;
    sageSync?.stop();
    sageSync = undefined;
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

    sageSync?.stop();
    sageSync = undefined;
    publisher?.close();
    publisher = undefined;
    publisherKey = undefined;

    const next = createHqHostPublisher(current);
    if (next === undefined) return;
    publisher = next;
    publisherKey = nextKey;
    if (shouldOwnKanbanSync) {
      kanbanSync?.stop();
      kanbanSync = createKanbanHqSync(options.projectRoot, next.project.projectId);
    }
    if (shouldOwnSageSync)
      sageSync = createSageHqSync(
        options.projectRoot,
        next,
        current.appConfig?.Sage?.storage?.directory,
        // In `wrongmemory` (or a resolved `auto`) mode the daemon owns the
        // store; never open the SAGE project server alongside it.
        createWrongMemoryHqSyncConnection({
          projectRoot: options.projectRoot,
          service: current.appConfig?.Sage?.service,
        }),
      );
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
      sageSync?.stop();
      publisher?.close();
      publisher = undefined;
      publisherKey = undefined;
    },
  };
}
