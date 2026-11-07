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
      const release = await this.acquireSlot(phaseId, signal);
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
    for (;;) {
      const current = [...this.pending].filter((owner) => !phaseId || owner.phaseId === phaseId);
      if (current.length === 0) return;
      await Promise.all(current.map((owner) => owner.promise));
    }
  }

  private async acquireSlot(phaseId: string, signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    let slots = this.slots.get(phaseId);
    if (!slots) {
      slots = { active: 0, waiting: [] };
      this.slots.set(phaseId, slots);
    }
    const ownedSlots = slots;
    const limit =
      Number.isFinite(this.concurrency) && this.concurrency >= 1 ? Math.floor(this.concurrency) : 1;
    if (ownedSlots.active >= limit) {
      await new Promise<void>((resolve, reject) => {
        const waiter = () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        };
        const onAbort = () => {
          const idx = ownedSlots.waiting.indexOf(waiter);
          if (idx !== -1) ownedSlots.waiting.splice(idx, 1);
          if (ownedSlots.active === 0 && ownedSlots.waiting.length === 0) {
            this.slots.delete(phaseId);
          }
          reject(signal?.reason ?? new DOMException('The operation was aborted', 'AbortError'));
        };
        ownedSlots.waiting.push(waiter);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    } else {
      ownedSlots.active++;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = ownedSlots.waiting.shift();
      if (next) next();
      else {
        ownedSlots.active--;
        if (ownedSlots.active === 0) this.slots.delete(phaseId);
      }
    };
  }
}
