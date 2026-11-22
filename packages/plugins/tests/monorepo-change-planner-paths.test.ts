import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { PluginAPI, Tool } from '@wrongstack/contracts/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import monorepoChangePlanner from '../src/monorepo-change-planner/index.js';

let root: string;
let api: PluginAPI;
const tools = new Map<string, Tool>();

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wrongstack-monorepo-paths-'));
  tools.clear();
  api = {
    config: { extensions: {} },
    log: { info() {}, warn() {}, error() {} },
    tools: { register: (tool: Tool) => tools.set(tool.name, tool) },
  } as unknown as PluginAPI;
  monorepoChangePlanner.setup(api);
});
afterEach(async () => {
  await monorepoChangePlanner.teardown?.(api);
  await rm(root, { recursive: true, force: true });
});

async function file(path: string, value: unknown) {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(value));
}
function plan(manifests: string[], changedFiles: string[]) {
  return tools
    .get('monorepo_change_plan')!
    .execute({ manifests, changedFiles }, { projectRoot: root, cwd: root } as never, {
      signal: new AbortController().signal,
    });
}

// F1117: changed files had a leading `./` stripped but manifest directories
// did not, so a `./`-spelled manifest never owned any change.
describe('monorepo-change-planner path spellings', () => {
  beforeEach(async () => {
    await file('packages/a/package.json', { name: 'a' });
    await file('packages/b/package.json', { name: 'b', dependencies: { a: 'workspace:*' } });
  });

  it('attributes changes to a ./-prefixed manifest directory', async () => {
    expect(
      await plan(['./packages/a/package.json', './packages/b/package.json'], ['packages/a/x.ts']),
    ).toMatchObject({
      directlyChanged: ['a'],
      affected: ['a', 'b'],
      unknownChanges: [],
      validationOrder: [{ name: 'a', cwd: 'packages/a' }, { name: 'b' }],
    });
  });

  it('matches whichever side carries the ./ prefix', async () => {
    expect(
      await plan(['./packages/a/package.json', 'packages/b/package.json'], ['./packages/a/y.ts']),
    ).toMatchObject({ directlyChanged: ['a'], affected: ['a', 'b'], unknownChanges: [] });
  });

  it('keeps a ./package.json root manifest owning every change', async () => {
    await file('package.json', { name: 'root' });
    expect(await plan(['./package.json'], ['tools/z.ts'])).toMatchObject({
      directlyChanged: ['root'],
      unknownChanges: [],
    });
  });
});
