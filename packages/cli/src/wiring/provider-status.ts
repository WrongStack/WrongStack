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

  /** Pairs manually cleared in THIS process → epoch ms of the clear. */
  const clearedPairs = new Map<string, number>();

  let syncRunning = false;
  const sweep = setInterval(() => {
    tracker.sweepExpired();
    if (syncRunning) return;
    syncRunning = true;
    void fs
      .readFile(statusFile, 'utf8')
      .then((raw) => {
        const parsed = JSON.parse(raw) as { statuses?: unknown };
        const statuses = Array.isArray(parsed.statuses) ? parsed.statuses : [];
        // Newer-wins cross-sync: a pair manually cleared in THIS process must
        // not be resurrected by a stale row another CLI process wrote before
        // the clear. A row whose lastFailureAt is NEWER than the clear is a
        // genuine fresh failure — it wins and lifts the tombstone.
        const filtered: unknown[] = [];
        const purged: Array<{ providerId: string; model: string }> = [];
        let queuedRefresh = false;
        for (const item of statuses) {
          const record = item as Record<string, unknown> | null;
          const providerId =
            typeof record?.['providerId'] === 'string' ? record['providerId'] : undefined;
          const model = typeof record?.['model'] === 'string' ? record['model'] : undefined;
          const key =
            providerId !== undefined && model !== undefined
              ? `${providerId}\x00${model}`
              : undefined;
          const failedAt =
            typeof record?.['lastFailureAt'] === 'number' ? record['lastFailureAt'] : 0;
          // Newer-wins: a peer row must never overwrite a fresher local
          // event — neither a newer local failure nor a manual clear.
          const local =
            providerId !== undefined && model !== undefined
              ? tracker.getStatus(providerId, model)
              : undefined;
          const localFailedAt =
            typeof local?.lastFailureAt === 'number' ? local.lastFailureAt : 0;
          const clearedAt = key !== undefined ? clearedPairs.get(key) : undefined;
          if (localFailedAt > failedAt) {
            if (clearedAt !== undefined && clearedAt < localFailedAt) {
              clearedPairs.delete(key!);
            }
            continue; // the local state is authoritative
          }
          if (clearedAt !== undefined && clearedAt >= failedAt) {
            if (local && local.state !== 'healthy') {
              // Re-blocked locally since the clear: refresh the row from the
              // live tracker instead of purging it, and lift the tombstone.
              clearedPairs.delete(key!);
              pending.set(key!, {
                providerId: providerId!,
                model: model!,
                state: local.state,
              });
              queuedRefresh = true;
            } else {
              purged.push({ providerId: providerId!, model: model! });
            }
            continue;
          }
          filtered.push(item);
        }
        tracker.restoreSnapshot({ statuses: filtered });
        // Drop the stale rows from disk as well, so the next boot's restore
        // (which has no tombstone memory) cannot bring them back. Refreshed
        // rows re-persist through the same debounced write.
        if (purged.length > 0 || queuedRefresh) {
          for (const { providerId, model } of purged) {
            pending.set(`${providerId}\x00${model}`, {
              providerId,
              model,
              state: 'healthy',
            });
          }
          void persist().catch((error: unknown) =>
            input.logger.warn(
              `Could not persist provider waiting room: ${error instanceof Error ? error.message : String(error)}`,
            ),
          );
        }
      })
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
    const key = `${event.providerId}\x00${event.model}`;
    // Manual clears (WebUI "Clear tracking", /provider-status clear) leave a
    // tombstone so the 30s cross-sync cannot resurrect the pair from a row
    // another CLI process persisted before the clear.
    if (
      event.newState === 'healthy' &&
      (event.reason === 'manual_clear' || event.reason === 'manual_clear_all')
    ) {
      // Bound the map: manual clears are rare, but a runaway loop should not
      // grow it without limit — drop the oldest entry past the cap.
      if (clearedPairs.size >= 500) {
        const oldest = clearedPairs.keys().next();
        if (oldest.done !== true) clearedPairs.delete(oldest.value);
      }
      clearedPairs.set(key, Date.now());
    }
    pending.set(key, {
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
