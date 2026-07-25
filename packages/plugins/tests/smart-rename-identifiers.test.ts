/**
 * @wrongstack/plugins — smart-rename identifier handling.
 *
 * Two defects in a mutating tool:
 *
 *  1. Matching used `\b`, which is defined against `[A-Za-z0-9_]` and does
 *     NOT include `$`. For a `$`-prefixed identifier the leading `\b`
 *     required a word character immediately before the `$`, which almost
 *     never holds — so the rename matched nothing and the tool reported
 *     success with zero replacements. A silent no-op on a write operation.
 *  2. `newName` was substituted into source without being checked as an
 *     identifier, so a "rename" could splice arbitrary statements into the
 *     file.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const plugin = (await import('../src/smart-rename/index.js')).default;

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
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smart-rename-'));
  process.chdir(tmpDir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function rename(source: string, oldName: string, newName: string): Promise<Any> {
  await fs.writeFile(path.join(tmpDir, 'src.ts'), source, 'utf8');
  const api = makeApi({ 'smart-rename': { enabled: true } });
  plugin.setup(api as Any);
  const res = await tool(api, 'smart_rename').execute({
    path: 'src.ts',
    oldName,
    newName,
  });
  plugin.teardown?.(api as Any);
  return res;
}

describe('identifiers containing $ and _', () => {
  it('renames a $-prefixed identifier', async () => {
    const res = await rename('const $foo = 1;\nuse($foo);\n', '$foo', '$bar');
    expect(res.ok).toBe(true);
    expect(res.replacements).toBe(2);
    expect(res.preview).toBe('const $bar = 1;\nuse($bar);\n');
  });

  it('renames a lone $', async () => {
    const res = await rename('$(sel).on("x");\n', '$', 'jQuery');
    expect(res.replacements).toBe(1);
    expect(res.preview).toBe('jQuery(sel).on("x");\n');
  });

  it('renames an _-prefixed identifier', async () => {
    const res = await rename('const _priv = 1;\nlog(_priv);\n', '_priv', '_next');
    expect(res.replacements).toBe(2);
  });

  it('does not match a longer identifier that merely contains the name', async () => {
    const res = await rename('const foo = 1;\nconst foobar = 2;\nconst $foo = 3;\n', 'foo', 'baz');
    // `foobar` and `$foo` must be left alone.
    expect(res.replacements).toBe(1);
    expect(res.preview).toContain('const baz = 1;');
    expect(res.preview).toContain('const foobar = 2;');
    expect(res.preview).toContain('const $foo = 3;');
  });

  it('does not match a name preceded by $ or _', async () => {
    const res = await rename('const _foo = 1;\nconst foo = 2;\n', 'foo', 'baz');
    expect(res.replacements).toBe(1);
    expect(res.preview).toContain('const _foo = 1;');
  });

  it('still renames a plain identifier at line start and end', async () => {
    const res = await rename('foo\nbar(foo)\nfoo', 'foo', 'qux');
    expect(res.replacements).toBe(3);
  });
});

describe('input validation', () => {
  it.each([
    ['a statement', 'evil(); drop()'],
    ['a name starting with a digit', '1bad'],
    ['a name with a space', 'two words'],
    ['a name with a dot', 'obj.prop'],
    ['a name with a hyphen', 'kebab-case'],
  ])('rejects %s as newName', async (_label, badName) => {
    const res = await rename('const foo = 1;\n', 'foo', badName);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('not a valid identifier');
  });

  it('rejects a non-identifier oldName', async () => {
    const res = await rename('const foo = 1;\n', 'foo(', 'bar');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('not a valid identifier');
  });

  it('leaves the file untouched when validation fails', async () => {
    const source = 'const foo = 1;\n';
    await rename(source, 'foo', 'evil(); drop()');
    expect(await fs.readFile(path.join(tmpDir, 'src.ts'), 'utf8')).toBe(source);
  });
});
