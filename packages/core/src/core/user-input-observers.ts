/** Passive `user.input_requested` subscribers that cannot answer without an external connection. */
let observerCount = 0;

export function markUserInputObserver(): () => void {
  observerCount += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    observerCount = Math.max(0, observerCount - 1);
  };
}

export function userInputObserverCount(): number {
  return observerCount;
}
