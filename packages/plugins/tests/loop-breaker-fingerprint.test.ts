/**
 * @wrongstack/plugins — loop-breaker fingerprint robustness.
 *
 * loop-breaker decides "the agent is repeating itself" by comparing
 * fingerprints of consecutive tool calls. That fingerprint is a key-sorted
 * deep copy, and the copy used to recurse without a depth cap or a cycle
 * guard: a circular or very deep tool input blew the stack, the caller
 * caught the `RangeError`, and fell back to `String(value)` — which is
 * `"[object Object]"` for every such input.
 *
 * The consequence was not a crash but a *false positive*: two completely
 * different awkward inputs fingerprinted identically, so loop-breaker
 * reported a repeat loop that was not happening and interrupted the agent.
 */
import { describe, expect, it } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const plugin = (await import('../src/loop-breaker/index.js')).default;

interface HookOutcome {
  decision?: string;
  reason?: string;
  additionalContext?: string;
}

function makeApi(extensions: Record<string, unknown> = {}) {
  const hooks: Array<{ event: string; hook: (i: Any) => Any }> = [];
  const tools: Array<{ name: string; execute(i: unknown): Promise<Any> }> = [];
  return {
    tools: { register: (t: Any) => tools.push(t), list: () => tools },
    slashCommands: { register() {} },
    config: { extensions },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    metrics: { counter() {}, histogram() {}, gauge() {} },
    session: { append: async () => {} },
    extensions: { register: () => ({ unregister() {} }) },
    registerSystemPromptContributor: () => () => {},
    registerHook: (event: string, _m: unknown, hook: Any) => {
      hooks.push({ event, hook });
      return () => {};
    },
    onEvent: () => () => {},
    onPattern: () => () => {},
    emitCustom() {},
    onConfigChange: () => () => {},
    _hooks: hooks,
    _tools: tools,
  };
}

function preHook(api: Any) {
  const h = (api._hooks as Array<{ event: string; hook: (i: Any) => Any }>).find(
    (x) => x.event === 'PreToolUse',
  );
  if (!h) throw new Error('PreToolUse hook not registered');
  return h.hook;
}

/** Feed a sequence of tool inputs; return the last outcome. */
async function feed(inputs: unknown[], extensions: Record<string, unknown> = {}) {
  const api = makeApi({ 'loop-breaker': { enabled: true, ...extensions } });
  plugin.setup(api as Any);
  const hook = preHook(api);
  let last: HookOutcome | undefined;
  for (const toolInput of inputs) {
    last = await hook({ event: 'PreToolUse', toolName: 'read', toolInput, cwd: '/tmp' });
  }
  plugin.teardown?.(api as Any);
  return last;
}

/** A self-referencing object carrying a distinguishing marker. */
function cyclic(marker: string): Record<string, unknown> {
  const o: Record<string, unknown> = { marker };
  o['self'] = o;
  return o;
}

/** A linked chain `depth` levels deep, ending in a distinguishing marker. */
function deep(depth: number, marker: string): Record<string, unknown> {
  let node: Record<string, unknown> = { marker };
  for (let i = 0; i < depth; i++) node = { next: node };
  return node;
}

describe('fingerprinting awkward tool inputs', () => {
  it('does not throw on a circular tool input', async () => {
    await expect(feed([cyclic('a')])).resolves.not.toThrow();
  });

  it('does not throw on a very deep tool input', async () => {
    await expect(feed([deep(5_000, 'a')])).resolves.not.toThrow();
  });

  it('keeps two DIFFERENT circular inputs distinguishable', async () => {
    // Both used to collapse to "[object Object]" and look like a repeat.
    const out = await feed([cyclic('alpha'), cyclic('beta'), cyclic('gamma'), cyclic('delta')], {
      repeatThreshold: 2,
    });
    expect(out?.decision).not.toBe('block');
  });

  it('keeps two DIFFERENT deep inputs distinguishable', async () => {
    const out = await feed(
      [deep(50, 'alpha'), deep(50, 'beta'), deep(50, 'gamma'), deep(50, 'delta')],
      { repeatThreshold: 2 },
    );
    expect(out?.decision).not.toBe('block');
  });

  it('still detects a genuine repeat of the same circular input', async () => {
    // The guard must not become a blanket "never match" either.
    const shared = cyclic('same');
    const out = await feed([shared, shared, shared, shared, shared], { repeatThreshold: 2 });
    expect(out).toBeDefined();
  });

  it('treats key order as irrelevant, as before', async () => {
    const out = await feed(
      [
        { a: 1, b: 2, c: 3 },
        { c: 3, b: 2, a: 1 },
        { b: 2, a: 1, c: 3 },
        { a: 1, c: 3, b: 2 },
      ],
      { repeatThreshold: 2 },
    );
    // Same logical input written four ways — this IS a repeat.
    expect(out).toBeDefined();
  });

  it('does not treat a repeated sibling reference as a cycle', async () => {
    // `shared` appears twice but the graph is acyclic; collapsing the
    // second occurrence to a marker would blur genuinely distinct inputs.
    const shared = { v: 1 };
    const out = await feed(
      [
        { left: shared, right: shared, tag: 'one' },
        { left: shared, right: shared, tag: 'two' },
        { left: shared, right: shared, tag: 'three' },
        { left: shared, right: shared, tag: 'four' },
      ],
      { repeatThreshold: 2 },
    );
    expect(out?.decision).not.toBe('block');
  });
});
