/**
 * @wrongstack/plugins — dead-code-detector identifier boundaries.
 *
 * Usage matching used `\b`, which is defined against `[A-Za-z0-9_]` and
 * excludes `$`. A `$`-prefixed export therefore matched nowhere in any
 * other file and was reported as unused — a false "this is dead, delete
 * it" recommendation for code that is very much alive.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const plugin = (await import('../src/dead-code-detector/index.js')).default;

interface RegisteredTool {
  name: string;
  execute(input: unknown, ctx?: unknown): Promise<Any>;
}

function makeApi(extensions: Record<string, unknown> = {}) {
  const tools: RegisteredTool[] = [];
  return {
    tools: { register: (t: RegisteredTool) => tools.push(t), list: () => tools },
    slashCommands: { register() {} },
    config: { extensions },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    metrics: { counter() {}, histogram() {}, gauge() {} },
    session: { append: async () => {} },
    extensions: { register: () => ({ unregister() {} }) },
    registerSystemPromptContributor: () => () => {},
    registerHook: () => () => {},
    onEvent: () => () => {},
    onPattern: () => () => {},
    emitCustom() {},
    onConfigChange: () => () => {},
    _tools: tools,
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
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dead-code-dollar-'));
  process.chdir(tmpDir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** Write a src/ tree and return the reported unused identifiers. */
async function scanFor(files: Record<string, string>): Promise<string[]> {
  const src = path.join(tmpDir, 'src');
  await fs.mkdir(src, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(src, name), content, 'utf8');
  }
  const api = makeApi({ 'dead-code-detector': { enabled: true } });
  plugin.setup(api as Any);
  const res = await tool(api, 'dead_code_scan').execute({ path: 'src' });
  plugin.teardown?.(api as Any);
  return (res.findings ?? []).map((f: { identifier: string }) => f.identifier);
}

describe('$-prefixed exports are not falsely reported as dead', () => {
  it('sees a $-prefixed export used in another file', async () => {
    const unused = await scanFor({
      'store.ts': 'export const $state = { v: 1 };\n',
      'consumer.ts': "import { $state } from './store.js';\nconsole.log($state.v);\n",
    });
    expect(unused).not.toContain('$state');
  });

  it('sees a $-suffixed observable-style export used elsewhere', async () => {
    const unused = await scanFor({
      'streams.ts': 'export const clicks$ = makeStream();\n',
      'app.ts': "import { clicks$ } from './streams.js';\nclicks$.subscribe();\n",
    });
    expect(unused).not.toContain('clicks$');
  });

  it('still reports a genuinely unused $-prefixed export', async () => {
    // The fix must not make everything look used.
    const unused = await scanFor({
      'store.ts': 'export const $orphan = 1;\n',
      'other.ts': 'export const something = 2;\nconsole.log(something);\n',
    });
    expect(unused).toContain('$orphan');
  });

  it('does not treat a longer identifier as a use of the shorter one', async () => {
    const unused = await scanFor({
      'a.ts': 'export const foo = 1;\n',
      'b.ts': 'const foobar = 2;\nconsole.log(foobar);\n',
    });
    expect(unused).toContain('foo');
  });

  it('does not treat $foo as a use of foo', async () => {
    const unused = await scanFor({
      'a.ts': 'export const foo = 1;\n',
      'b.ts': 'const $foo = 2;\nconsole.log($foo);\n',
    });
    expect(unused).toContain('foo');
  });

  it('still sees a plain identifier used elsewhere', async () => {
    const unused = await scanFor({
      'a.ts': 'export const plain = 1;\n',
      'b.ts': "import { plain } from './a.js';\nconsole.log(plain);\n",
    });
    expect(unused).not.toContain('plain');
  });
});
