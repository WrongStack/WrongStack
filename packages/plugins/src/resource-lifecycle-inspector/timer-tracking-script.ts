/** Bun currently omits global timers from getActiveResourcesInfo(). */
export const timerTrackingScript = `
const timers = new Map();
const rawTimeout = globalThis.setTimeout.bind(globalThis);
const rawInterval = globalThis.setInterval.bind(globalThis);
const rawClearTimeout = globalThis.clearTimeout.bind(globalThis);
const rawClearInterval = globalThis.clearInterval.bind(globalThis);
function forget(handle) {
  if (handle == null) return;
  for (const timer of timers.keys()) if (timer === handle || Number(timer) === Number(handle)) timers.delete(timer);
}
function arm(set, repeat, callback, delay, args) {
  let handle;
  handle = set(function (...values) {
    if (!repeat) timers.delete(handle);
    return Reflect.apply(callback, this, values);
  }, delay, ...args);
  timers.set(handle, true);
  return handle;
}
if (process.versions.bun) {
  globalThis.setTimeout = (callback, delay, ...args) => arm(rawTimeout, false, callback, delay, args);
  globalThis.setInterval = (callback, delay, ...args) => arm(rawInterval, true, callback, delay, args);
  globalThis.clearTimeout = (handle) => { forget(handle); return rawClearTimeout(handle); };
  globalThis.clearInterval = (handle) => { forget(handle); return rawClearInterval(handle); };
}
const trackedTimers = () => [...timers.keys()].filter(timer => typeof timer.hasRef !== 'function' || timer.hasRef()).length;
`;
