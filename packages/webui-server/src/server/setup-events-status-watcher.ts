import { watch as fsWatch } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { EventName, Listener } from '@wrongstack/core/kernel';
import type { WstackPaths } from '@wrongstack/core/utils';
import type { WebSocket } from 'ws';
import {
  averageFileWatcherDebounceDelay,
  type FileWatcherMetrics,
  initializeFileWatcherMetrics,
  logFileWatcherMetrics,
  shouldLogWatcherStats,
  statusProjectHashFromWatchFilename,
} from './setup-events-watcher.js';
import type { ConnectedClient, WSServerMessage } from './types.js';

interface SetupEventsStatusWatcherDeps {
  wpaths?: WstackPaths | undefined;
  watcherMetrics?: FileWatcherMetrics | undefined;
  clients: Map<WebSocket, ConnectedClient>;
  broadcast: (
    clients: Map<WebSocket, ConnectedClient>,
    msg: WSServerMessage,
    /** Deliver to the tab that owns this session, overriding the id on the
     *  payload. Needed when the payload names a SUBAGENT's session, which no
     *  tab subscribes to. */
    targetSessionId?: string,
  ) => void;
  on: <E extends EventName>(event: E, listener: Listener<E>) => (() => void) | void;
  isDisposed: () => boolean;
}

export function registerSetupEventsStatusWatcher(
  deps: SetupEventsStatusWatcherDeps,
): (() => void) | undefined {
  const { wpaths, watcherMetrics, clients, broadcast, on, isDisposed } = deps;
  if (!wpaths?.projectStatus || !wpaths.globalRoot) return undefined;

  const projectsDir = path.join(wpaths.globalRoot, 'projects');
  const knownProjectHashes = new Set<string>();
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const DEBOUNCE_MS = 150;
  const pendingStatuses = new Map<string, { data: unknown; firstWriteAt: number }>();

  if (watcherMetrics) initializeFileWatcherMetrics(watcherMetrics);

  const logWatcherMetricsEnabled = shouldLogWatcherStats();
  const logWatcherMetrics = () => logFileWatcherMetrics(watcherMetrics);
  const metricsInterval = logWatcherMetricsEnabled
    ? setInterval(logWatcherMetrics, 60_000)
    : undefined;
  metricsInterval?.unref?.();

  const broadcastStatus = (_projectHash: string, statusData: unknown, actualDelayMs: number) => {
    broadcast(clients, { type: 'client.status_update', payload: statusData });
    if (watcherMetrics) {
      watcherMetrics.broadcastsSent++;
      watcherMetrics.totalDebounceDelayMs += actualDelayMs;
      watcherMetrics.averageDebounceDelayMs = averageFileWatcherDebounceDelay(watcherMetrics);
    }
  };

  const scheduleBroadcast = (projectHash: string, statusData: unknown) => {
    const now = Date.now();
    const existing = pendingStatuses.get(projectHash);

    if (existing && watcherMetrics) {
      watcherMetrics.debounceResets++;
    }

    pendingStatuses.set(projectHash, {
      data: statusData,
      firstWriteAt: existing ? existing.firstWriteAt : now,
    });

    const existingTimer = debounceTimers.get(projectHash);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      debounceTimers.delete(projectHash);
      const pending = pendingStatuses.get(projectHash);
      if (pending) {
        const actualDelay = Date.now() - pending.firstWriteAt;
        broadcastStatus(projectHash, pending.data, actualDelay);
        pendingStatuses.delete(projectHash);
      }
    }, DEBOUNCE_MS);

    debounceTimers.set(projectHash, timer);
  };

  let watcher: import('fs').FSWatcher | undefined;

  const startWatcher = async () => {
    try {
      await fs.mkdir(projectsDir, { recursive: true });
      if (isDisposed()) return;

      watcher = fsWatch(
        projectsDir,
        { persistent: true, recursive: true },
        async (eventType, filename) => {
          if (eventType !== 'change' && eventType !== 'rename') return;
          if (filename == null) return;
          const projectHash = statusProjectHashFromWatchFilename(projectsDir, filename);
          if (!projectHash) return;

          if (watcherMetrics) watcherMetrics.fileChangesDetected++;
          if (!knownProjectHashes.has(projectHash)) return;
          if (watcherMetrics) watcherMetrics.filesProcessed++;

          try {
            const targetFile = path.join(projectsDir, projectHash, 'status.json');
            const content = await fs.readFile(targetFile, 'utf-8');
            const statusData = JSON.parse(content);
            scheduleBroadcast(projectHash, statusData);
          } catch {
            // File may not exist, be readable yet, or contain complete JSON yet.
          }
        },
      );

      if (logWatcherMetricsEnabled) {
        console.log(
          `[setup-events] Watching ${projectsDir} for status.json changes (hash-filtered, debounced)`,
        );
      }
    } catch (err) {
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'setup_events.status_watcher_start_failed',
          message: err instanceof Error ? err.message : String(err),
          timestamp: new Date().toISOString(),
        }),
      );
    }
  };

  const unlistenClientStatus = on('client.status', (e) => {
    if (e.projectHash) {
      const hash = String(e.projectHash);
      if (!knownProjectHashes.has(hash)) {
        knownProjectHashes.add(hash);
        if (watcherMetrics) watcherMetrics.activeProjects = knownProjectHashes.size;
      }
    }
  });

  startWatcher();

  return () => {
    if (typeof unlistenClientStatus === 'function') unlistenClientStatus();
    if (metricsInterval) clearInterval(metricsInterval);
    logWatcherMetrics();

    if (watcherMetrics) watcherMetrics.watcherActive = false;

    for (const [projectHash, pending] of pendingStatuses) {
      const timer = debounceTimers.get(projectHash);
      if (timer) {
        clearTimeout(timer);
        broadcastStatus(projectHash, pending.data, 0);
      }
    }

    for (const timer of debounceTimers.values()) {
      clearTimeout(timer);
    }
    debounceTimers.clear();
    pendingStatuses.clear();

    if (watcher) {
      watcher.close();
      if (logWatcherMetricsEnabled) console.log('[setup-events] Closed status file watcher');
    }
  };
}
