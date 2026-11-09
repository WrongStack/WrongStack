import type { HqClientCapability } from '@wrongstack/hq';
import { createWebuiHqCommandHandler, type WebuiHqControlHooks } from '@wrongstack/runtime/hq-host';
import { createWebuiClientPresence } from '@wrongstack/webui-server';
import { startCliHqConnection } from '../hq-publisher.js';
import { CLI_VERSION } from '../version.js';

export type { WebuiHqControlHooks };

export interface WebuiClientRegistrationDeps {
  getSessionContext?: ((sessionId: string) => unknown) | undefined;
  projectRoot: string | undefined;
  appConfig: import('@wrongstack/contracts/types').Config | undefined;
  events: import('@wrongstack/contracts/kernel').EventBus;
  hqSessionId: string;
  getSessionId: () => string;
  /** Session ids the connected browsers display — one per open tab. */
  listSessions?: (() => readonly string[]) | undefined;
  /** Sessions another publisher in this process already announces to HQ. */
  isSessionOwnedElsewhere?: ((sessionId: string) => boolean) | undefined;
  /** A tab's own session writer, so HQ streams its turns without a disk tail. */
  getSessionWriter?:
    | ((sessionId: string) => import('@wrongstack/contracts/types').SessionWriter | undefined)
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
    acpSettings: !!control?.acpConfig,
    hqSessionId: deps.hqSessionId,
    getSessionId: deps.getSessionId,
    ...(deps.getSessionContext ? { getSessionContext: deps.getSessionContext } : {}),
    clientVersion: CLI_VERSION,
    ...(deps.listSessions ? { listSessions: deps.listSessions } : {}),
    ...(deps.isSessionOwnedElsewhere
      ? { isSessionOwnedElsewhere: deps.isSessionOwnedElsewhere }
      : {}),
    ...(deps.getSessionWriter ? { getSessionWriter: deps.getSessionWriter } : {}),
    startHqConnection: (options) =>
      startCliHqConnection({
        ...options,
        capabilities: options.capabilities as HqClientCapability[],
        // Embedded in the CLI host, whose own HQ connection already syncs
        // this project's Kanban boards; a second sync is a second writer.
        ownKanbanSync: false,
      }),
    // The same HQ command handler the standalone engine (desktop) installs.
    ...(control
      ? {
          createCommandHandler: createWebuiHqCommandHandler({
            control,
            projectRoot: deps.projectRoot,
            hqSessionId: deps.hqSessionId,
          }),
        }
      : {}),
  });
}
