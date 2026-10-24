import type { PhaseExecutionContext } from './types.js';

type ExecuteTask = PhaseExecutionContext['executeTask'];

/** Timeouts cancel a request, but only settlement releases a worker's checkout slot. */
export class GoalTaskExecutionOwnership {
  private readonly byTask = new Map<string, Promise<void>>();
  private readonly pending = new Set<{ phaseId: string; promise: Promise<void> }>();
  private readonly slots = new Map<string, { active: number; waiting: Array<() => void> }>();

  constructor(
    private readonly executeTask: ExecuteTask,
    private readonly concurrency: number,
  ) {}

  execute: ExecuteTask = (task, phaseId, env, signal) => {
    const key = JSON.stringify([phaseId, task.id]);
    const previous = this.byTask.get(key);
    const execution = (async () => {
      await previous;
      signal?.throwIfAborted();
      const release = await this.acquireSlot(phaseId);
      try {
        signal?.throwIfAborted();
        return await this.executeTask(task, phaseId, env, signal);
      } finally {
        release();
      }
    })();
    const settled = execution.then(
      () => undefined,
      () => undefined,
    );
    const owner = { phaseId, promise: settled };
    this.byTask.set(key, settled);
    this.pending.add(owner);
    void settled.then(() => {
      this.pending.delete(owner);
      if (this.byTask.get(key) === settled) this.byTask.delete(key);
    });
    return execution;
  };

  async drain(phaseId?: string): Promise<void> {
    await Promise.all(
      [...this.pending]
        .filter((owner) => !phaseId || owner.phaseId === phaseId)
        .map((owner) => owner.promise),
    );
  }

  private async acquireSlot(phaseId: string): Promise<() => void> {
    let slots = this.slots.get(phaseId);
    if (!slots) {
      slots = { active: 0, waiting: [] };
      this.slots.set(phaseId, slots);
    }
    const ownedSlots = slots;
    if (ownedSlots.active >= this.concurrency)
      await new Promise<void>((resolve) => ownedSlots.waiting.push(resolve));
    else ownedSlots.active++;
    return () => {
      const next = ownedSlots.waiting.shift();
      if (next) next();
      else {
        ownedSlots.active--;
        if (ownedSlots.active === 0) this.slots.delete(phaseId);
      }
    };
  }
}
