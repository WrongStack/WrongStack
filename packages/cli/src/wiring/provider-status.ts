/** Persistent provider/model waiting-room state for the CLI runtime. */
import * as fs from 'node:fs/promises';
import type { FallbackProfileManager } from '@wrongstack/core/agent';
import { ProviderModelStatusTracker } from '@wrongstack/core/coordination';
import type { EventBus } from '@wrongstack/core/kernel';
import type { WstackPaths } from '@wrongstack/core/utils';
import { atomicWrite, withFileLock } from '@wrongstack/core/utils';

export interface ProviderStatusInput {
  events: EventBus;
  paths: WstackPaths;
  fallbackProfileManager: FallbackProfileManager;
  logger: {
    info(message: string): void;
    warn(message: string): void;
  };
  teardownHandlers: Array<() => void>;
}

export async function setupProviderStatus(input: ProviderStatusInput) {
  const tracker = new ProviderModelStatusTracker({ events: input.events });
  const statusFile = input.paths.profileProviderStatus(input.paths.profileName);
  try {
    const saved = JSON.parse(await fs.readFile(statusFile, 'utf8')) as unknown;
    const restored = tracker.restoreSnapshot(saved);
    if (restored > 0) input.logger.info(`Restored ${restored} provider waiting-room entries`);
  } catch (error) {
    warnUnlessMissing(input.logger, 'restore', error);
  }
  input.fallbackProfileManager.setStatusTracker(tracker);

  let syncRunning = false;
  const sweep = setInterval(() => {
    tracker.sweepExpired();
    if (syncRunning) return;
    syncRunning = true;
    void fs
      .readFile(statusFile, 'utf8')
      .then((raw) => tracker.restoreSnapshot(JSON.parse(raw) as unknown))
      .catch((error: unknown) => warnUnlessMissing(input.logger, 'sync', error))
      .finally(() => {
        syncRunning = false;
      });
  }, 30_000);
  sweep.unref();

  type Change = { providerId: string; model: string; state: 'healthy' | 'degraded' | 'blocked' };
  const pending = new Map<string, Change>();
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  const persist = async () => {
    const changes = [...pending.values()];
    pending.clear();
    if (changes.length === 0) return;
    try {
      await withFileLock(statusFile, async () => {
        let statuses: unknown[] = [];
        try {
          const current = JSON.parse(await fs.readFile(statusFile, 'utf8')) as {
            statuses?: unknown;
          };
          if (Array.isArray(current.statuses)) statuses = current.statuses;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        for (const change of changes) {
          statuses = statuses.filter((raw) => {
            if (!raw || typeof raw !== 'object') return false;
            const item = raw as Record<string, unknown>;
            return item['providerId'] !== change.providerId || item['model'] !== change.model;
          });
          if (change.state !== 'healthy') {
            const current = tracker.getStatus(change.providerId, change.model);
            if (current && current.state !== 'healthy') statuses.push(current);
          }
        }
        await atomicWrite(
          statusFile,
          JSON.stringify({ version: 1, updatedAt: Date.now(), statuses }, null, 2),
          { mode: 0o600 },
        );
      });
    } catch (error) {
      for (const change of changes) {
        const key = `${change.providerId}\x00${change.model}`;
        if (!pending.has(key)) pending.set(key, change);
      }
      throw error;
    }
  };
  const unsubscribe = input.events.on('provider.status_changed', (event) => {
    pending.set(`${event.providerId}\x00${event.model}`, {
      providerId: event.providerId,
      model: event.model,
      state: event.newState,
    });
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = undefined;
      void persist().catch((error: unknown) =>
        input.logger.warn(
          `Could not persist provider waiting room: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }, 100);
    saveTimer.unref();
  });
  input.teardownHandlers.push(() => {
    clearInterval(sweep);
    if (saveTimer) clearTimeout(saveTimer);
    unsubscribe();
    void persist().catch(() => undefined);
  });
  return tracker;
}

function warnUnlessMissing(
  logger: ProviderStatusInput['logger'],
  operation: 'restore' | 'sync',
  error: unknown,
): void {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
    logger.warn(
      `Could not ${operation} provider waiting room: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
