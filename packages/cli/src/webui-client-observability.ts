import { type SessionAgentRegistry, startWebUILiveStatusLogger } from '@wrongstack/webui-server';
import type { WebSocket } from 'ws';
import { createWebuiClientRegistration } from './webui-server/client-registration.js';

import type { ConnectedClient } from './webui-server/connection-handler.js';

import type { CliWebUIOptions } from './webui-server-options.js';

export function createEmbeddedClientRegistration(
  opts: CliWebUIOptions,
  clients: Map<WebSocket, ConnectedClient>,
  abortControllers: Map<string, AbortController>,
  getSessionAgents: () => SessionAgentRegistry | undefined,
) {
  // HQ speaks for the LEADER — the boot session, the one it registered
  // itself under (`hqSessionId`) — not for whatever else the browser has
  // open. This used to abort every controller in the map and clear it, so a
  // remote "interrupt" issued against the leader also killed the three other
  // tabs' in-flight runs. Deleting the entries was wrong on its own terms
  // too: the run's own `end()` owns removal, and clearing early makes
  // `isRunActive` lie to every tab still running. Every open tab is its own
  // session with its own abort controller, so the command's session is the
  // one that gets stopped. Falling back to the boot session keeps a dashboard
  // that sends no session — every one before this existed — behaving exactly
  // as before.
  const interruptSession = (sessionId?: string): boolean => {
    const leaderId = sessionId ?? opts.session.id;
    const controller = abortControllers.get(leaderId);
    if (!controller) return false;
    controller.abort();
    // Stopping a run means stopping its work; this session's subagents are
    // part of it (same treatment as the `abort` seam). Session scoped, so one
    // tab's Stop never reaches another tab's fleet.
    try {
      void Promise.resolve(opts.stopSessionFleet?.(leaderId)).catch(() => undefined);
    } catch {
      // Best effort: the run is already aborted and a teardown failure must
      // not surface instead of the stop.
    }
    return true;
  };
  // The root conversation is published by the CLI host's own HQ connection
  // (see `isSessionOwnedElsewhere`), whose abort goes through the shared
  // interrupt seam. Nothing bound that seam in `--webui` mode, so HQ's Stop on
  // the root session was acknowledged as "no active leader run" and the run
  // carried on.
  if (opts.interruptController) {
    opts.interruptController.abortLeader = () =>
      interruptSession(opts.agent.ctx.session?.id ?? opts.session.id);
  }
  return createWebuiClientRegistration({
    projectRoot: opts.projectRoot,
    appConfig: opts.appConfig,
    events: opts.events,
    hqSessionId: opts.session.id,
    getSessionId: () => opts.agent.ctx.session?.id ?? opts.session.id,
    // One HQ session per open tab. The set is the same one the terminal
    // panel lists: every session a connected browser is displaying.
    listSessions: () => {
      const ids = new Set<string>();
      for (const client of clients.values()) {
        if (client.sessionId) ids.add(client.sessionId);
        for (const id of client.sessionIds ?? []) ids.add(id);
      }
      return [...ids];
    },
    // `cli-main` already runs a tracker and a bridge for the root
    // conversation; announcing it here too would put two trackers on one bus
    // flushing the same agent list. Compared against the LIVE root writer:
    // the CLI host's telemetry follows `ctx.session`, so once the root moves
    // (session.new / resume) the old boot id is an ordinary tab this client
    // must publish, and the new root id must not be published twice.
    isSessionOwnedElsewhere: (sessionId: string) =>
      sessionId === (opts.agent.ctx.session?.id ?? opts.session.id),
    // The tab's own journal, so HQ takes its turns from the write path
    // instead of tailing the file.
    getSessionWriter: (sessionId: string) => getSessionAgents()?.peek(sessionId)?.ctx.session,
    hqControl: {
      interruptLeader: interruptSession,
      ...(opts.hqFleetControl
        ? {
            killFleet: opts.hqFleetControl.killFleet,
            terminateAgent: opts.hqFleetControl.terminateAgent,
            spawnAgent: opts.hqFleetControl.spawnAgent,
          }
        : {}),
      allowRunCommand: () => opts.hqAllowExec === true,
      // A command naming a tab this process no longer holds is refused, not
      // redirected onto the boot session: the operator picked a terminal,
      // and steering a different one is worse than not steering at all.
      ownsSession: (sessionId: string) =>
        sessionId === opts.session.id || getSessionAgents()?.has(sessionId) === true,
    },
  });
}

export function startEmbeddedLiveStatusLogger(
  opts: CliWebUIOptions,
  clients: Map<WebSocket, ConnectedClient>,
  abortControllers: Map<string, AbortController>,
  getSessionAgents: () => SessionAgentRegistry | undefined,
  terminalLogView: Parameters<typeof startWebUILiveStatusLogger>[0]['dashboard'],
) {
  return startWebUILiveStatusLogger({
    events: opts.events,
    dashboard: terminalLogView,
    getSessionList: () => {
      const ids = new Set<string>();
      for (const client of clients.values()) {
        if (client.sessionId) ids.add(client.sessionId);
        for (const id of client.sessionIds ?? []) ids.add(id);
      }
      const currentId = opts.agent.ctx.session?.id ?? opts.session.id;
      if (ids.size === 0 && currentId) ids.add(currentId);
      return Array.from(ids).map((id) => {
        const ctx = getSessionAgents()?.peek(id)?.ctx;
        return {
          id,
          model: ctx?.model ?? opts.agent.ctx.model ?? '',
          provider: ctx?.provider?.id ?? opts.agent.ctx.provider?.id ?? '',
          isRunning: abortControllers.has(id),
        };
      });
    },
  });
}
