import type { HqServerCommandBatchMessage } from './protocol.js';
import type { HqPublisherCommandHandler, HqPublisherCommandResult } from './publisher-types.js';

export const IN_FLIGHT_COMMAND = Symbol('hq.command.in_flight');

export class CommandTracker {
  private readonly commandResults = new Map<
    string,
    HqPublisherCommandResult | typeof IN_FLIGHT_COMMAND
  >();
  private readonly inFlightWaiters = new Map<
    string,
    { promise: Promise<void>; resolve: () => void }
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
    if (disposition === IN_FLIGHT_COMMAND) {
      if (!this.inFlightWaiters.has(commandId)) {
        let resolve!: () => void;
        const promise = new Promise<void>((r) => {
          resolve = r;
        });
        this.inFlightWaiters.set(commandId, { promise, resolve });
      }
    } else {
      const waiter = this.inFlightWaiters.get(commandId);
      if (waiter !== undefined) {
        this.inFlightWaiters.delete(commandId);
        waiter.resolve();
      }
    }
    while (this.commandResults.size > this.maxTrackedCommands) {
      let evicted = false;
      for (const [key, value] of this.commandResults) {
        if (value !== IN_FLIGHT_COMMAND) {
          this.commandResults.delete(key);
          evicted = true;
          break;
        }
      }
      if (!evicted) break;
    }
  }

  waitForInFlight(commandId?: string): Promise<void> | undefined {
    if (commandId !== undefined) {
      return this.inFlightWaiters.get(commandId)?.promise;
    }
    if (this.inFlightWaiters.size === 0) return undefined;
    const promises = [...this.inFlightWaiters.values()].map((w) => w.promise);
    return Promise.all(promises).then(() => undefined);
  }

  clear(): void {
    this.commandResults.clear();
    const waiters = [...this.inFlightWaiters.values()];
    this.inFlightWaiters.clear();
    for (const waiter of waiters) {
      waiter.resolve();
    }
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
  const settledAtArrival = new Map<string, HqPublisherCommandResult>();
  for (const command of message.commands) {
    const existing = tracker.get(command.commandId);
    if (existing !== undefined && existing !== IN_FLIGHT_COMMAND) {
      settledAtArrival.set(command.commandId, existing);
    }
  }

  for (const command of message.commands) {
    // Redelivery guard. `lastCommandId` only advances AFTER a command is
    // handled (see below), while `command_poll` fires on a fixed timer — so
    // any handler slower than the poll interval is re-sent the SAME command
    // and, without this, runs it twice. `spawn` and `abort` routinely take
    // seconds; a duplicate there means a second subagent or a second kill.
    const preSettled = settledAtArrival.get(command.commandId);
    if (preSettled !== undefined) {
      // Already finished before this batch arrived: replay the SAME ack so the
      // server's audit row converges on the real outcome, after any earlier
      // in-flight command settles.
      while (tracker.waitForInFlight() !== undefined) {
        await tracker.waitForInFlight();
      }
      hooks.ack(preSettled);
      hooks.advanceCursor(command.commandId);
      continue;
    }

    const seen = tracker.get(command.commandId);
    if (seen !== undefined) {
      // Still running (or settled while this batch was waiting behind an
      // earlier invocation): the original invocation owns both the ack and
      // cursor advancement. Wait for it to finish before inspecting subsequent
      // commands in this batch so later commands cannot execute out of order or
      // advance `lastCommandId` while an earlier command is still in flight.
      if (seen === IN_FLIGHT_COMMAND) {
        await tracker.waitForInFlight(command.commandId);
      }
      continue;
    }

    while (tracker.waitForInFlight() !== undefined) {
      await tracker.waitForInFlight();
    }
    if (tracker.get(command.commandId) !== undefined) {
      if (tracker.get(command.commandId) === IN_FLIGHT_COMMAND) {
        await tracker.waitForInFlight(command.commandId);
      }
      continue;
    }

    tracker.remember(command.commandId, IN_FLIGHT_COMMAND);
    try {
      const result = await handler(command);
      const ack: HqPublisherCommandResult = result ?? {
        commandId: command.commandId,
        status: 'accepted',
      };
      if (result !== undefined) hooks.ack(result);
      else if (command.requiresAck) hooks.ack(ack);
      hooks.advanceCursor(command.commandId);
      tracker.remember(command.commandId, ack);
    } catch (err) {
      const ack: HqPublisherCommandResult = {
        commandId: command.commandId,
        status: 'failed',
        message: err instanceof Error ? err.message : String(err),
      };
      hooks.ack(ack);
      hooks.advanceCursor(command.commandId);
      tracker.remember(command.commandId, ack);
    }
  }
}
