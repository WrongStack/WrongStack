const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Arm a cancellable handshake deadline without exceeding a native timer's range. */
export function scheduleHandshakeTimeout(timeoutMs: number, onTimeout: () => void): () => void {
  let remaining = Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : 0;
  let timer: ReturnType<typeof setTimeout>;
  const schedule = (): void => {
    const chunk = Math.min(remaining, MAX_TIMER_DELAY_MS);
    remaining -= chunk;
    timer = setTimeout(() => {
      if (remaining > 0) schedule();
      else onTimeout();
    }, chunk);
  };
  schedule();
  return () => clearTimeout(timer);
}
