/**
 * The HQ command handler for a WebUI host — one browser tab per conversation, all served by
 * one process. Shared by the CLI-hosted WebUI (`cli/src/webui-server/client-registration.ts`)
 * and the standalone engine behind WebUI/desktop, so HQ steers, interrupts, approves and
 * spawns for either host under the same rules.
 */
import { mailboxSessionTag, type RemoteMailbox } from '@wrongstack/coordination';
import type { ApprovalRegistry } from '@wrongstack/hq';
import {
  createHqCommandDispatcher,
  createProjectKanbanAssignHandler,
  createProjectKanbanTransitionHandler,
  type HqCommandController,
} from './command-controller.js';

/** What a WebUI host lets HQ do to its conversations. */
export interface WebuiHqControlHooks {
  interruptLeader: (sessionId?: string) => boolean;
  allowRunCommand: () => boolean;
  /** Does this host currently own the named session (an open tab)? */
  ownsSession?: ((sessionId: string) => boolean) | undefined;
  spawnAgent?: HqCommandController['spawnAgent'];
  killFleet?: HqCommandController['killFleet'];
  terminateAgent?: HqCommandController['terminateAgent'];
}

/**
 * Builds the `createCommandHandler` a `createWebuiClientPresence` takes: the presence hands in
 * its project mailbox and the approval registry its telemetry bridge publishes from.
 */
export function createWebuiHqCommandHandler(input: {
  control: WebuiHqControlHooks;
  projectRoot: string | undefined;
  /** The boot session: the one HQ falls back to when a command names none. */
  hqSessionId: string;
}): (
  mailbox: RemoteMailbox,
  approvals: ApprovalRegistry,
) => ReturnType<typeof createHqCommandDispatcher> {
  const { control, projectRoot, hqSessionId } = input;
  return (mailbox, approvals) =>
    createHqCommandDispatcher({
      steerMailbox: mailbox,
      interruptLeader: control.interruptLeader,
      allowRunCommand: control.allowRunCommand,
      // Same registry the approval bridge publishes from, so every
      // prompt HQ shows is one this handler can actually answer.
      resolveApproval: (toolUseId, decision, sessionId) =>
        approvals.resolve(toolUseId, decision, sessionId),
      // Same registry again: it publishes `user_input.requested`, so
      // it has to be the one that answers `answer-input`.
      resolveUserInput: (requestId, response, sessionId) =>
        approvals.resolveUserInput?.(requestId, response, sessionId) ?? false,
      ...(projectRoot
        ? {
            kanbanTransition: createProjectKanbanTransitionHandler(projectRoot),
            kanbanAssign: createProjectKanbanAssignHandler(projectRoot),
          }
        : {}),
      // The session HQ actually SHOWS for this client — the boot
      // session the telemetry bridge publishes under and the only one
      // `interruptLeader` speaks for. `getSessionId` follows whichever
      // browser tab is in front, which is a different session HQ has
      // no view of and cannot control.
      sessionTag: () => mailboxSessionTag(hqSessionId),
      // The session HQ falls back to when a command names none — the
      // boot tab. A command that DOES name one is honoured (and
      // refused when this host no longer has it) via `ownsSession`.
      sessionId: () => hqSessionId,
      ...(control.ownsSession ? { ownsSession: control.ownsSession } : {}),
      ...(control.spawnAgent ? { spawnAgent: control.spawnAgent } : {}),
      ...(control.killFleet ? { killFleet: control.killFleet } : {}),
      ...(control.terminateAgent ? { terminateAgent: control.terminateAgent } : {}),
    });
}
