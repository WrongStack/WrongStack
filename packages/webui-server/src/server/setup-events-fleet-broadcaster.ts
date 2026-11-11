import * as path from 'node:path';
import type { Context } from '@wrongstack/core/agent';
import type { WstackPaths } from '@wrongstack/core/utils';
import type { WebSocket } from 'ws';
import type { ConnectedClient, WSServerMessage } from './types.js';

interface SetupEventsFleetBroadcasterDeps {
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

/**
 * How often a registry snapshot that only moved its heartbeats is re-sent. Every session
 * heartbeats every five seconds and each heartbeat fires the registry subscription, so a
 * project with a few live sessions broadcast its whole snapshot (tens of kilobytes with the
 * agents' recent mail and tools) every one to two seconds, and the desktop host journals
 * every frame: that was the largest share of a conversation's on-disk journal. Ten seconds
 * keeps a client's newest heartbeat under the office's twenty-second "verified" window.
 */
export const HEARTBEAT_ONLY_REBROADCAST_MS = 10_000;

/** A snapshot's content without the heartbeat times that change on every beat. */
function snapshotKey(sessions: readonly Record<string, unknown>[]): string {
  return JSON.stringify(sessions.map(({ lastHeartbeatAt: _beat, ...content }) => content));
}

/**
 * Decides which registry snapshots go out: any whose content changed, a forced one, and an
 * unchanged one (only heartbeats moved) once per {@link HEARTBEAT_ONLY_REBROADCAST_MS}.
 */
export function createSnapshotGate(windowMs = HEARTBEAT_ONLY_REBROADCAST_MS) {
  let last: { key: string; at: number } | undefined;
  return (
    sessions: readonly Record<string, unknown>[],
    { force = false, now = Date.now() }: { force?: boolean; now?: number } = {},
  ): boolean => {
    const key = snapshotKey(sessions);
    if (!force && last?.key === key && now - last.at < windowMs) return false;
    last = { key, at: now };
    return true;
  };
}

export function registerSetupEventsFleetBroadcaster(
  deps: SetupEventsFleetBroadcasterDeps,
): (() => void) | undefined {
  const { globalConfigPath, wpaths, context, clients, broadcast, onFleetBroadcaster, isDisposed } =
    deps;
  const globalRoot = globalConfigPath ? path.dirname(globalConfigPath) : undefined;
  if (!globalRoot) return undefined;

  const disposers: Array<() => void> = [];
  const shouldSend = createSnapshotGate();
  const broadcastSessions = async (options: { force?: boolean } = {}) => {
    // A poll timer or event debounce can fire after the server is disposed;
    // pushing status to torn-down clients is pointless.
    if (isDisposed()) return;
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
      if (isDisposed()) return;
      if (!shouldSend(live, { force: options.force === true })) return;
      broadcast(clients, { type: 'sessions.status_update', payload: { sessions: live } });
    } catch {
      // Best-effort — never crash for status broadcasting errors.
    }
  };

  // An explicit ping (`POST /api/fleet/ping`) asks for the snapshot now, changed or not.
  onFleetBroadcaster?.(() => broadcastSessions({ force: true }));

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
