/**
 * @wrongstack/plugins — auto-doc per-file write condition.
 *
 * The write guard tested `results.length > 0`, but `results` accumulates
 * across every file in the batch. So as soon as ONE file gained a doc
 * comment, every subsequent file in the same call was written back —
 * byte-identical, but with a fresh mtime. That wakes file watchers,
 * triggers rebuilds, and re-fires other plugins' PostToolUse hooks on
 * files that were never actually touched.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const plugin = (await import('../src/auto-doc/index.js')).default;

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
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-doc-multifile-'));
  process.chdir(tmpDir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** A file with an undocumented export — auto-doc will add a comment. */
const NEEDS_DOCS = 'export function needsDocs(a: number): number {\n  return a + 1;\n}\n';

/** A file auto-doc has nothing to add to. */
const NOTHING_TO_DO = 'const x = 1;\nconsole.log(x);\n';

describe('auto-doc write condition is per-file', () => {
  it('leaves an untouched file byte-identical and with its mtime intact', async () => {
    const documented = path.join(tmpDir, 'a.ts');
    const untouched = path.join(tmpDir, 'b.ts');
    await fs.writeFile(documented, NEEDS_DOCS, 'utf8');
    await fs.writeFile(untouched, NOTHING_TO_DO, 'utf8');

    const before = await fs.stat(untouched);
    // Make any rewrite observable in the mtime.
    await new Promise((r) => setTimeout(r, 20));

    const api = makeApi({ 'auto-doc': { enabled: true } });
    await plugin.setup(api as Any);
    // Order matters: the file that DOES gain a doc comment comes first, so
    // the shared accumulator is non-empty by the time the second is reached.
    await tool(api, 'auto_doc').execute({ files: ['a.ts', 'b.ts'] });

    const after = await fs.stat(untouched);
    expect(await fs.readFile(untouched, 'utf8')).toBe(NOTHING_TO_DO);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    plugin.teardown?.(api as Any);
  });

  it('still writes the file that did gain documentation', async () => {
    const documented = path.join(tmpDir, 'a.ts');
    await fs.writeFile(documented, NEEDS_DOCS, 'utf8');

    const api = makeApi({ 'auto-doc': { enabled: true } });
    await plugin.setup(api as Any);
    const res = await tool(api, 'auto_doc').execute({ files: ['a.ts'] });

    expect(res.ok).toBe(true);
    const content = await fs.readFile(documented, 'utf8');
    expect(content).not.toBe(NEEDS_DOCS);
    expect(content).toContain('/**');
    plugin.teardown?.(api as Any);
  });

  it('writes nothing at all in dry_run', async () => {
    const documented = path.join(tmpDir, 'a.ts');
    await fs.writeFile(documented, NEEDS_DOCS, 'utf8');

    const api = makeApi({ 'auto-doc': { enabled: true } });
    await plugin.setup(api as Any);
    await tool(api, 'auto_doc').execute({ files: ['a.ts'], dry_run: true });

    expect(await fs.readFile(documented, 'utf8')).toBe(NEEDS_DOCS);
    plugin.teardown?.(api as Any);
  });
});
