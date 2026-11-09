/** Serialize full snapshots and merge changes arriving during a read into one fresh read. */
export function fileRefreshQueue(read: () => Promise<void>) {
  type Waiter = { resolve: () => void; reject: (reason: unknown) => void };
  let pending: Waiter[] = [];
  let running = false;

  async function drain() {
    running = true;
    while (pending.length) {
      const batch = pending;
      pending = [];
      try {
        await read();
        for (const waiter of batch) waiter.resolve();
      } catch (error) {
        for (const waiter of batch) waiter.reject(error);
      }
    }
    running = false;
  }

  return Object.assign(
    () =>
      new Promise<void>((resolve, reject) => {
        pending.push({ resolve, reject });
        if (!running) void drain();
      }),
    {
      // A closed view needs no trailing read. StrictMode may use the queue again on remount.
      clear() {
        const batch = pending;
        pending = [];
        for (const waiter of batch) waiter.resolve();
      },
    },
  );
}
