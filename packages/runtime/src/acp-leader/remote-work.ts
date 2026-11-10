/**
 * Remote work a host must let finish before it exits: a WrongForge task's
 * cancellation is an HTTP call, and a shutdown that does not wait for it leaves
 * the task running on WrongForge. The CLI's signal shutdown and the standalone
 * engine's dispose both drain it, bounded.
 *
 * Kept on `globalThis` like the leader host binding (acp-leader-host.ts): the
 * runtime's entries are bundled separately, and the task that registers work
 * and the host that drains it must see one set.
 */

const STATE_KEY = Symbol.for('wrongstack.leader.remote-work');

function pending(): Set<Promise<void>> {
  const holder = globalThis as typeof globalThis & { [STATE_KEY]?: Set<Promise<void>> };
  holder[STATE_KEY] ??= new Set();
  return holder[STATE_KEY];
}

/** Keep shutdown from cutting off an owned remote task; call the result when it is done. */
export function deferShutdownForRemoteWork(): () => void {
  let release!: () => void;
  const work = new Promise<void>((resolve) => {
    release = resolve;
  });
  pending().add(work);
  return () => {
    pending().delete(work);
    release();
  };
}

/** Wait for registered remote work, at most `timeoutMs`. */
export async function drainRemoteWork(timeoutMs = 2500): Promise<void> {
  const all = pending();
  if (all.size === 0) return;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    // Remote cancellation has a 2s HTTP deadline; a broken caller must still
    // not hold the process forever.
    await Promise.race([
      Promise.all([...all]),
      new Promise<void>((resolve) => {
        deadline = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(deadline);
  }
}
