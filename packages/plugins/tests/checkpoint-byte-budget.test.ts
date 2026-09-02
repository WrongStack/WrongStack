/**
 * @wrongstack/plugins — checkpoint retained-bytes budget.
 *
 * `maxSnapshots` bounds how MANY snapshots are kept, not how much memory
 * they occupy. One snapshot holds every file a single write touched, each
 * up to `maxFileBytes` (1 MiB by default), and auto-capture fires on every
 * write — so the count-based ring alone allowed tens to hundreds of MiB to
 * accumulate for the life of the session.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const plugin = (await import('../src/checkpoint/index.js')).default;

interface RegisteredTool {
  name: string;
  execute(input: unknown, ctx?: unknown): Promise<Any>;
}

function makeApi(extensions: Record<string, unknown> = {}) {
  const tools: RegisteredTool[] = [];
  const hooks: Array<{ event: string; hook: (i: Any, r?: Any) => Any }> = [];
  return {
    tools: { register: (t: RegisteredTool) => tools.push(t), list: () => tools },
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
    _tools: tools,
    _hooks: hooks,
  };
}

function tool(api: Any, name: string): RegisteredTool {
  const t = (api._tools as RegisteredTool[]).find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not registered`);
  return t;
}

let tmpDir: string;
let originalCwd: string;

beforeEach(async () => {
  originalCwd = process.cwd();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'checkpoint-budget-'));
  process.chdir(tmpDir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** Capture `count` files of ~`sizeKb` KiB each, one snapshot per file. */
async function captureMany(api: Any, count: number, sizeKb: number): Promise<void> {
  const create = tool(api, 'checkpoint_create');
  for (let i = 0; i < count; i++) {
    const p = path.join(tmpDir, `f${i}.txt`);
    await fs.writeFile(p, 'x'.repeat(sizeKb * 1024), 'utf8');
    await create.execute({ paths: [`f${i}.txt`] });
  }
}

describe('retained-bytes budget', () => {
  it('drops old snapshots once the byte budget is exceeded', async () => {
    // 20 snapshots x 64 KiB = 1.25 MiB of content, against a 256 KiB budget.
    const api = makeApi({
      checkpoint: { enabled: true, autoCapture: false, maxSnapshots: 500, maxTotalBytes: 262_144 },
    });
    await plugin.setup(api as Any);
    await captureMany(api, 20, 64);

    const status = await tool(api, 'checkpoint_list').execute({});
    expect(status.counters.retainedBytes).toBeLessThanOrEqual(262_144);
    expect(status.counters.evictedForBytes).toBeGreaterThan(0);
    plugin.teardown?.(api as Any);
  });

  it('always keeps the newest snapshot, even if it alone exceeds the budget', async () => {
    // A restore has to remain possible: dropping everything would make the
    // plugin useless exactly when a large file was just edited.
    const api = makeApi({
      checkpoint: {
        enabled: true,
        autoCapture: false,
        maxSnapshots: 500,
        maxTotalBytes: 1024,
        maxFileBytes: 10 * 1_048_576,
      },
    });
    await plugin.setup(api as Any);
    await captureMany(api, 3, 64);

    const status = await tool(api, 'checkpoint_list').execute({});
    expect(status.snapshots.length).toBe(1);
    plugin.teardown?.(api as Any);
  });

  it('leaves everything in place when the budget is not reached', async () => {
    const api = makeApi({
      checkpoint: {
        enabled: true,
        autoCapture: false,
        maxSnapshots: 500,
        maxTotalBytes: 8_388_608,
      },
    });
    await plugin.setup(api as Any);
    await captureMany(api, 5, 4);

    const status = await tool(api, 'checkpoint_list').execute({});
    expect(status.snapshots.length).toBe(5);
    expect(status.counters.evictedForBytes).toBe(0);
    plugin.teardown?.(api as Any);
  });

  it('still honours the snapshot-count ring independently', async () => {
    const api = makeApi({
      checkpoint: { enabled: true, autoCapture: false, maxSnapshots: 3, maxTotalBytes: 8_388_608 },
    });
    await plugin.setup(api as Any);
    await captureMany(api, 10, 1);

    const status = await tool(api, 'checkpoint_list').execute({});
    expect(status.snapshots.length).toBe(3);
    plugin.teardown?.(api as Any);
  });

  it('reports retained bytes so the budget is observable', async () => {
    const api = makeApi({ checkpoint: { enabled: true, autoCapture: false } });
    await plugin.setup(api as Any);
    await captureMany(api, 2, 8);

    const status = await tool(api, 'checkpoint_list').execute({});
    expect(status.counters.retainedBytes).toBeGreaterThan(0);
    plugin.teardown?.(api as Any);
  });
});
