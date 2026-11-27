/**
 * type-gate in a TypeScript monorepo with a solution-style root tsconfig.
 *
 * `{"files": [], "references": [...]}` at the root is the standard layout
 * for project references (this repository uses it). `tsc --noEmit` against
 * that file type-checks nothing and exits 0, so the gate ran on every edit
 * and always reported "passed". The gate must check the package the edited
 * file belongs to, and say so when it cannot find one instead of passing.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cp = vi.hoisted(() => ({ execFile: vi.fn(), calls: [] as string[][] }));
vi.mock('node:child_process', () => ({ execFile: cp.execFile }));

const typeGatePlugin = (await import('../src/type-gate/index.js')).default;

let root = '';

function makeApi() {
  return {
    tools: { register: vi.fn() },
    config: { extensions: {} },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    registerHook: vi.fn(() => vi.fn()),
  };
}

async function edit(api: ReturnType<typeof makeApi>, path: string) {
  const hook = (api.registerHook.mock.calls[0] as unknown[])[2] as (i: unknown) => Promise<unknown>;
  return hook({
    toolName: 'write',
    toolInput: { path },
    toolResult: { content: '', isError: false },
  });
}

beforeEach(async () => {
  cp.calls.length = 0;
  root = await mkdtemp(join(tmpdir(), 'type-gate-solution-'));
  await writeFile(
    join(root, 'tsconfig.json'),
    '// solution root\n{ "files": [], "references": [{ "path": "./packages/a" }] }\n',
  );
  await mkdir(join(root, 'packages/a/src'), { recursive: true });
  await writeFile(join(root, 'packages/a/tsconfig.json'), '{ "include": ["src"] }\n');
  await mkdir(join(root, 'scripts'), { recursive: true });
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  cp.execFile.mockImplementation(
    (bin: string, args: string[], _options: unknown, callback: (e: Error | null) => void) => {
      cp.calls.push([bin, ...args]);
      const child = { stdout: { on() {} }, stderr: { on() {} }, on: () => child };
      queueMicrotask(() => callback(null));
      return child;
    },
  );
});

afterEach(async () => {
  await typeGatePlugin.teardown?.(makeApi() as never);
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe('type-gate with a solution-style root tsconfig', () => {
  it('type-checks the package tsconfig nearest to the edited file', async () => {
    const api = makeApi();
    typeGatePlugin.setup(api as never);
    await edit(api, 'packages/a/src/index.ts');
    expect(cp.calls).toHaveLength(1);
    const argv = cp.calls[0]!.join(' ').replaceAll('\\', '/');
    expect(argv).toMatch(/"?-p"? "?packages\/a\/tsconfig\.json/);
  });

  it('does not report a pass when no checkable tsconfig covers the file', async () => {
    const api = makeApi();
    typeGatePlugin.setup(api as never);
    await edit(api, 'scripts/build.ts');
    await edit(api, 'scripts/other.ts');
    expect(cp.calls).toHaveLength(0);
    expect(api.log.warn).toHaveBeenCalledTimes(1);
    expect(String(api.log.warn.mock.calls[0]![0])).toMatch(/solution-style/);
    const status = api.tools.register.mock.calls[0]![0] as { execute: () => Promise<unknown> };
    expect(await status.execute()).toMatchObject({
      lastSkipReason: expect.stringMatching(/solution-style/),
    });
  });
});

describe('type-gate on a test file', () => {
  it('uses the sibling tsconfig.test.json that actually covers tests', async () => {
    await mkdir(join(root, 'packages/a/tests'), { recursive: true });
    await writeFile(
      join(root, 'packages/a/tsconfig.test.json'),
      '{ "include": ["src", "tests"] }\n',
    );
    const api = makeApi();
    typeGatePlugin.setup(api as never);
    await edit(api, 'packages/a/tests/index.test.ts');
    expect(cp.calls).toHaveLength(1);
    expect(cp.calls[0]!.join(' ').replaceAll('\\', '/')).toMatch(
      /"?packages\/a\/tsconfig\.test\.json/,
    );
  });
});
