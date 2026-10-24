import type { HqServerCommandBatchMessage } from './protocol.js';
import type { HqPublisherCommandHandler, HqPublisherCommandResult } from './publisher-types.js';

export const IN_FLIGHT_COMMAND = Symbol('hq.command.in_flight');

export class CommandTracker {
  private readonly commandResults = new Map<
    string,
    HqPublisherCommandResult | typeof IN_FLIGHT_COMMAND
  >();

  constructor(private readonly maxTrackedCommands = 500) {}

  get(commandId: string): HqPublisherCommandResult | typeof IN_FLIGHT_COMMAND | undefined {
    return this.commandResults.get(commandId);
  }

  remember(
    commandId: string,
    disposition: HqPublisherCommandResult | typeof IN_FLIGHT_COMMAND,
  ): void {
    this.commandResults.delete(commandId);
    this.commandResults.set(commandId, disposition);
    while (this.commandResults.size > this.maxTrackedCommands) {
      const oldest = this.commandResults.keys().next();
      if (oldest.done === true) break;
      this.commandResults.delete(oldest.value);
    }
  }

  clear(): void {
    this.commandResults.clear();
  }
}

/**
 * Run one server command batch through `handler`, deduplicating redeliveries
 * via `tracker` and advancing the poll cursor only after each command is
 * handled and acked.
 */
export async function runCommandBatch(
  message: HqServerCommandBatchMessage,
  handler: HqPublisherCommandHandler,
  tracker: CommandTracker,
  hooks: {
    ack: (result: HqPublisherCommandResult) => void;
    advanceCursor: (commandId: string) => void;
  },
): Promise<void> {
  for (const command of message.commands) {
    // Redelivery guard. `lastCommandId` only advances AFTER a command is
    // handled (see below), while `command_poll` fires on a fixed timer — so
    // any handler slower than the poll interval is re-sent the SAME command
    // and, without this, runs it twice. `spawn` and `abort` routinely take
    // seconds; a duplicate there means a second subagent or a second kill.
    const seen = tracker.get(command.commandId);
    if (seen !== undefined) {
      // Still running: the original invocation owns the ack. Already
      // finished: replay the SAME ack so the server's audit row converges
      // on the real outcome instead of being overwritten by a placeholder.
      if (seen !== IN_FLIGHT_COMMAND) hooks.ack(seen);
      hooks.advanceCursor(command.commandId);
      continue;
    }
    tracker.remember(command.commandId, IN_FLIGHT_COMMAND);
    try {
      const result = await handler(command);
      const ack: HqPublisherCommandResult = result ?? {
        commandId: command.commandId,
        status: 'accepted',
      };
      tracker.remember(command.commandId, ack);
      if (result !== undefined) hooks.ack(result);
      else if (command.requiresAck) hooks.ack(ack);
    } catch (err) {
      const ack: HqPublisherCommandResult = {
        commandId: command.commandId,
        status: 'failed',
        message: err instanceof Error ? err.message : String(err),
      };
      tracker.remember(command.commandId, ack);
      hooks.ack(ack);
    }
    // Advance the poll cursor only AFTER the command is handled and acked.
    // Advancing it before `await handler` meant a socket flap mid-handler
    // left the next command_poll asking for commands AFTER this one — so an
    // operator command (steer/abort/broadcast) that never ran was silently
    // skipped and never re-fetched. At-least-once (a possible duplicate on
    // reconnect, which these commands tolerate) beats losing one outright.
    hooks.advanceCursor(command.commandId);
  }
}
