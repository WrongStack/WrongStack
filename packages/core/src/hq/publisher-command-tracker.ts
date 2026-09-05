import type { HqPublisherCommandResult } from './publisher-types.js';

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
