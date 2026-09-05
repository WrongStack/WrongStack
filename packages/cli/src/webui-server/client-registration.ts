import { mailboxSessionTag } from '@wrongstack/core/coordination';
import type { HqClientCapability } from '@wrongstack/core/hq';
import { createWebuiClientPresence } from '@wrongstack/webui-server';
import { createHqCommandDispatcher, type HqCommandController } from '../hq-command-controller.js';
import { startCliHqConnection } from '../hq-publisher.js';

export interface WebuiHqControlHooks {
  interruptLeader: () => boolean;
  allowRunCommand: () => boolean;
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
              sessionId: () => deps.hqSessionId,
              ...(control.spawnAgent ? { spawnAgent: control.spawnAgent } : {}),
              ...(control.killFleet ? { killFleet: control.killFleet } : {}),
              ...(control.terminateAgent ? { terminateAgent: control.terminateAgent } : {}),
            }),
        }
      : {}),
  });
}
