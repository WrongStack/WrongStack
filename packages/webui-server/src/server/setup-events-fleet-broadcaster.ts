import * as path from 'node:path';
import type { Context } from '@wrongstack/core/agent';
import type { WstackPaths } from '@wrongstack/core/utils';
import type { WebSocket } from 'ws';
import type { ConnectedClient, WSServerMessage } from './types.js';

export interface SetupEventsFleetBroadcasterDeps {
  globalConfigPath?: string | undefined;
  wpaths?: WstackPaths | undefined;
  context: Context;
  clients: Map<WebSocket, ConnectedClient>;
  broadcast: (
    clients: Map<WebSocket, ConnectedClient>,
    msg: WSServerMessage,
    /** Deliver to the tab that owns this session, overriding the id on the
     *  payload. Needed when the payload names a SUBAGENT's session, which no
     *  tab subscribes to. */
    targetSessionId?: string,
  ) => void;
  onFleetBroadcaster?: ((fn: () => Promise<void>) => void) | undefined;
  isDisposed: () => boolean;
}

export function registerSetupEventsFleetBroadcaster(
  deps: SetupEventsFleetBroadcasterDeps,
): (() => void) | undefined {
  const { globalConfigPath, wpaths, context, clients, broadcast, onFleetBroadcaster, isDisposed } =
    deps;
  const globalRoot = globalConfigPath ? path.dirname(globalConfigPath) : undefined;
  if (!globalRoot) return undefined;

  const disposers: Array<() => void> = [];
  const broadcastSessions = async () => {
    try {
      const { getSessionRegistry } = await import('@wrongstack/core/storage');
      const registry = getSessionRegistry(globalRoot);
      const sessions = await registry.list();
      const ownEntry = sessions.find((s) => s.pid === process.pid);
      const mySlug = ownEntry?.projectSlug ?? wpaths?.projectSlug;
      const myRoot = path.resolve(context.projectRoot);
      const live = sessions
        .filter((s) => s.status === 'active' || s.status === 'idle')
        .filter((s) => (mySlug ? s.projectSlug === mySlug : path.resolve(s.projectRoot) === myRoot))
        .map((s) => ({
          sessionId: s.sessionId,
          projectName: s.projectName,
          projectSlug: s.projectSlug,
          projectRoot: s.projectRoot,
          workingDir: s.workingDir,
          gitBranch: s.gitBranch,
          clientType: s.clientType,
          status: s.status,
          pid: s.pid,
          startedAt: s.startedAt,
          lastHeartbeatAt: s.lastHeartbeatAt,
          agentCount: s.agentCount,
          agents: (s.agents ?? []).map((a) => ({
            id: a.id,
            name: a.name,
            status: a.status,
            currentTool: a.currentTool,
            currentTask: a.currentTask,
            taskId: a.taskId,
            iterations: a.iterations,
            toolCalls: a.toolCalls,
            costUsd: a.costUsd,
            tokensIn: a.tokensIn,
            tokensOut: a.tokensOut,
            ctxPct: a.ctxPct,
            model: a.model,
            partialText: a.partialText,
            recentTools: a.recentTools,
            recentMail: a.recentMail,
            todos: a.todos,
            latestPrompt: a.latestPrompt,
            latestPromptAt: a.latestPromptAt,
            activity: a.activity,
            lastActivityAt: a.lastActivityAt,
          })),
        }));
      broadcast(clients, { type: 'sessions.status_update', payload: { sessions: live } });
    } catch {
      // Best-effort — never crash for status broadcasting errors.
    }
  };

  onFleetBroadcaster?.(broadcastSessions);

  let subscriptionLive = false;
  let statusTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleStatusPoll = (): void => {
    if (isDisposed()) return;
    statusTimer = setTimeout(
      () => {
        void broadcastSessions();
        scheduleStatusPoll();
      },
      subscriptionLive ? 30_000 : 5_000,
    );
    if (statusTimer.unref) statusTimer.unref();
  };
  disposers.push(() => {
    if (statusTimer) clearTimeout(statusTimer);
  });

  let eventDebounce: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => Promise<void>) | undefined;
  let disposed = false;

  void import('@wrongstack/core/storage')
    .then(async ({ getSessionRegistry }) => {
      if (disposed || isDisposed()) return;
      const registry = getSessionRegistry(globalRoot);
      const projectSlug = wpaths?.projectSlug;
      if (!projectSlug || disposed || isDisposed()) return;
      const unsub = await registry.subscribeProject(projectSlug, context.projectRoot, () => {
        if (eventDebounce) clearTimeout(eventDebounce);
        eventDebounce = setTimeout(() => void broadcastSessions(), 25);
      });
      if (disposed || isDisposed()) {
        void unsub();
        return;
      }
      unsubscribe = unsub;
      subscriptionLive = true;
    })
    .catch(() => {
      subscriptionLive = false;
    });

  disposers.push(() => {
    disposed = true;
    if (eventDebounce) clearTimeout(eventDebounce);
    void unsubscribe?.();
    unsubscribe = undefined;
  });
  scheduleStatusPoll();
  void broadcastSessions();

  return () => {
    for (const dispose of disposers) {
      dispose();
    }
  };
}
