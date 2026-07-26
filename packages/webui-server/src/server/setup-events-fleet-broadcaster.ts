import { watch as fsWatch } from 'node:fs';
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
  broadcast: (clients: Map<WebSocket, ConnectedClient>, msg: WSServerMessage) => void;
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
      const { SessionRegistry } = await import('@wrongstack/core/storage');
      const registry = new SessionRegistry(globalRoot);
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

  let regWatchLive = false;
  let statusTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleStatusPoll = (): void => {
    if (isDisposed()) return;
    statusTimer = setTimeout(
      () => {
        void broadcastSessions();
        scheduleStatusPoll();
      },
      regWatchLive ? 30_000 : 5_000,
    );
    if (statusTimer.unref) statusTimer.unref();
  };
  disposers.push(() => {
    if (statusTimer) clearTimeout(statusTimer);
  });

  let regDebounce: ReturnType<typeof setTimeout> | undefined;
  try {
    const regWatcher = fsWatch(globalRoot, { persistent: false }, (_event, filename) => {
      const name = filename ? String(filename) : '';
      if (!name.startsWith('session-registry.json') || name.endsWith('.lock')) return;
      if (regDebounce) clearTimeout(regDebounce);
      regDebounce = setTimeout(() => void broadcastSessions(), 150);
    });
    regWatcher.on('error', () => {
      regWatchLive = false;
      try {
        regWatcher.close();
      } catch {
        /* already closed */
      }
    });
    regWatchLive = true;
    disposers.push(() => {
      if (regDebounce) clearTimeout(regDebounce);
      regWatcher.close();
    });
  } catch {
    // Watch unsupported on this platform — the 5s poll still covers it.
  }
  scheduleStatusPoll();
  void broadcastSessions();

  return () => {
    for (const dispose of disposers) {
      dispose();
    }
  };
}
