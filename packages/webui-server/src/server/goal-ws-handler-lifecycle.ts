import { toErrorMessage } from '@wrongstack/core/utils';
import type { WebSocket } from 'ws';
import { moveGoalRun } from './goal-run-state-sync.js';
import type { GoalWsHandlerInternals, WSClient } from './goal-ws-handler-internals.js';

/**
 * Client attach + teardown for `GoalWebSocketHandler`: socket registration
 * with close/error cleanup and the root catalog timer, and the disposal path
 * that stops in-flight work and releases the run lease.
 */
export function attachGoalClient(self: GoalWsHandlerInternals, ws: WebSocket): void {
  const readyState = (ws as { readyState?: unknown }).readyState;
  if (self.disposed || readyState === 2 || readyState === 3) return;
  for (const existing of self.clients) {
    if (existing.ws === ws) return;
  }
  const onClose = () => {
    self.clients.delete(client);
    client.cleanup();
    if (self.clients.size === 0 && self.catalogTimer) {
      clearInterval(self.catalogTimer);
      self.catalogTimer = null;
    }
  };
  const client: WSClient = {
    ws,
    id: crypto.randomUUID(),
    cleanup: () => {
      if (typeof ws.off === 'function') {
        ws.off('close', onClose);
        ws.off('error', onClose);
      } else if (typeof ws.removeListener === 'function') {
        ws.removeListener('close', onClose);
        ws.removeListener('error', onClose);
      }
    },
  };
  self.clients.add(client);

  ws.on('close', onClose);
  ws.on('error', onClose);

  // Send current state
  self.sendState(client);
  if (!self.goalId) {
    for (const goal of self.goals.values()) goal.addClient(ws);
    if (!self.catalogTimer) {
      self.catalogTimer = setInterval(() => {
        // Only news goes out on the timer; an identical catalog every two seconds was noise
        // that every client (and the desktop's on-disk journal) had to take.
        void self.broadcastCatalog({ onlyIfChanged: true });
      }, 2000);
      self.catalogTimer.unref?.();
    }
  }
}

/** Release timers, in-flight work, and socket references owned by this host. */
export function disposeGoalHandler(self: GoalWsHandlerInternals): void {
  self.stopGeneration++;
  self.disposed = true;
  if (self.catalogTimer) clearInterval(self.catalogTimer);
  self.catalogTimer = null;
  for (const goal of self.goals.values()) goal.dispose();
  self.goals.clear();
  self.stopping = true;
  self.abort?.abort();
  self.abort = null;
  self.assessAbort?.abort();
  self.assessAbort = null;
  const orchestrator = self.orchestrator;
  const runPromise = self.runPromise;
  const setupPromise = self.setupPromise;
  orchestrator?.stop();
  self.orchestrator = null;
  self.runPromise = null;
  void (async () => {
    await setupPromise?.catch(() => undefined);
    await runPromise?.catch(() => undefined);
    if (self.graph && self.releaseRunLease) {
      moveGoalRun(self, self.graph, 'stopped');
      await self.persistence.save(self.graph).catch((err) => {
        self.logger.warn(`[Goal] Failed to save during disposal: ${toErrorMessage(err)}`);
      });
    }
    await self.releaseActiveRunLease();
  })().catch((err) => self.logger.warn(`[Goal] Disposal cleanup failed: ${toErrorMessage(err)}`));
  self.stopBroadcast();
  for (const client of self.clients) client.cleanup();
  self.clients.clear();
  self.usedNicknames.clear();
  self.worktrees = null;
}
