/**
 * @wrongstack/plugins — token-budget reload safety and config bounds.
 *
 * Two defects:
 *
 *  1. `setup()` assigned `null` to the hook handles instead of calling
 *     them. The previous Stop and PostToolUse registrations stayed live in
 *     the registry with nothing holding a reference, so every reload
 *     stacked another copy that fired alongside the new one.
 *  2. `readConfig` accepted any `typeof === 'number'`, so `NaN`, `Infinity`,
 *     a negative limit or `warnPercent: 500` reached the live config. `NaN`
 *     is the damaging one: every comparison against it is false, so the
 *     budget quietly stopped enforcing anything.
 */
import { describe, expect, it } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const plugin = (await import('../src/token-budget/index.js')).default;

interface RegisteredTool {
  name: string;
  execute(input: unknown): Promise<Any>;
}

function makeApi(extensions: Record<string, unknown> = {}) {
  const tools: RegisteredTool[] = [];
  const hooks: Array<{ event: string; live: boolean }> = [];
  return {
    tools: {
      register: (t: RegisteredTool) => {
        // Mirror the real registry: re-registering the same name replaces.
        const i = tools.findIndex((x) => x.name === t.name);
        if (i >= 0) tools.splice(i, 1);
        tools.push(t);
      },
      list: () => tools,
    },
    slashCommands: { register() {} },
    config: { extensions },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    metrics: { counter() {}, histogram() {}, gauge() {} },
    session: { append: async () => {} },
    extensions: { register: () => ({ unregister() {} }) },
    registerSystemPromptContributor: () => () => {},
    registerHook: (event: string) => {
      const entry = { event, live: true };
      hooks.push(entry);
      return () => {
        entry.live = false;
      };
    },
    onEvent: () => () => {},
    onPattern: () => () => {},
    emitCustom() {},
    onConfigChange: () => () => {},
    _tools: tools,
    _hooks: hooks,
  };
}

function liveHookCount(api: Any): number {
  return (api._hooks as Array<{ live: boolean }>).filter((h) => h.live).length;
}

function tool(api: Any, name: string): RegisteredTool {
  const t = (api._tools as RegisteredTool[]).find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not registered`);
  return t;
}

describe('reload does not stack hooks', () => {
  it('leaves the same number of live hooks after repeated setup()', async () => {
    const api = makeApi({ 'token-budget': { limit: 1000 } });
    plugin.setup(api as Any);
    const afterFirst = liveHookCount(api);
    expect(afterFirst).toBeGreaterThan(0);

    for (let i = 0; i < 5; i++) plugin.setup(api as Any);

    // Each reload must release the previous registrations.
    expect(liveHookCount(api)).toBe(afterFirst);
    plugin.teardown?.(api as Any);
  });

  it('releases every hook on teardown', async () => {
    const api = makeApi({ 'token-budget': { limit: 1000 } });
    plugin.setup(api as Any);
    plugin.teardown?.(api as Any);
    expect(liveHookCount(api)).toBe(0);
  });

  it('survives a setup/teardown/setup cycle', async () => {
    const api = makeApi({ 'token-budget': { limit: 1000 } });
    plugin.setup(api as Any);
    plugin.teardown?.(api as Any);
    plugin.setup(api as Any);
    const status = await tool(api, 'token_budget_status').execute({});
    expect(status.limit).toBe(1000);
    plugin.teardown?.(api as Any);
  });
});

describe('config bounds', () => {
  async function limitFor(extensions: Record<string, unknown>): Promise<Any> {
    const api = makeApi({ 'token-budget': extensions });
    plugin.setup(api as Any);
    const status = await tool(api, 'token_budget_status').execute({});
    plugin.teardown?.(api as Any);
    return status;
  }

  it('rejects NaN rather than letting it disable enforcement', async () => {
    const status = await limitFor({ limit: Number.NaN });
    expect(Number.isNaN(status.limit)).toBe(false);
    expect(status.limit).toBe(0);
  });

  it('rejects Infinity', async () => {
    expect((await limitFor({ limit: Number.POSITIVE_INFINITY })).limit).toBe(0);
  });

  it('rejects a negative limit', async () => {
    expect((await limitFor({ limit: -5000 })).limit).toBe(0);
  });

  it('rejects an out-of-range warnPercent', async () => {
    const status = await limitFor({ limit: 1000, warnPercent: 500 });
    expect(status.warnPercent).toBe(80);
  });

  it('rejects a zero/negative warnPercent', async () => {
    expect((await limitFor({ limit: 1000, warnPercent: 0 })).warnPercent).toBe(80);
    expect((await limitFor({ limit: 1000, warnPercent: -10 })).warnPercent).toBe(80);
  });

  it('never leaves warnPercent above stopPercent', async () => {
    // A warn threshold above the stop threshold can never fire.
    const status = await limitFor({ limit: 1000, warnPercent: 90, stopPercent: 50 });
    expect(status.stopPercent).toBeGreaterThanOrEqual(status.warnPercent);
  });

  it('keeps a valid configuration untouched', async () => {
    const status = await limitFor({ limit: 250_000, warnPercent: 70, stopPercent: 95 });
    expect(status.limit).toBe(250_000);
    expect(status.warnPercent).toBe(70);
    expect(status.stopPercent).toBe(95);
  });
});
