/**
 * Diagnostic preload for the E2E WebUI boot (CI only, wired via NODE_OPTIONS
 * in global-setup.ts).
 *
 * The CI failure is a silent exit 0 a few hundred milliseconds into boot, with
 * three INFO lines of output and nothing else. `--trace-exit` printed nothing,
 * so `process.exit()` is never called: the event loop simply empties while
 * boot is still awaiting something. That means the evidence we need is "which
 * promise was still pending when the loop went idle" — which no log line can
 * give us after the fact.
 *
 * `beforeExit` fires exactly in that situation (an empty loop, not an explicit
 * exit), so this records where every promise was created and prints the stacks
 * of the ones still unresolved at that moment.
 */
const asyncHooks = require('node:async_hooks');

const pending = new Map();
const hook = asyncHooks.createHook({
  init(id, type) {
    if (type !== 'PROMISE') return;
    const holder = {};
    Error.captureStackTrace(holder, undefined);
    pending.set(id, holder.stack);
  },
  promiseResolve(id) {
    pending.delete(id);
  },
  destroy(id) {
    pending.delete(id);
  },
});
hook.enable();

let reported = false;
const report = (label, code) => {
  if (reported) return;
  reported = true;
  hook.disable();
  const write = (line) => process.stderr.write(`[boot-probe] ${line}\n`);
  write(`${label} code=${code}`);
  write(`active resources: ${JSON.stringify(process.getActiveResourcesInfo())}`);
  // Only frames from this repo's own code can point at a call site; node
  // internals and the async-hook itself are noise.
  const repoFrames = (stack) =>
    String(stack)
      .split('\n')
      .filter(
        (line) => /WrongStack|wrongstack/.test(line) && !line.includes('boot-hang-probe'),
      );
  const own = [...pending.values()].filter((stack) => repoFrames(stack).length > 0);
  write(`${pending.size} unresolved promises, ${own.length} with repo frames`);
  for (const stack of own.slice(-15)) {
    write(`pending:\n${repoFrames(stack).slice(0, 4).join('\n')}`);
  }
};

process.on('beforeExit', (code) => report('beforeExit (event loop went idle)', code));
process.on('exit', (code) => report('exit', code));
