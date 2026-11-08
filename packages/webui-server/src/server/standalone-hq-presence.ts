import type { EventBus } from '@wrongstack/contracts/kernel';
import type { Config, SessionWriter } from '@wrongstack/contracts/types';
import type { Director } from '@wrongstack/coordination';
import type { HqClientCapability, HqPublisher, HqSocketLike } from '@wrongstack/hq';
import {
  createHqFleetControl,
  createWebuiHqCommandHandler,
  startHqHostConnection,
} from '@wrongstack/runtime/hq-host';
import type { WebSocket as WsSocket } from 'ws';
import { WebSocket } from '../ws-runtime.js';
import { createWebuiClientPresence, type WebuiClientPresence } from './client-presence.js';
import type { ConnectedClient } from './types.js';

export interface StandaloneHqPresenceInput {
  projectRoot: string;
  /** The live config: an HQ turned on, off or re-pointed in Settings applies to the connection. */
  getConfig: () => Config;
  events: EventBus;
  /** The boot session: HQ's fallback when a command names no session. */
  bootSessionId: string;
  /** The session in front, the mailbox client's session stamp. */
  getSessionId: () => string;
  clients: Map<WsSocket, ConnectedClient>;
  /** Is a run of this session in flight? */
  isRunning: (sessionId: string) => boolean;
  /** Stop a session's run and its workers — the composer's Stop. */
  abortRun: (sessionId: string) => void;
  /** Does this engine hold the session (an open conversation)? */
  ownsSession: (sessionId: string) => boolean;
  getSessionWriter: (sessionId: string) => SessionWriter | undefined;
  /** The engine's fleet director; absent when `delegate` is disabled. */
  getDirector?: (() => Director | undefined) | undefined;
  /** Receives the connection's publisher for the engine-wide bridges (session identity). */
  onPublisher?: ((publisher: HqPublisher | undefined) => void) | undefined;
}

export interface StandaloneHqPresence {
  /** Re-register under another project root (the engine's project switched). */
  switchProject(projectRoot: string): void;
  dispose(): void;
}

/** Every session an attached window displays — one per open conversation. */
function displayedSessions(clients: Map<WsSocket, ConnectedClient>): string[] {
  const ids = new Set<string>();
  for (const client of clients.values()) {
    if (client.sessionId) ids.add(client.sessionId);
    for (const id of client.sessionIds ?? []) ids.add(id);
  }
  return [...ids];
}

/**
 * HQ control and presence for the standalone engine behind WebUI/desktop (CLI parity:
 * `cli/src/webui-client-observability.ts` → `createWebuiClientRegistration`).
 *
 * The engine registers as a mailbox client (it shows in HQ's client and presence lists),
 * publishes one session stream per open conversation instead of only the boot one, mirrors
 * permission prompts and user-input requests to HQ, and takes HQ's commands: steer, interrupt,
 * approve/answer, and — with the fleet — spawn, stop a session's fleet, terminate one agent.
 * `run-command` stays refused (`allowRunCommand` is false; the engine has no
 * `--hq-allow-exec`). It owns the project's Kanban and SAGE HQ sync, as the CLI's own
 * connection does: it is this process's only HQ connection.
 *
 * Exposure is unchanged: the HQ connection follows the same config resolution as before
 * (`hq` config, `WRONGSTACK_HQ_*`, discovery); with HQ unconfigured or disabled no publisher
 * is created and no command can arrive. The mailbox registration is the local project daemon.
 */
export function startStandaloneHqPresence(input: StandaloneHqPresenceInput): StandaloneHqPresence {
  const fleet = input.getDirector
    ? createHqFleetControl(
        () => input.getDirector?.() ?? null,
        () => input.bootSessionId,
        { multiConversation: true },
      )
    : undefined;
  const control = {
    // Each open conversation has its own run: the command's session is the one stopped,
    // never every tab (the CLI's `interruptSession`).
    interruptLeader: (sessionId?: string): boolean => {
      const id = sessionId ?? input.bootSessionId;
      if (!input.isRunning(id)) return false;
      input.abortRun(id);
      return true;
    },
    allowRunCommand: () => false,
    // A command naming a conversation this engine no longer holds is refused, not redirected.
    ownsSession: (sessionId: string) =>
      sessionId === input.bootSessionId || input.ownsSession(sessionId),
    ...(fleet
      ? {
          spawnAgent: fleet.spawnAgent,
          killFleet: fleet.killFleet,
          terminateAgent: fleet.terminateAgent,
        }
      : {}),
  };

  const create = (projectRoot: string): WebuiClientPresence =>
    createWebuiClientPresence({
      projectRoot,
      appConfig: input.getConfig(),
      events: input.events,
      hqSessionId: input.bootSessionId,
      getSessionId: input.getSessionId,
      listSessions: () => displayedSessions(input.clients),
      getSessionWriter: input.getSessionWriter,
      startHqConnection: (options) =>
        startHqHostConnection({
          ...options,
          capabilities: options.capabilities as HqClientCapability[],
          getAppConfig: () => input.getConfig(),
          socketFactory: (url) => new WebSocket(url) as unknown as HqSocketLike,
        }),
      createCommandHandler: createWebuiHqCommandHandler({
        control,
        projectRoot,
        hqSessionId: input.bootSessionId,
      }),
      ...(input.onPublisher ? { onPublisher: input.onPublisher } : {}),
    });

  let presence = create(input.projectRoot);
  let disposed = false;
  void presence.register();
  return {
    switchProject: (projectRoot) => {
      if (disposed) return;
      presence.unregister();
      presence = create(projectRoot);
      void presence.register();
    },
    dispose: () => {
      disposed = true;
      presence.unregister();
    },
  };
}
