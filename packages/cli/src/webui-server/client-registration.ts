import { mailboxSessionTag } from '@wrongstack/core/coordination';
import type { HqClientCapability } from '@wrongstack/core/hq';
import { createWebuiClientPresence } from '@wrongstack/webui-server';
import { createHqCommandDispatcher, type HqCommandController } from '../hq-command-controller.js';
import { startCliHqConnection } from '../hq-publisher.js';

export interface WebuiHqControlHooks {
  interruptLeader: (sessionId?: string) => boolean;
  allowRunCommand: () => boolean;
  /** Does this host currently own the named session (an open tab)? */
  ownsSession?: ((sessionId: string) => boolean) | undefined;
  spawnAgent?: HqCommandController['spawnAgent'];
  killFleet?: HqCommandController['killFleet'];
  terminateAgent?: HqCommandController['terminateAgent'];
}

export interface WebuiClientRegistrationDeps {
  projectRoot: string | undefined;
  appConfig: import('@wrongstack/core/types').Config | undefined;
  events: import('@wrongstack/core/kernel').EventBus;
  hqSessionId: string;
  getSessionId: () => string;
  /** Session ids the connected browsers display — one per open tab. */
  listSessions?: (() => readonly string[]) | undefined;
  /** Sessions another publisher in this process already announces to HQ. */
  isSessionOwnedElsewhere?: ((sessionId: string) => boolean) | undefined;
  /** A tab's own session writer, so HQ streams its turns without a disk tail. */
  getSessionWriter?:
    | ((sessionId: string) => import('@wrongstack/core/types').SessionWriter | undefined)
    | undefined;
  hqControl?: WebuiHqControlHooks | undefined;
}

export interface WebuiClientRegistration {
  register(): Promise<string | null>;
  unregister(): void;
}

export function createWebuiClientRegistration(
  deps: WebuiClientRegistrationDeps,
): WebuiClientRegistration {
  const control = deps.hqControl;
  return createWebuiClientPresence({
    projectRoot: deps.projectRoot,
    appConfig: deps.appConfig,
    events: deps.events,
    hqSessionId: deps.hqSessionId,
    getSessionId: deps.getSessionId,
    ...(deps.listSessions ? { listSessions: deps.listSessions } : {}),
    ...(deps.isSessionOwnedElsewhere
      ? { isSessionOwnedElsewhere: deps.isSessionOwnedElsewhere }
      : {}),
    ...(deps.getSessionWriter ? { getSessionWriter: deps.getSessionWriter } : {}),
    startHqConnection: (options) =>
      startCliHqConnection({
        ...options,
        capabilities: options.capabilities as HqClientCapability[],
      }),
    ...(control
      ? {
          createCommandHandler: (mailbox) =>
            createHqCommandDispatcher({
              steerMailbox: mailbox,
              interruptLeader: control.interruptLeader,
              allowRunCommand: control.allowRunCommand,
              // The session HQ actually SHOWS for this client — the boot
              // session the telemetry bridge publishes under and the only one
              // `interruptLeader` speaks for. `getSessionId` follows whichever
              // browser tab is in front, which is a different session HQ has
              // no view of and cannot control.
              sessionTag: () => mailboxSessionTag(deps.hqSessionId),
              // The session HQ falls back to when a command names none — the
              // boot tab. A command that DOES name one is honoured (and
              // refused when this host no longer has it) via `ownsSession`.
              sessionId: () => deps.hqSessionId,
              ...(control.ownsSession ? { ownsSession: control.ownsSession } : {}),
              ...(control.spawnAgent ? { spawnAgent: control.spawnAgent } : {}),
              ...(control.killFleet ? { killFleet: control.killFleet } : {}),
              ...(control.terminateAgent ? { terminateAgent: control.terminateAgent } : {}),
            }),
        }
      : {}),
  });
}
